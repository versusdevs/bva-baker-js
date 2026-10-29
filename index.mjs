#!/usr/bin/env node
/**
 * Baked Vector Animation (BVA) baker.
 *
 *   node scripts/bva/index.mjs <config.json> [<config2.json> ...]
 *
 * Each config bakes one rig. The output layout is:
 *
 *     <output>/
 *       <name>.bva              # compact text motion stream
 *       assets/
 *         <name>.svg.json       # one layer file: skins._common + skin diffs
 *         <name>.rasters/       # WebP of each part at screen-density 1x/2x/3x
 *
 * The `.bva` and `.svg.json` files are loaded at runtime by
 * `BakedVectorPlayer` in `bva-player-react`.
 *
 * Paths in each config (`input`, `output`, `assets[].dir`) are resolved
 * relative to `process.cwd()` so the baker can be invoked from any project.
 *
 * --- Config schema ---
 *
 * {
 *   "name":   "character",                     // rig label, used for .bva / layer filename
 *   "input":  "public/.../animation.json",     // Lottie source
 *   "output": "public/.../bva/character",      // output directory
 *   "fps":    24,                              // optional, default 24
 *
 *   // Optional: matrix decimals in the .bva stream (default 3). Rigs whose
 *   // parts are large (stroke-mesh props) read fine at 1 and shrink a lot.
 *   "decimals": 1,
 *
 *   // Optional: rename an image part. Keys are Lottie image basenames
 *   // (no extension), values the part name skins must use.
 *   "imageParts": { "Prop Frame": "Frame" },
 *
 *   // Optional: rename top-level Lottie layers to compact segment keys.
 *   // Map a layer to null to skip it. If omitted, sanitised names are used.
 *   "segments": {
 *     "Character_Idle":       "idle",
 *     "Character_Jump Left":  "jump_left",
 *     ...
 *   },
 *
 *   // Optional: alias segment names onto baked ones (additive #aliases header).
 *   "segmentAliases": { "hit": "jump_right" },
 *
 *   // Optional: derive extra segments after bake. `left` and `right` are
 *   // required. `averageBlend` is a per-part matrix mean (centre shot from
 *   // mirrored side clips); `mirrorBlend` is the net-string variant.
 *   "synthesizeSegments": {
 *     "jump_center": { "mode": "mirrorBlend", "left": "jump_left", "right": "jump_right" },
 *     "middle_goal": { "mode": "averageBlend", "left": "left_goal", "right": "right_goal" }
 *   },
 *
 *   // Optional: stroke-mesh bake options (two-vertex stroke path layers).
 *   //   minMotionPx      strings moving less than this fold into a static
 *   //                    plate instead of getting a matrix stream (0.25)
 *   //   curveTolerancePx max chord-to-curve error before a bowing string is
 *   //                    split into more chord pieces (1.5)
 *   //   curveSegments    hard cap on chord pieces per string (6)
 *   "strokes": { "minMotionPx": 0.25, "curveTolerancePx": 1.5, "curveSegments": 6 },
 *
 *   // Optional: bake folders of SVGs into one layer JSON. Each entry
 *   // discovers subfolders under `dir`; folders become named skins and
 *   // shared geometry is auto-diffed into skins._common.
 *   "assets": [
 *     {
 *       "dir":     "public/.../Skins",
 *       "pattern": "Skin_*",        // optional glob/regex; default = all subdirs
 *       "include": ["*.svg"]        // optional; default = "*.svg"
 *     }
 *   ],
 *
 *   // Optional: empty named skins when artwork lives outside the layer
 *   // (e.g. a prop frame drawn as a static scene image). Ensures skin ids
 *   // resolve even when `assets` is omitted and only synthesized net parts
 *   // fill `_common`.
 *   "skinStubs": ["Frame_Day", "Frame_Night"],
 *
 *   // Optional: raster bitmaps of each resolved part. Default is 1x/2x/3x
 *   // screen-density WebP (posed CSS size at field 1:1) under
 *   // assets/<name>.rasters/. Set false to skip. SVG in the layer file is
 *   // unchanged — the bitmaps are a sidecar for later.
 *   "raster": { "scales": [1, 2, 3] }
 * }
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { bakeMotion } from './lib/bake-motion.mjs';
import { bakeRasters } from './lib/bake-raster.mjs';
import { NET_COLOR_VAR } from './lib/bake-strokes.mjs';
import { bakeSkins } from './lib/bake-skins.mjs';
import { encodeMotionText } from './lib/motion-text.mjs';

const ROOT = process.cwd();
const DEFAULT_NET_COLOR = '#F4F7F5';

/**
 * Entries in `synthesizedParts` that carry a `.part` SVG descriptor
 * (Shadow, Net_String, Net_Static, …). Baker-internal keys like
 * `_strokeMoverKeys` are ignored.
 */
