/**
 * Folders of source SVGs -> one compact layer `.svg.json` file.
 *
 * A "layer" is one rig's artwork: shared geometry in `skins._common` plus
 * named visual variants under `skins.<name>` that only store attribute
 * diffs. Each input folder of `<part>.svg` files becomes one named skin;
 * the baker auto-diffs them so duplicated paths/attrs live once in
 * `_common`.
 *
 * The most common viewBox/width/height across all parts is hoisted into a
 * top-level `defaults` block. `variables` is emitted empty — post-bake
 * authoring rewrites selected attrs to `$var` and fills defaults.
 *
 * Element ids are namespaced per rig + part on the way in, since the runtime
 * mounts every rig into one document where ids are global.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { extractSvgInner } from './svg-parse.mjs';
import { naturalSort, makePatternMatcher, sanitizeName } from './naming.mjs';

/**
 * Discover skin folders under each `cfg.assets[*].dir` and merge them into
 * a single layer bundle `{ name, defaults, variables, skins }`.
 */
export async function bakeSkins(cfg, root) {
  if (!cfg.assets) return null;
  const assetsConfig = Array.isArray(cfg.assets) ? cfg.assets : [cfg.assets];
  const skinBundles = [];
  const rigName =
    cfg.name || path.basename(path.resolve(root, assetsConfig[0].dir));

  for (const ac of assetsConfig) {
    const dir = path.resolve(root, ac.dir);
    const matchDir = makePatternMatcher(ac.pattern);
    const includeFile = makePatternMatcher(ac.include?.[0] ?? '*.svg');

    const entries = await fs.readdir(dir, { withFileTypes: true });
    const bundleDirs = entries
      .filter((e) => e.isDirectory() && matchDir(e.name))
      .map((e) => e.name)
      .sort(naturalSort);

    if (bundleDirs.length === 0) {
      const files = (await fs.readdir(dir)).filter(includeFile);
      skinBundles.push(
        await readBundle(dir, files, path.basename(dir), rigName),
      );
      continue;
    }

    for (const name of bundleDirs) {
      // Optional `subdir` (e.g. "SVG") reads part files from a nested folder
      // while keeping the matched directory name as the skin id.
      const skinDir = ac.subdir
        ? path.join(dir, name, ac.subdir)
        : path.join(dir, name);
      const files = (await fs.readdir(skinDir)).filter(includeFile);
      skinBundles.push(await readBundle(skinDir, files, name, rigName));
    }
  }

  if (skinBundles.length === 0) return null;

  const layerName = cfg.name || skinBundles[0].name;
  return mergeSkinBundles(layerName, skinBundles);
}

async function readBundle(dir, files, name, rigName) {
  const rawParts = {};
  for (const f of files) {
    if (!f.endsWith('.svg')) continue;
    const partName = path.basename(f, '.svg');
    const raw = await fs.readFile(path.join(dir, f), 'utf8');
    const data = extractSvgInner(raw);
    if (!data) continue;
    namespaceIds(data.body, `${sanitizeName(rigName)}_${sanitizeName(partName)}`);
    rawParts[partName] = data;
  }

  const tally = new Map();
  for (const p of Object.values(rawParts)) {
    const key = `${p.viewBox}|${p.width}|${p.height}`;
    tally.set(key, (tally.get(key) ?? 0) + 1);
  }
  let bestKey = '';
  let bestCount = 0;
  for (const [k, c] of tally) {
    if (c > bestCount) {
      bestKey = k;
      bestCount = c;
    }
  }
  const [defViewBox, defW, defH] = bestKey.split('|');
  const defaults = {
    viewBox: defViewBox,
    width: Number(defW),
    height: Number(defH),
  };

  const parts = {};
  for (const [partName, p] of Object.entries(rawParts)) {
    const matches =
      p.viewBox === defaults.viewBox &&
      p.width === defaults.width &&
      p.height === defaults.height;
    parts[partName] = matches
      ? { body: p.body }
      : { viewBox: p.viewBox, width: p.width, height: p.height, body: p.body };
  }

  return { name, defaults, parts };
}

