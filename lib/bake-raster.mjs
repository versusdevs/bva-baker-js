/**
 * Rasterize resolved layer parts to lossless WebP at 1x / 2x / 3x.
 *
 * 1x / 2x / 3x are screen-density variants of the posed on-field CSS size
 * (stage × max part scale at field 1:1, dpr 1, placement 1) — not 1 / 2 / 3
 * pixels per viewBox unit. The player picks among them with
 * `fit × dpr × placement`.
 *
 * Skin folders often share a huge empty artboard (e.g. 2160×2160) with a
 * small painted region. Each WebP is cropped to opaque pixels. `x`/`y`/`w`/`h`
 * in the index stay in local viewBox units so a later player can place the
 * image. `units[part]` is 1x pixels per those local units.
 *
 * Identical resolved artwork is written once under `_common`; skins that
 * only overlay paint get their own files.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { Resvg } from '@resvg/resvg-js';
import sharp from 'sharp';

import { serializePartDocument, serializeSvgElements } from './svg-parse.mjs';

export const DEFAULT_RASTER_SCALES = [1, 2, 3];
export const RASTER_FORMAT = 'webp';

/**
 * 1x pixels per local viewBox unit for each motion part: the posed CSS size
 * at field 1:1 / dpr 1 / placement 1 (`stageScale × max part scale`).
 *
 * @param {{ stage?: number[], segments?: Record<string, { parts?: { asset: string, matrices?: number[][] }[] }> }} [motion]
 * @returns {Record<string, number>}
 */
export function motionPartUnits(motion) {
  if (!motion?.segments) return {};
  const stage = matrixScale(motion.stage);
  const stageScale = stage > 0 ? stage : 1;
  const partMax = {};
  for (const segment of Object.values(motion.segments)) {
    for (const part of segment.parts ?? []) {
      const name = part.asset;
      if (!name) continue;
      let max = partMax[name] ?? 0;
      for (const m of part.matrices ?? []) {
        const s = matrixScale(m);
        if (s > max) max = s;
      }
      partMax[name] = max;
    }
  }
  const out = {};
  for (const [name, s] of Object.entries(partMax)) {
    const unit = stageScale * (s > 0 ? s : 1);
    if (unit > 0) out[name] = fmtUnit(unit);
  }
  return out;
}

function matrixScale(m) {
  if (!m || m.length < 4) return 0;
  return Math.max(Math.hypot(m[0], m[1]), Math.hypot(m[2], m[3]));
}

function fmtUnit(n) {
  return Math.round(n * 1e6) / 1e6;
}

/**
 * Read just the stage + per-part matrices from a `.bva` so rasters can be
 * rebaked without going through the TypeScript player parser.
 *
 * @param {string} text
 */
export function motionFromBvaText(text) {
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  const motion = { stage: [1, 0, 0, 1, 0, 0], segments: { _: { parts: [] } } };
  const partsByName = new Map();
  let currentName = null;
  let prev = null;

  const partOf = (name) => {
    let p = partsByName.get(name);
    if (!p) {
      p = { asset: name, matrices: [] };
      partsByName.set(name, p);
      motion.segments._.parts.push(p);
    }
    return p;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('#')) {
      const tag = line.replace(/^#+/, '');
      if (tag === 'stage' && i + 1 < lines.length) {
        const cols = lines[++i].split(',').map(Number);
        if (cols.length >= 6) motion.stage = cols;
      } else if (tag.startsWith('#')) {
        // ####Part — handled below via startsWith check on full line
      }
      if (line.startsWith('####')) {
        currentName = line.slice(4);
        prev = null;
      }
      continue;
    }
    if (!currentName) continue;
    const part = partOf(currentName);
    if (line.startsWith('*')) {
      const n = parseInt(line.slice(1), 10);
      if (prev && n > 0) {
        for (let k = 0; k < n; k++) part.matrices.push(prev.slice());
      }
      continue;
    }
    if (line === '') {
      if (prev) part.matrices.push(prev.slice());
      continue;
    }
    const matrixLine = stripPaintSuffixes(line);
    const cols = matrixLine === '' ? [] : matrixLine.split(',');
    while (cols.length < 6) cols.push('');
    cols.reverse();
    const m = prev ? prev.slice() : [0, 0, 0, 0, 0, 0];
    for (let k = 0; k < 6; k++) {
      const c = cols[k];
      if (c === '') continue;
      if (c.charCodeAt(0) === 46 && c.charCodeAt(1) === 46) {
        m[k] = parseFloat(Math.trunc(m[k]) + '.' + c.slice(2));
      } else {
        m[k] = parseFloat(c);
      }
    }
    part.matrices.push(m);
    prev = m;
  }
  return motion;
}

function stripPaintSuffixes(line) {
  let s = line;
  const peel = (re) => {
    const m = s.match(re);
    if (!m) return;
    s = s.slice(0, m.index);
  };
  peel(/s[0-9A-Fa-f]{3,6}$/);
  peel(/f[0-9A-Fa-f]{3,6}$/);
  peel(/o-?(?:\.\d+|\d+(?:\.\d+)?)(?:\.\.\d+)?$/);
  return s;
}