function synthesizedPartEntries(synthesizedParts) {
  if (!synthesizedParts) return [];
  return Object.entries(synthesizedParts).filter(
    ([name, entry]) => !name.startsWith('_') && entry?.part,
  );
}

function partAlreadyInLayer(skins, assetName) {
  if (skins._common?.[assetName]) return true;
  for (const [skinName, parts] of Object.entries(skins)) {
    if (skinName === '_common') continue;
    if (parts && parts[assetName]) return true;
  }
  return false;
}

/**
 * Ensure synthesized artwork (Shadow, Net_String, Net_Static, …) is present
 * in the layer bundle. Hand-authored SVGs of the same part name win.
 */
function injectSynthesizedParts(layer, synthesizedParts) {
  const entries = synthesizedPartEntries(synthesizedParts);
  if (entries.length === 0) return layer;

  const skins = layer.skins ?? (layer.skins = {});
  const common = skins._common ?? (skins._common = {});
  const defaults = layer.defaults ?? {};

  for (const [assetName, entry] of entries) {
    if (partAlreadyInLayer(skins, assetName)) continue;
    const part = entry.part;
    const matchesDefaults =
      part.viewBox === defaults.viewBox &&
      part.width === defaults.width &&
      part.height === defaults.height;
    common[assetName] = matchesDefaults
      ? { body: part.body }
      : {
          viewBox: part.viewBox,
          width: part.width,
          height: part.height,
          body: part.body,
        };
  }

  // Net artwork references $net_color — seed a default if the layer has none.
  // Scan the bodies rather than probing names: nets split into per-layer
  // plates (Net_Static_2, …) when half the net is mirrored.
  const hasNet = entries.some(([, entry]) =>
    JSON.stringify(entry.part.body).includes(NET_COLOR_VAR),
  );
  if (hasNet) {
    const variables = layer.variables ?? (layer.variables = {});
    if (variables.net_color == null) {
      variables.net_color = synthesizedParts._netColor ?? DEFAULT_NET_COLOR;
    }
  }
  return layer;
}

function minimalLayerFromSynthesized(name, synthesizedParts) {
  const entries = synthesizedPartEntries(synthesizedParts);
  if (entries.length === 0) return null;

  // Prefer a part with a real viewBox for defaults; fall back to the first.
  const preferred =
    entries.find(([, e]) => e.part.viewBox && e.part.width > 1)?.[1] ??
    entries[0][1];
  const part = preferred.part;
  const common = {};
  for (const [assetName, entry] of entries) {
    const p = entry.part;
    const matchesDefaults =
      p.viewBox === part.viewBox &&
      p.width === part.width &&
      p.height === part.height;
    common[assetName] = matchesDefaults
      ? { body: p.body }
      : {
          viewBox: p.viewBox,
          width: p.width,
          height: p.height,
          body: p.body,
        };
  }
  return {
    name,
    defaults: {
      viewBox: part.viewBox,
      width: part.width,
      height: part.height,
    },
    variables: {
      net_color: synthesizedParts._netColor ?? DEFAULT_NET_COLOR,
    },
    skins: {
      _common: common,
      Default: {},
    },
  };
}