/**
 * Rewrite every `id` in one part's markup to `<prefix>_<id>`, along with the
 * `url(#…)` and `href="#…"` references that point at them.
 *
 * Player instances all render into the same document, where ids are global.
 * Source art routinely reuses generic names ("linear-gradient"), and SVGO
 * shortens them to single letters, so two rigs on one page would otherwise
 * fight over `#a` and paint each other's gradients.
 *
 * The prefix deliberately excludes the skin: part geometry is identical
 * across skins in the common case, and per-skin ids would defeat the
 * `_common` diffing. Gamefields mount several skins of one rig at once;
 * `resolveLayerBundle` re-scopes ids with the skin name at play time so
 * `url(#fan_body_mask)` cannot clip another skin's artwork.
 */
function namespaceIds(nodes, prefix) {
  const map = new Map();
  collectIds(nodes, map, prefix);
  if (map.size > 0) applyIdMap(nodes, map);
}

function collectIds(nodes, map, prefix) {
  for (const node of nodes) {
    if (typeof node.id === 'string' && node.id && !map.has(node.id)) {
      map.set(node.id, `${prefix}_${node.id}`);
    }
    if (node._children) collectIds(node._children, map, prefix);
  }
}

const URL_REF_RE = /url\(\s*(['"]?)#([^)'"\s]+)\1\s*\)/g;
const HREF_RE = /^#([^\s'"]+)$/;

function applyIdMap(nodes, map) {
  for (const node of nodes) {
    for (const [key, value] of Object.entries(node)) {
      if (key === '_tag' || key === '_children') continue;
      if (typeof value !== 'string') continue;
      if (key === 'id') {
        if (map.has(value)) node.id = map.get(value);
        continue;
      }
      node[key] = value
        .replace(URL_REF_RE, (m, q, id) =>
          map.has(id) ? `url(${q}#${map.get(id)}${q})` : m,
        )
        .replace(HREF_RE, (m, id) => (map.has(id) ? `#${map.get(id)}` : m));
    }
    if (node._children) applyIdMap(node._children, map);
  }
}

/**
 * Merge per-skin bundles into one layer object with `_common` + diffs.
 */
export function mergeSkinBundles(layerName, skinBundles) {
  const defaults = hoistDefaults(skinBundles);
  const skins = { _common: {} };

  const normalized = skinBundles.map((b) => ({
    name: b.name,
    parts: normalizePartsToDefaults(b.parts, defaults),
  }));

  for (const b of normalized) skins[b.name] = {};

  const allPartNames = new Set();
  for (const b of normalized) {
    for (const name of Object.keys(b.parts)) allPartNames.add(name);
  }

  for (const partName of [...allPartNames].sort(naturalSort)) {
    const present = normalized.filter((b) => b.parts[partName]);
    if (present.length === 0) continue;

    const inAll = present.length === normalized.length;
    if (!inAll) {
      for (const b of present) {
        skins[b.name][partName] = cloneJson(b.parts[partName]);
      }
      continue;
    }

    const { common, overlays } = diffPartAcrossSkins(
      present.map((b) => b.parts[partName]),
    );
    if (common && Object.keys(common).length > 0) {
      skins._common[partName] = common;
    }
    for (let i = 0; i < present.length; i++) {
      const overlay = overlays[i];
      if (overlay && Object.keys(overlay).length > 0) {
        skins[present[i].name][partName] = overlay;
      }
    }
  }

  return {
    name: layerName,
    defaults,
    variables: {},
    skins,
  };
}

function hoistDefaults(skinBundles) {
  const tally = new Map();
  for (const b of skinBundles) {
    for (const p of Object.values(b.parts)) {
      const vb = p.viewBox ?? b.defaults.viewBox;
      const w = p.width ?? b.defaults.width;
      const h = p.height ?? b.defaults.height;
      const key = `${vb}|${w}|${h}`;
      tally.set(key, (tally.get(key) ?? 0) + 1);
    }
  }
  let bestKey = '';
  let bestCount = 0;
  for (const [k, c] of tally) {
    if (c > bestCount) {
      bestKey = k;
      bestCount = c;
    }
  }
  if (!bestKey && skinBundles[0]) {
    return { ...skinBundles[0].defaults };
  }
  const [defViewBox, defW, defH] = bestKey.split('|');
  return {
    viewBox: defViewBox,
    width: Number(defW),
    height: Number(defH),
  };
}

function normalizePartsToDefaults(parts, defaults) {
  const out = {};
  for (const [name, p] of Object.entries(parts)) {
    const viewBox = p.viewBox ?? defaults.viewBox;
    const width = p.width ?? defaults.width;
    const height = p.height ?? defaults.height;
    const matches =
      viewBox === defaults.viewBox &&
      width === defaults.width &&
      height === defaults.height;
    out[name] = matches
      ? { body: cloneJson(p.body) }
      : { viewBox, width, height, body: cloneJson(p.body) };
  }
  return out;
}

/**
 * True when every skin's body has the same length and the same `_tag` at
 * each index. Themed prop skins often share one part name but hold totally
 * different SVG trees — index-diffing those would splice one theme's paths
 * into another's.
 */
function bodiesStructurallyCompatible(parts) {
  const bodies = parts.map((p) => p.body ?? []);
  const len = bodies[0]?.length ?? 0;
  if (!bodies.every((b) => b.length === len)) return false;
  for (let i = 0; i < len; i++) {
    const tag = bodies[0][i]?._tag;
    if (!bodies.every((b) => b[i]?._tag === tag)) return false;
  }
  return true;
}

/**
 * Diff the same part across all skins. Shared attrs go into `common`;
 * per-skin body overlays keep only differing keys at each body index.
 *
 * When body topologies differ (length / tags), each skin keeps its full
 * body and `_common` gets no body — only shared viewBox/size if identical.
 */
function diffPartAcrossSkins(parts) {
  const common = {};
  const overlays = parts.map(() => ({}));

  for (const k of ['viewBox', 'width', 'height']) {
    const vals = parts.map((p) => p[k]);
    if (vals.every((v) => v !== undefined) && vals.every((v) => sameJson(v, vals[0]))) {
      common[k] = cloneJson(vals[0]);
    } else {
      for (let s = 0; s < parts.length; s++) {
        if (parts[s][k] !== undefined) {
          overlays[s][k] = cloneJson(parts[s][k]);
        }
      }
    }
  }

  if (!bodiesStructurallyCompatible(parts)) {
    for (let s = 0; s < parts.length; s++) {
      overlays[s].body = cloneJson(parts[s].body ?? []);
    }
    return { common, overlays };
  }

  const maxBodyLen = Math.max(0, ...parts.map((p) => (p.body ?? []).length));
  const commonBody = [];
  const overlayBodies = parts.map(() => []);
  let commonBodyUsed = false;
  let overlayBodyUsed = parts.map(() => false);

  for (let i = 0; i < maxBodyLen; i++) {
    const els = parts.map((p) => (p.body ?? [])[i]);
    if (els.every((e) => e == null)) continue;

    if (els.every((e) => e != null) && els.every((e) => sameJson(e, els[0]))) {
      commonBody[i] = cloneJson(els[0]);
      commonBodyUsed = true;
      continue;
    }

    const keys = new Set();
    for (const e of els) {
      if (e) for (const key of Object.keys(e)) keys.add(key);
    }

    const commonEl = {};
    let hasCommon = false;
    for (const key of keys) {
      const vals = els.map((e) => (e == null ? undefined : e[key]));
      if (
        vals.every((v) => v !== undefined) &&
        vals.every((v) => sameJson(v, vals[0]))
      ) {
        commonEl[key] = cloneJson(vals[0]);
        hasCommon = true;
      } else {
        for (let s = 0; s < els.length; s++) {
          if (els[s] && els[s][key] !== undefined) {
            if (!overlayBodies[s][i]) overlayBodies[s][i] = {};
            overlayBodies[s][i][key] = cloneJson(els[s][key]);
            overlayBodyUsed[s] = true;
          }
        }
      }
    }

    if (hasCommon) {
      commonBody[i] = commonEl;
      commonBodyUsed = true;
    } else if (els.some((e) => e != null)) {
      // Keep an empty common slot so body indices stay aligned for overlays.
      commonBody[i] = {};
      commonBodyUsed = true;
    }
  }

  if (commonBodyUsed) {
    const len = commonBody.length;
    common.body = Array.from({ length: len }, (_, i) => commonBody[i] ?? {});
  }

  for (let s = 0; s < parts.length; s++) {
    if (!overlayBodyUsed[s]) continue;
    const ob = overlayBodies[s];
    let last = -1;
    for (let i = 0; i < ob.length; i++) {
      if (ob[i] && Object.keys(ob[i]).length > 0) last = i;
    }
    if (last < 0) continue;
    overlays[s].body = Array.from({ length: last + 1 }, (_, i) => ob[i] ?? {});
  }

  return { common, overlays };
}

function sameJson(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return a === b;
  return JSON.stringify(a) === JSON.stringify(b);
}

function cloneJson(v) {
  return v == null ? v : JSON.parse(JSON.stringify(v));
}