function unitsForParts(motion, partNames) {
  const computed = motionPartUnits(motion);
  const known = Object.values(computed);
  const fallback = known.length > 0 ? Math.max(...known) : 1;
  const units = {};
  for (const name of partNames) {
    const u = computed[name];
    units[name] = u > 0 ? u : fmtUnit(fallback);
  }
  return units;
}

/**
 * @param {object} layer  assembled layer bundle (skins._common + named skins)
 * @param {string} assetsDir  `<output>/assets`
 * @param {{ scales?: number[], motion?: object }} [opts]
 * @returns {Promise<{ scales: number[], dir: string, parts: object, units: Record<string, number>, files: number, bytes: number }>}
 */
export async function bakeRasters(layer, assetsDir, opts = {}) {
  const scales = normalizeScales(opts.scales);
  const dirName = `${layer.name}.rasters`;
  const outDir = path.join(assetsDir, dirName);
  await fs.rm(outDir, { recursive: true, force: true });

  const defaults = layer.defaults ?? {};
  const variables = layer.variables ?? {};
  const skins = layer.skins ?? {};
  const common = skins._common ?? {};
  const skinNames = Object.keys(skins).filter((k) => k !== '_common');

  const partNames = [
    ...new Set([
      ...Object.keys(common),
      ...skinNames.flatMap((s) => Object.keys(skins[s] ?? {})),
    ]),
  ].sort();
  const units = unitsForParts(opts.motion, partNames);

  const parts = {};
  let files = 0;
  let bytes = 0;

  for (const partName of partNames) {
    const jobs = collectRasterJobs(
      partName,
      common[partName],
      skins,
      skinNames,
      defaults,
      variables,
    );
    if (jobs.length === 0) continue;

    const partIndex = {};
    const unitScale = units[partName] ?? 1;
    for (const job of jobs) {
      const result = await rasterizeResolvedPart(
        job.doc,
        job.strokePad,
        scales,
        unitScale,
      );
      if (!result) continue;
      const destDir = path.join(outDir, safeSeg(job.skin));
      await fs.mkdir(destDir, { recursive: true });
      for (const scale of scales) {
        const webp = result.webps[scale];
        const file = `${safeSeg(partName)}.${scale}x.webp`;
        await fs.writeFile(path.join(destDir, file), webp);
        files += 1;
        bytes += webp.byteLength;
      }
      partIndex[job.skin] = result.rect;
    }
    if (Object.keys(partIndex).length > 0) {
      parts[partName] = partIndex;
    }
  }

  return {
    format: RASTER_FORMAT,
    scales,
    dir: dirName,
    parts,
    units,
    files,
    bytes,
  };
}

function normalizeScales(scales) {
  const src = Array.isArray(scales) && scales.length > 0 ? scales : DEFAULT_RASTER_SCALES;
  const out = [
    ...new Set(
      src
        .map((n) => Number(n))
        .filter((n) => Number.isFinite(n) && n > 0)
        .map((n) => Math.round(n)),
    ),
  ].sort((a, b) => a - b);
  return out.length > 0 ? out : DEFAULT_RASTER_SCALES;
}

function safeSeg(name) {
  return String(name).replace(/[/\\]/g, '_').replace(/^\.+/, '_') || '_';
}

/**
 * One raster job per distinct resolved SVG. Shared artwork is `_common`;
 * skins whose overlay changes the markup get their own file.
 */
function collectRasterJobs(partName, commonPart, skins, skinNames, defaults, variables) {
  const commonMerged = mergePart(commonPart, undefined);
  const commonDoc = partHasInk(commonMerged, variables)
    ? serializePartDocument(commonMerged, defaults, variables)
    : null;

  const jobs = [];
  const unique = new Map();

  const addJob = (skin, merged, doc) => {
    unique.set(skin, {
      skin,
      doc,
      strokePad: maxStrokeWidth(merged.body) / 2,
    });
  };

  for (const skinName of skinNames) {
    const overlay = skins[skinName]?.[partName];
    if (!commonPart && !overlay) continue;
    const merged = mergePart(commonPart, overlay);
    if (!partHasInk(merged, variables)) continue;
    const doc = serializePartDocument(merged, defaults, variables);
    if (commonDoc && doc.svg === commonDoc.svg) {
      addJob('_common', commonMerged, commonDoc);
      continue;
    }
    addJob(skinName, merged, doc);
  }

  // Synthesized-only layers may have no named skins yet (stubs applied later),
  // or every named skin is an empty stub — still emit `_common`.
  if (unique.size === 0 && commonDoc) {
    addJob('_common', commonMerged, commonDoc);
  }

  for (const job of unique.values()) jobs.push(job);
  return jobs;
}

function partHasInk(part, variables) {
  if (!part) return false;
  return serializeSvgElements(part.body ?? [], variables).length > 0;
}

function mergePart(common, overlay) {
  return {
    viewBox: overlay?.viewBox ?? common?.viewBox,
    width: overlay?.width ?? common?.width,
    height: overlay?.height ?? common?.height,
    body: mergeBody(common?.body, overlay?.body),
  };
}