async function processConfig(configPath) {
  const cfg = JSON.parse(await fs.readFile(configPath, 'utf8'));
  const label = cfg.name || path.basename(configPath, '.json');
  const outputDir = path.resolve(ROOT, cfg.output);
  const assetsDir = path.join(outputDir, 'assets');
  await fs.mkdir(outputDir, { recursive: true });
  await fs.mkdir(assetsDir, { recursive: true });

  console.log(`\n[${label}] Baking motion from ${cfg.input}`);
  const { motion, synthesizedParts } = await bakeMotion(cfg, ROOT);
  const bvaPath = path.join(outputDir, `${label}.bva`);
  const bvaPayload = encodeMotionText(
    motion,
    cfg.decimals != null ? { decimals: cfg.decimals } : undefined,
  );
  await fs.writeFile(bvaPath, bvaPayload);
  const bvaBytes = Buffer.byteLength(bvaPayload);

  console.log(
    `[${label}]   ${path.relative(ROOT, bvaPath)}  ${(bvaBytes / 1024).toFixed(1)} KiB`,
  );
  console.log(
    `[${label}]   fps: ${motion.fps} (resampled from ${motion.srcFps})`,
  );
  for (const [name, seg] of Object.entries(motion.segments)) {
    console.log(
      `[${label}]   - ${name.padEnd(14)} frames=${seg.frames}  parts=${seg.parts.length}`,
    );
  }

  let layer = null;
  if (cfg.assets) {
    console.log(`[${label}] Baking layer skins`);
    layer = await bakeSkins(cfg, ROOT);
  }
  if (layer) {
    injectSynthesizedParts(layer, synthesizedParts);
  } else {
    layer = minimalLayerFromSynthesized(label, synthesizedParts);
  }
  applySkinStubs(layer, cfg.skinStubs);

  if (layer) {
    if (cfg.raster !== false) {
      const rasterOpts = cfg.raster && typeof cfg.raster === 'object' ? cfg.raster : {};
      console.log(`[${label}] Baking part rasters`);
      const rasters = await bakeRasters(layer, assetsDir, {
        ...rasterOpts,
        motion,
      });
      layer.rasters = {
        format: rasters.format,
        scales: rasters.scales,
        dir: rasters.dir,
        units: rasters.units,
        parts: rasters.parts,
      };
      console.log(
        `[${label}]   assets/${rasters.dir}/  ${rasters.files} webps  ` +
          `${(rasters.bytes / 1024).toFixed(1)} KiB`,
      );
    }

    const filename = `${layer.name}.svg.json`;
    const out = path.join(assetsDir, filename);
    const payload = JSON.stringify(layer);
    await fs.writeFile(out, payload);
    const bytes = Buffer.byteLength(payload);
    const skinNames = Object.keys(layer.skins).filter((k) => k !== '_common');
    const commonParts = Object.keys(layer.skins._common ?? {}).length;
    console.log(
      `[${label}]   assets/${filename}  ${(bytes / 1024).toFixed(1)} KiB` +
        `  commonParts=${commonParts}  skins=${skinNames.length}`,
    );
  }
}

/**
 * Ensure empty named skins exist for ids that resolve at play time even
 * when their artwork is supplied outside the layer bundle.
 */
function applySkinStubs(layer, skinStubs) {
  if (!layer || !Array.isArray(skinStubs) || skinStubs.length === 0) return;
  const skins = layer.skins ?? (layer.skins = { _common: {} });
  // Synthesized-only layers start with a placeholder `Default` skin.
  // Replace it once real stub ids are provided.
  if (skins.Default && Object.keys(skins.Default).length === 0) {
    delete skins.Default;
  }
  for (const name of skinStubs) {
    if (!name || name === '_common') continue;
    if (!skins[name]) skins[name] = {};
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error(
      'Usage: bva-bake <config.json> [<config2.json> ...]',
    );
    process.exit(1);
  }
  for (const arg of args) {
    await processConfig(path.resolve(process.cwd(), arg));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