function mergeBody(commonBody, overlayBody) {
  const len = Math.max(commonBody?.length ?? 0, overlayBody?.length ?? 0);
  const out = [];
  for (let i = 0; i < len; i++) {
    const base = commonBody?.[i];
    const over = overlayBody?.[i];
    if (!base && !over) continue;
    const merged = { ...(base ?? {}), ...(over ?? {}) };
    if (merged._tag) out.push(merged);
  }
  return out;
}

function parseViewBox(vb) {
  const [x, y, w, h] = String(vb ?? '0 0 0 0')
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  return {
    x: Number.isFinite(x) ? x : 0,
    y: Number.isFinite(y) ? y : 0,
    w: Number.isFinite(w) ? w : 0,
    h: Number.isFinite(h) ? h : 0,
  };
}

function maxStrokeWidth(nodes) {
  let max = 0;
  for (const n of nodes ?? []) {
    const sw = Number(n['stroke-width']);
    if (Number.isFinite(sw) && sw > max) max = sw;
    if (n._children) max = Math.max(max, maxStrokeWidth(n._children));
  }
  return max;
}

function rewriteSvgViewBox(svg, viewBox, width, height) {
  return svg.replace(
    /<svg\b([^>]*)>/,
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="${viewBox}" width="${width}" height="${height}">`,
  );
}

function renderPng(svg) {
  const resvg = new Resvg(svg, {
    font: { loadSystemFonts: false },
  });
  return resvg.render();
}

function padCrop(bounds, width, height, pad = 1) {
  const x = Math.max(0, bounds.x - pad);
  const y = Math.max(0, bounds.y - pad);
  const x2 = Math.min(width, bounds.x + bounds.w + pad);
  const y2 = Math.min(height, bounds.y + bounds.h + pad);
  return { x, y, w: x2 - x, h: y2 - y };
}

function opaqueBounds(pixels, width, height) {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  const n = width * height;
  for (let i = 0; i < n; i++) {
    if (pixels[i * 4 + 3] === 0) continue;
    const x = i % width;
    const y = (i - x) / width;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

function fmtNum(n) {
  if (!Number.isFinite(n)) return '0';
  const r = Math.round(n * 1000) / 1000;
  return Object.is(r, -0) ? '0' : String(r);
}

/**
 * Probe at native SVG size for an accurate ink crop, then write each
 * screen-density of that crop (`local × unitScale × density`).
 * `unitScale` is 1x pixels per local viewBox unit (posed CSS size).
 * Returns `{ rect: {x,y,w,h}, webps: { 1: Buffer, 2: Buffer, … } }` or null.
 */
export async function rasterizeResolvedPart(doc, strokePad, scales, unitScale = 1) {
  const vb = parseViewBox(doc.viewBox);
  if (!(doc.width > 0) || !(doc.height > 0) || !(vb.w > 0) || !(vb.h > 0)) {
    return null;
  }

  // Pad the probe so strokes that sit on the viewBox edge are not clipped.
  // A 1×1 unit-line part (net strings) is otherwise an empty bitmap.
  const probePad = Math.max(strokePad || 0, vb.w < 4 || vb.h < 4 ? 1 : 0);
  const probeVb = {
    x: vb.x - probePad,
    y: vb.y - probePad,
    w: vb.w + probePad * 2,
    h: vb.h + probePad * 2,
  };
  const sx = doc.width / vb.w;
  const sy = doc.height / vb.h;
  const probeW = doc.width + probePad * 2 * sx;
  const probeH = doc.height + probePad * 2 * sy;
  const probeSvg = rewriteSvgViewBox(
    doc.svg,
    `${probeVb.x} ${probeVb.y} ${probeVb.w} ${probeVb.h}`,
    probeW,
    probeH,
  );

  const probe = renderPng(probeSvg);
  const ink = opaqueBounds(probe.pixels, probe.width, probe.height);
  if (!ink) return null;
  const cropPx = padCrop(ink, probe.width, probe.height);

  const local = {
    x: probeVb.x + (cropPx.x / probe.width) * probeVb.w,
    y: probeVb.y + (cropPx.y / probe.height) * probeVb.h,
    w: (cropPx.w / probe.width) * probeVb.w,
    h: (cropPx.h / probe.height) * probeVb.h,
  };

  const unit = unitScale > 0 ? unitScale : 1;
  const cropViewBox = `${local.x} ${local.y} ${local.w} ${local.h}`;
  const webps = {};
  for (const scale of scales) {
    const w = Math.max(1, Math.round(local.w * unit * scale));
    const h = Math.max(1, Math.round(local.h * unit * scale));
    const svg = rewriteSvgViewBox(doc.svg, cropViewBox, w, h);
    webps[scale] = await encodeWebp(renderPng(svg));
  }

  return {
    rect: {
      x: Number(fmtNum(local.x)),
      y: Number(fmtNum(local.y)),
      w: Number(fmtNum(local.w)),
      h: Number(fmtNum(local.h)),
    },
    webps,
  };
}

function encodeWebp(img) {
  return sharp(img.pixels, {
    raw: { width: img.width, height: img.height, channels: 4 },
  })
    .webp({ lossless: true })
    .toBuffer();
}
