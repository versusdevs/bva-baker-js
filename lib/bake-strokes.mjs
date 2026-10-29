/**
 * Bake Lottie stroke-mesh shape layers (a net, a web, a rope grid, …) into
 * BVA parts.
 *
 * A stroke mesh is hundreds of two-vertex stroke paths whose *vertices*
 * animate. BVA only ships per-frame matrices, so the trick is to pick a base
 * artwork that an affine matrix can carry exactly:
 *
 *   base = a unit horizontal line (0,0) -> (1,0)
 *   local(Q0, Q1) = [ chord | unit-normal | Q0 ]
 *
 *     a = u.x        c = -u.y / L      e = Q0.x
 *     b = u.y        d =  u.x / L      f = Q0.y     (u = Q1 - Q0, L = |u|)
 *
 * Column 1 is the chord, column 2 is the *unit* normal — deliberately
 * non-uniform. A stroke on a horizontal line only extends along Y, so the
 * rendered width stays exactly `stroke-width` for every string on every
 * frame while one shared artwork serves the whole mesh.
 *
 * Three artworks cover any number of strings:
 *
 *   Net_String       unit line; one motion part per moving string / chord
 *   Net_Static       strings that never move, merged into one <path>
 *   Net_Rest_Movers  the moving strings at rest, merged into one <path>,
 *                    used by segments where nothing moves (idle)
 *
 * Classification is rig-wide (see `planStrokeNets`) so every segment shares
 * the same plates. Strings that bow are approximated by N chord pieces, with
 * N chosen per string from a pixel tolerance rather than a flat constant.
 *
 * Anything richer than stroke-only two-vertex path groups (fills, ellipses,
 * trim paths, repeaters, animated stroke paint, animated group transforms)
 * makes the layer a non-candidate; the caller then falls back to its usual
 * Shadow / skip handling.
 */

import { bezierEase, buildLocal, evalOpacity } from './lottie-eval.mjs';
import { identity, mulMat } from './matrix.mjs';

export const NET_STRING_ASSET = 'Net_String';
export const NET_STATIC_ASSET = 'Net_Static';
export const NET_REST_MOVERS_ASSET = 'Net_Rest_Movers';

/** `$net_color` placeholder so skins can retint the mesh without a re-bake. */
export const NET_COLOR_VAR = '$net_color';

const DEFAULTS = {
  /** Peak on-screen motion below which a string is folded into Net_Static. */
  minMotionPx: 0.25,
  /** Max chord-to-curve error allowed before a bowing string is subdivided. */
  curveTolerancePx: 1.5,
  /** Hard cap on chord pieces per string. */
  curveSegments: 6,
};

/** Samples per piece when measuring chord-to-curve deviation. */
const DEVIATION_SAMPLES = 16;
const EPS = 1e-9;

function notImplemented(label, detail) {
  throw new Error(
    `[bva] Not implemented: ${detail} on ${label}. ` +
      `Stroke-mesh layers must be groups of two-vertex stroke-only paths ` +
      `sharing one static colour and width.`,
  );
}

// --- Lottie shape-property evaluation -------------------------------------

function normalizeShape(raw, label) {
  if (!raw || typeof raw !== 'object') {
    notImplemented(label, 'malformed path value');
  }
  const v = raw.v;
  const i = raw.i;
  const o = raw.o;
  if (!Array.isArray(v) || !Array.isArray(i) || !Array.isArray(o)) {
    notImplemented(label, 'malformed path vertex arrays');
  }
  return { v, i, o, c: raw.c === true };
}

function shapeKeyValue(key, prev, label) {
  const s = Array.isArray(key.s) ? key.s[0] : key.s;
  if (s) return normalizeShape(s, label);
  const e = Array.isArray(prev?.e) ? prev.e[0] : prev?.e;
  if (e) return normalizeShape(e, label);
  notImplemented(label, 'path keyframe without a value');
  return null;
}

function lerpPairs(a, b, u) {
  const out = new Array(a.length);
  for (let k = 0; k < a.length; k++) {
    const p = a[k];
    const q = b[k] ?? p;
    out[k] = [p[0] + (q[0] - p[0]) * u, p[1] + (q[1] - p[1]) * u];
  }
  return out;
}

/** Interpolate a Lottie path property at source-frame time `t`. */
function evalShape(prop, t, label) {
  if (!prop || typeof prop !== 'object') {
    notImplemented(label, 'missing path property');
  }
  if (prop.a !== 1) return normalizeShape(prop.k, label);

  const keys = prop.k;
  if (!Array.isArray(keys) || keys.length === 0) {
    notImplemented(label, 'empty animated path');
  }
  if (t <= keys[0].t) return shapeKeyValue(keys[0], null, label);

  for (let i = 0; i < keys.length - 1; i++) {
    const k0 = keys[i];
    const k1 = keys[i + 1];
    if (t >= k1.t) continue;
    const s0 = shapeKeyValue(k0, null, label);
    const s1 = shapeKeyValue(k1, k0, label);
    if (s1.v.length !== s0.v.length) {
      notImplemented(label, 'path keyframes with differing vertex counts');
    }
    const u = bezierEase((t - k0.t) / (k1.t - k0.t), k0.o, k0.i);
    return {
      v: lerpPairs(s0.v, s1.v, u),
      i: lerpPairs(s0.i, s1.i, u),
      o: lerpPairs(s0.o, s1.o, u),
      c: s0.c,
    };
  }
  const last = keys[keys.length - 1];
  return shapeKeyValue(last, keys[keys.length - 2], label);
}

/** Every distinct value a path property takes at its keyframes. */
function shapeKeyframeValues(prop, label) {
  if (!prop || prop.a !== 1) return [normalizeShape(prop?.k, label)];
  const keys = prop.k;
  const out = [];
  for (let i = 0; i < keys.length; i++) {
    out.push(shapeKeyValue(keys[i], keys[i - 1], label));
  }
  return out;
}

function isAnimatedShape(prop) {
  return prop?.a === 1 && Array.isArray(prop.k) && prop.k.length > 1;
}

// --- Geometry -------------------------------------------------------------

function applyMat(m, p) {
  return [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];
}

/** Cubic control points of a two-vertex path, in the string's own space. */
function cubicOf(shape, xf) {
  const p0 = shape.v[0];
  const p3 = shape.v[1];
  const c1 = [p0[0] + shape.o[0][0], p0[1] + shape.o[0][1]];
  const c2 = [p3[0] + shape.i[1][0], p3[1] + shape.i[1][1]];
  return [applyMat(xf, p0), applyMat(xf, c1), applyMat(xf, c2), applyMat(xf, p3)];
}

function cubicPoint(c, u) {
  const m = 1 - u;
  const a = m * m * m;
  const b = 3 * m * m * u;
  const d = 3 * m * u * u;
  const e = u * u * u;
  return [
    a * c[0][0] + b * c[1][0] + d * c[2][0] + e * c[3][0],
    a * c[0][1] + b * c[1][1] + d * c[2][1] + e * c[3][1],
  ];
}

function isStraight(c) {
  return (
    Math.abs(c[1][0] - c[0][0]) < EPS &&
    Math.abs(c[1][1] - c[0][1]) < EPS &&
    Math.abs(c[2][0] - c[3][0]) < EPS &&
    Math.abs(c[2][1] - c[3][1]) < EPS
  );
}

/** Worst distance between the curve and its `n`-piece chord approximation. */
function chordDeviation(c, n) {
  let worst = 0;
  for (let k = 0; k < n; k++) {
    const t0 = k / n;
    const t1 = (k + 1) / n;
    const A = cubicPoint(c, t0);
    const B = cubicPoint(c, t1);
    const dx = B[0] - A[0];
    const dy = B[1] - A[1];
    const len = Math.hypot(dx, dy);
    if (len < EPS) continue;
    for (let j = 1; j < DEVIATION_SAMPLES; j++) {
      const q = cubicPoint(c, t0 + ((t1 - t0) * j) / DEVIATION_SAMPLES);
      const d = Math.abs(dx * (A[1] - q[1]) - (A[0] - q[0]) * dy) / len;
      if (d > worst) worst = d;
    }
  }
  return worst;
}

/**
 * Matrix mapping the unit segment (0,0)->(1,0) onto `p0`->`p1`, scaling
 * along the chord only so stroke width survives untouched. Degenerate
 * (zero-length) chords report `opacity: 0` instead of a singular matrix.
 */
export function unitToSegmentMatrix(p0, p1) {
  const ux = p1[0] - p0[0];
  const uy = p1[1] - p0[1];
  const len = Math.hypot(ux, uy);
  if (len < EPS) {
    return { matrix: [EPS, 0, 0, 1, p0[0], p0[1]], opacity: 0 };
  }
  return {
    matrix: [ux, uy, -uy / len, ux / len, p0[0], p0[1]],
    opacity: 1,
  };
}

/**
 * Endpoints of chord piece `index` of `count`, pushed outward at interior
 * joints by `overlap` so butt caps cannot leave a notch on a bend.
 */
function pieceEndpoints(cubic, index, count, overlap) {
  let a = cubicPoint(cubic, index / count);
  let b = cubicPoint(cubic, (index + 1) / count);
  if (overlap > 0 && count > 1) {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    if (len > EPS) {
      const ex = (dx / len) * overlap;
      const ey = (dy / len) * overlap;
      if (index > 0) a = [a[0] - ex, a[1] - ey];
      if (index < count - 1) b = [b[0] + ex, b[1] + ey];
    }
  }
  return [a, b];
}

// --- Shape-tree parsing ---------------------------------------------------

function staticVec(prop, fallback) {
  if (!prop || typeof prop !== 'object') return fallback;
  if (prop.a === 1) return null;
  return prop.k;
}

/**
 * Static local matrix + opacity of a group transform item. Returns null when
 * any channel animates (the caller then rejects the layer as a candidate).
 */
function groupTransform(tr) {
  if (!tr) return { matrix: identity(), opacity: 1 };
  for (const key of ['a', 'p', 'r', 's', 'sa', 'o']) {
    if (tr[key]?.a === 1) return null;
  }
  return { matrix: buildLocal(tr, 0), opacity: evalOpacity(tr, 0) };
}

function rgbToHex(rgb) {
  const byte = (v) => {
    const n = Math.round(Math.max(0, Math.min(1, Number(v) || 0)) * 255);
    return n.toString(16).padStart(2, '0');
  };
  return `#${byte(rgb[0])}${byte(rgb[1])}${byte(rgb[2])}`.toUpperCase();
}

/**
 * Walk one shape layer's tree and return its stroke strings, or null when the
 * layer is not a stroke mesh (contains fills, ellipses, animated paint, …).
 */
function parseStrokeLayer(layer) {
  const strings = [];
  let rejected = false;

  function visitGroup(items, trail, xf, opacity) {
    if (rejected) return;

    let path = null;
    let stroke = null;
    let tr = null;
    const children = [];
    for (const it of items) {
      if (!it || typeof it !== 'object') continue;
      switch (it.ty) {
        case 'sh':
          if (path) return void (rejected = true);
          path = it;
          break;
        case 'st':
          if (stroke) return void (rejected = true);
          stroke = it;
          break;
        case 'tr':
          if (tr) return void (rejected = true);
          tr = it;
          break;
        case 'gr':
          children.push(it);
          break;
        default:
          // Fills, ellipses, rects, trim paths, repeaters, gradients, …
          rejected = true;
          return;
      }
    }

    const local = groupTransform(tr);
    if (!local) return void (rejected = true);
    const xfHere = mulMat(xf, local.matrix);
    const opacityHere = opacity * local.opacity;

    if (path) {
      if (children.length > 0) return void (rejected = true);
      if (!stroke) return void (rejected = true);
      if (stroke.c?.a === 1 || stroke.o?.a === 1 || stroke.w?.a === 1) {
        return void (rejected = true);
      }
      const color = staticVec(stroke.c, null);
      const widthRaw = staticVec(stroke.w, null);
      const width = Array.isArray(widthRaw) ? widthRaw[0] : widthRaw;
      if (!Array.isArray(color) || color.length < 3 || !(width > 0)) {
        return void (rejected = true);
      }
      const label = `${layer.nm ?? 'shape layer'}${trail}`;
      const sample = normalizeShape(
        path.ks?.a === 1 ? shapeKeyValue(path.ks.k[0], null, label) : path.ks?.k,
        label,
      );
      if (sample.v.length !== 2 || sample.c) return void (rejected = true);

      const strokeOpacityRaw = staticVec(stroke.o, 100);
      const strokeOpacity =
        (Array.isArray(strokeOpacityRaw) ? strokeOpacityRaw[0] : strokeOpacityRaw) /
        100;

      strings.push({
        id: trail,
        label,
        prop: path.ks,
        xf: xfHere,
        opacity: opacityHere * strokeOpacity,
        color: rgbToHex(color),
        width,
      });
      return;
    }

    if (children.length === 0) return void (rejected = true);
    // Back-to-front: later items in the array sit lower in the AE stack.
    for (let i = children.length - 1; i >= 0; i--) {
      const child = children[i];
      visitGroup(child.it ?? [], `${trail}/${child.nm ?? i}`, xfHere, opacityHere);
      if (rejected) return;
    }
  }

  const shapes = Array.isArray(layer.shapes) ? layer.shapes : [];
  if (shapes.length === 0) return null;
  for (let i = shapes.length - 1; i >= 0; i--) {
    const g = shapes[i];
    if (g?.ty !== 'gr') return null;
    visitGroup(g.it ?? [], `/${g.nm ?? i}`, identity(), 1);
    if (rejected) return null;
  }
  return strings.length > 0 ? strings : null;
}

// --- Rig-wide planning ----------------------------------------------------

function walkParentChain(layer, layerByInd) {
  const chain = [];
  const seen = new Set();
  let cur = layer;
  while (cur) {
    if (seen.has(cur.ind)) break;
    seen.add(cur.ind);
    chain.push(cur);
    cur = cur.parent != null ? layerByInd[cur.parent] : null;
  }
  return chain;
}

/** Composite transform of a layer's parent chain at source time `t`. */
function chainMatrix(layer, layerByInd, t) {
  const chain = walkParentChain(layer, layerByInd);
  let acc = identity();
  for (let i = chain.length - 1; i >= 0; i--) {
    acc = mulMat(acc, buildLocal(chain[i].ks, t));
  }
  return acc;
}

function uniformScale(m) {
  const det = Math.abs(m[0] * m[3] - m[1] * m[2]);
  return Math.sqrt(det) || 1;
}

function matNearlyEqual(a, b, tol = 1e-4) {
  for (let i = 0; i < 6; i++) {
    if (Math.abs(a[i] - b[i]) > tol) return false;
  }
  return true;
}

/** Stroke-mesh shape layers of one segment precomp, in draw order. */
function findStrokeLayers(precomp) {
  const found = [];
  const layers = precomp.layers ?? [];
  for (let i = layers.length - 1; i >= 0; i--) {
    const l = layers[i];
    if (l.ty !== 4) continue;
    const strings = parseStrokeLayer(l);
    if (strings) found.push({ layer: l, strings });
  }
  return found;
}

function fmtNum(v) {
  const r = Math.round(v * 1000) / 1000;
  return Object.is(r, -0) ? '0' : String(r);
}

/** One `<path>` `d` covering many strings at their rest pose. */
function plateData(entries) {
  const parts = [];
  for (const { cubic } of entries) {
    const [p0, c1, c2, p3] = cubic;
    parts.push(`M${fmtNum(p0[0])},${fmtNum(p0[1])}`);
    if (isStraight(cubic)) {
      parts.push(`L${fmtNum(p3[0])},${fmtNum(p3[1])}`);
    } else {
      parts.push(
        `C${fmtNum(c1[0])},${fmtNum(c1[1])} ${fmtNum(c2[0])},${fmtNum(c2[1])} ` +
          `${fmtNum(p3[0])},${fmtNum(p3[1])}`,
      );
    }
  }
  return parts.join('');
}

function plateArtwork(entries, width) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const { cubic } of entries) {
    for (const p of cubic) {
      minX = Math.min(minX, p[0]);
      minY = Math.min(minY, p[1]);
      maxX = Math.max(maxX, p[0]);
      maxY = Math.max(maxY, p[1]);
    }
  }
  const w = Math.ceil(maxX - minX) || 1;
  const h = Math.ceil(maxY - minY) || 1;
  return {
    viewBox: `${fmtNum(minX)} ${fmtNum(minY)} ${w} ${h}`,
    width: w,
    height: h,
    body: [
      {
        _tag: 'path',
        d: plateData(entries),
        fill: 'none',
        stroke: NET_COLOR_VAR,
        'stroke-width': String(width),
        'stroke-linecap': 'butt',
      },
    ],
  };
}

function unitLineArtwork(width) {
  return {
    viewBox: '0 0 1 1',
    width: 1,
    height: 1,
    body: [
      {
        _tag: 'line',
        x1: '0',
        y1: '0',
        x2: '1',
        y2: '0',
        fill: 'none',
        stroke: NET_COLOR_VAR,
        'stroke-width': String(width),
        'stroke-linecap': 'butt',
      },
    ],
  };
}

/**
 * Classify every mesh string across the whole rig and synthesize the shared
 * artwork. Rig-wide because all segments draw the same two plates: a string
 * that moves in *any* segment must be a mover everywhere.
 *
 * `segments` is `[{ name, precomp, stage }]`. Returns null when the rig has
 * no stroke meshes.
 */
export function planStrokeNets(segments, options = {}) {
  const opts = {
    minMotionPx: options.minMotionPx ?? DEFAULTS.minMotionPx,
    curveTolerancePx: options.curveTolerancePx ?? DEFAULTS.curveTolerancePx,
    curveSegments: options.curveSegments ?? DEFAULTS.curveSegments,
  };
  const perSegment = new Map();
  let stageScale = 1;

  for (const seg of segments) {
    const found = findStrokeLayers(seg.precomp);
    if (found.length === 0) continue;
    perSegment.set(seg.name, { seg, found });
    if (seg.stage) stageScale = uniformScale(seg.stage);
  }
  if (perSegment.size === 0) return null;

  // A plate merges many strings into one part, so it can only cover strings
  // that move together. That unit is the shape layer: a mesh often mirrors
  // half of itself with a scale of -100, and which half is mirrored flips
  // between the left and right variants. Plate geometry therefore stays in layer
  // space (identical in every segment) and each segment's own layer chain
  // does the placing.
  const bucketByLayer = new Map();
  let pxScale = stageScale;
  for (const [segName, { seg, found }] of perSegment) {
    const layerByInd = {};
    for (const l of seg.precomp.layers ?? []) layerByInd[l.ind] = l;
    for (const { layer } of found) {
      const m0 = chainMatrix(layer, layerByInd, 0);
      if (!matNearlyEqual(m0, chainMatrix(layer, layerByInd, 1))) {
        console.warn(
          `[bva] Stroke-mesh layer "${layer.nm}" in segment "${segName}" has an ` +
            `animated parent chain; mesh plates assume a static one and may drift.`,
        );
      }
      if (!bucketByLayer.has(layer.nm)) {
        if (bucketByLayer.size === 0) pxScale = stageScale * uniformScale(m0);
        bucketByLayer.set(layer.nm, bucketByLayer.size);
      }
    }
  }
  const bucketCount = bucketByLayer.size;
  const bucketOf = (layerName) => bucketByLayer.get(layerName) ?? 0;
  const bucketAsset = (base, bucket) =>
    bucket === 0 ? base : `${base}_${bucket + 1}`;

  // Every segment must expose the same strings, keyed by tree path.
  let order = null;
  const bySegment = new Map();
  for (const [segName, { found }] of perSegment) {
    const flat = [];
    for (const { layer, strings } of found) {
      for (const s of strings) flat.push({ ...s, layer });
    }
    const ids = flat.map((s) => `${s.layer.nm}${s.id}`);
    if (order === null) {
      order = ids;
    } else if (ids.length !== order.length || ids.some((v, i) => v !== order[i])) {
      throw new Error(
        `[bva] Not implemented: stroke-mesh structure differs in segment ` +
          `"${segName}" (${ids.length} strings vs ${order.length}). ` +
          `Every segment must contain the same mesh.`,
      );
    }
    bySegment.set(segName, flat);
  }

  const count = order.length;
  const color = new Set();
  const widths = new Set();
  const classes = new Array(count);
  const restCubics = new Array(count);

  for (let idx = 0; idx < count; idx++) {
    let peakMotion = 0;
    let animated = false;
    let rest = null;
    let bucket = 0;

    for (const [segName, flat] of bySegment) {
      bucket = bucketOf(flat[idx].layer.nm);
      const s = flat[idx];
      color.add(s.color);
      widths.add(s.width);
      const values = shapeKeyframeValues(s.prop, s.label);
      const cubics = values.map((sh) => cubicOf(sh, s.xf));
      if (rest === null) {
        rest = cubics[0];
      } else if (
        Math.hypot(rest[0][0] - cubics[0][0][0], rest[0][1] - cubics[0][0][1]) >
          0.01 ||
        Math.hypot(rest[3][0] - cubics[0][3][0], rest[3][1] - cubics[0][3][1]) >
          0.01
      ) {
        throw new Error(
          `[bva] Not implemented: mesh string "${s.label}" has a different rest ` +
            `pose in segment "${segName}". All segments must share one rest mesh.`,
        );
      }
      if (isAnimatedShape(s.prop)) animated = true;
      for (const c of cubics) {
        peakMotion = Math.max(
          peakMotion,
          Math.hypot(c[0][0] - rest[0][0], c[0][1] - rest[0][1]),
          Math.hypot(c[3][0] - rest[3][0], c[3][1] - rest[3][1]),
        );
      }
    }

    restCubics[idx] = rest;
    const movesEnough = animated && peakMotion * pxScale >= opts.minMotionPx;
    if (!movesEnough) {
      classes[idx] = { mover: false, bucket };
      continue;
    }

    // Smallest chord count that keeps every keyframe within tolerance.
    let pieces = 1;
    for (const [, flat] of bySegment) {
      const s = flat[idx];
      for (const sh of shapeKeyframeValues(s.prop, s.label)) {
        const c = cubicOf(sh, s.xf);
        if (isStraight(c)) continue;
        while (
          pieces < opts.curveSegments &&
          chordDeviation(c, pieces) * pxScale > opts.curveTolerancePx
        ) {
          pieces++;
        }
      }
    }
    classes[idx] = { mover: true, pieces, bucket };
  }

  if (widths.size > 1) {
    throw new Error(
      `[bva] Not implemented: mesh strings with differing stroke widths ` +
        `(${[...widths].join(', ')}). One shared Net_String artwork needs one width.`,
    );
  }
  if (color.size > 1) {
    throw new Error(
      `[bva] Not implemented: mesh strings with differing stroke colours ` +
        `(${[...color].join(', ')}). Recolour per skin with $net_color instead.`,
    );
  }

  const width = [...widths][0];
  const artwork = {};
  const buckets = [];
  let staticTotal = 0;
  let moverTotal = 0;

  for (let bucket = 0; bucket < bucketCount; bucket++) {
    const staticEntries = [];
    const moverEntries = [];
    for (let idx = 0; idx < count; idx++) {
      if (classes[idx].bucket !== bucket) continue;
      const entry = { cubic: restCubics[idx] };
      if (classes[idx].mover) moverEntries.push(entry);
      else staticEntries.push(entry);
    }
    staticTotal += staticEntries.length;
    moverTotal += moverEntries.length;

    const info = { staticAsset: null, restAsset: null };
    if (staticEntries.length > 0) {
      info.staticAsset = bucketAsset(NET_STATIC_ASSET, bucket);
      artwork[info.staticAsset] = plateArtwork(staticEntries, width);
    }
    if (moverEntries.length > 0) {
      info.restAsset = bucketAsset(NET_REST_MOVERS_ASSET, bucket);
      artwork[info.restAsset] = plateArtwork(moverEntries, width);
    }
    buckets.push(info);
  }
  if (moverTotal > 0) artwork[NET_STRING_ASSET] = unitLineArtwork(width);

  // Canonical rest placement: prefer a segment with no path animation (idle)
  // so left/right hits that flip layer scale-X still share one rest pose.
  // Layers whose rest bbox stays in the same place (front / top) rebind
  // onto that canon; layers that swap sides keep their segment chain.
  let canonName = null;
  for (const [segName, flat] of bySegment) {
    if (!flat.some((s) => isAnimatedShape(s.prop))) {
      canonName = segName;
      break;
    }
  }
  if (canonName == null) canonName = [...perSegment.keys()][0];

  const canonChains = new Map();
  {
    const { seg, found } = perSegment.get(canonName);
    const layerByInd = {};
    for (const l of seg.precomp.layers ?? []) layerByInd[l.ind] = l;
    for (const { layer } of found) {
      canonChains.set(layer.nm, chainMatrix(layer, layerByInd, 0));
    }
  }

  /** @type {Map<string, Map<string, boolean>>} segName → layerName → rebind */
  const rebindBySegment = new Map();
  for (const [segName, { seg, found }] of perSegment) {
    const layerByInd = {};
    for (const l of seg.precomp.layers ?? []) layerByInd[l.ind] = l;
    const flags = new Map();
    for (const { layer } of found) {
      const canon = canonChains.get(layer.nm);
      const live = chainMatrix(layer, layerByInd, 0);
      if (!canon || matNearlyEqual(canon, live)) {
        flags.set(layer.nm, false);
        continue;
      }
      const layerRest = [];
      for (let idx = 0; idx < count; idx++) {
        if (classes[idx].bucket !== bucketOf(layer.nm)) continue;
        layerRest.push(restCubics[idx]);
      }
      const centerX = (chain) => {
        let sum = 0;
        let n = 0;
        for (const c of layerRest) {
          for (const p of [c[0], c[3]]) {
            sum += chain[0] * p[0] + chain[2] * p[1] + chain[4];
            n++;
          }
        }
        return n ? sum / n : 0;
      };
      const span = Math.abs(centerX(canon) - centerX(live));
      const canonDet = canon[0] * canon[3] - canon[1] * canon[2];
      const liveDet = live[0] * live[3] - live[1] * live[2];
      const reflected = canonDet * liveDet < 0;
      // Reflections carry the left/right semantics of the clip. Rebinding one
      // to idle would apply the right variant's deformation to the left half.
      flags.set(layer.nm, span < 200 && !reflected);
    }
    rebindBySegment.set(segName, flags);
  }

  const rebound = [...rebindBySegment.values()].reduce(
    (n, flags) => n + [...flags.values()].filter(Boolean).length,
    0,
  );
  const moverPieces = classes.reduce((n, c) => n + (c.mover ? c.pieces : 0), 0);
  console.log(
    `[bva]   stroke-mesh: ${count} strings → ${staticTotal} static + ` +
      `${moverTotal} moving (${moverPieces} chord parts) in ${bucketCount} ` +
      `placement${bucketCount === 1 ? '' : 's'}, width ${width}, ${[...color][0]}` +
      (rebound
        ? `; rest-locked ${rebound} flipped layer(s) to "${canonName}"`
        : ''),
  );

  return {
    classes,
    buckets,
    order,
    artwork,
    width,
    color: [...color][0],
    overlap: width / 2,
    canonName,
    canonChains,
    rebindBySegment,
  };
}

// --- Per-segment part collection -----------------------------------------

function rememberArtwork(store, name, part) {
  const key = JSON.stringify(part.body);
  const existing = store[name];
  if (!existing) {
    store[name] = { key, part };
    return;
  }
  if (existing.key !== key) {
    throw new Error(
      `[bva] Not implemented: "${name}" artwork differs across segments. ` +
        `Mesh plates must be identical for every segment.`,
    );
  }
}

/**
 * Parts for one segment's stroke meshes.
 *
 * Segments where nothing moves get the two rest plates (2 parts). Segments
 * with motion get the Net_Static plate plus one Net_String part per chord
 * piece of every moving string.
 *
 * Returns `{ parts, strokeLayerInds }`; the caller skips those layer inds
 * during its own walk.
 */
export function collectStrokeParts(segPrecomp, segLabel, synthesizedParts, plan) {
  const strokeLayerInds = new Set();
  if (!plan) return { parts: [], strokeLayerInds };

  const found = findStrokeLayers(segPrecomp);
  if (found.length === 0) return { parts: [], strokeLayerInds };

  const flat = [];
  for (const { layer, strings } of found) {
    strokeLayerInds.add(layer.ind);
    for (const s of strings) flat.push({ ...s, layer });
  }
  if (flat.length !== plan.classes.length) {
    throw new Error(
      `[bva] Stroke-mesh string count changed in segment "${segLabel}" ` +
        `(${flat.length} vs ${plan.classes.length}).`,
    );
  }

  // Source colour of the mesh, so the layer bundle can seed `net_color` with
  // what the Lottie actually used. Underscore keys are baker-internal.
  synthesizedParts._netColor = plan.color;

  const anyMotion = flat.some(
    (s, idx) => plan.classes[idx].mover && isAnimatedShape(s.prop),
  );

  const parts = [];
  /** Hang a plate off any string in its bucket — they share a placement. */
  const pushPlate = (assetName, bucket, wantMover) => {
    if (!assetName) return;
    const art = plan.artwork[assetName];
    if (!art) return;
    const seed = flat.find(
      (s, i) =>
        plan.classes[i].bucket === bucket &&
        plan.classes[i].mover === wantMover,
    );
    if (!seed) return;
    rememberArtwork(synthesizedParts, assetName, art);
    parts.push({
      kind: 'stroke',
      layer: seed.layer,
      assetName,
      stroke: { plate: true, opacity: seed.opacity },
    });
  };

  const rebindFlags = plan.rebindBySegment?.get(segLabel) ?? new Map();
  const placementOf = (layer) => ({
    rebind: rebindFlags.get(layer.nm) === true,
    canonChain: plan.canonChains?.get(layer.nm) ?? null,
  });

  // Static strings first: they sit behind the movers in the same plane, and
  // draw order only matters where strings cross at the knots.
  plan.buckets.forEach((b, bucket) => pushPlate(b.staticAsset, bucket, false));

  if (!anyMotion) {
    plan.buckets.forEach((b, bucket) => pushPlate(b.restAsset, bucket, true));
    for (const p of parts) {
      const place = placementOf(p.layer);
      p.stroke.rebind = place.rebind;
      p.stroke.canonChain = place.canonChain;
    }
    return { parts, strokeLayerInds };
  }

  const unit = plan.artwork[NET_STRING_ASSET];
  if (unit) rememberArtwork(synthesizedParts, NET_STRING_ASSET, unit);

  for (let idx = 0; idx < flat.length; idx++) {
    const cls = plan.classes[idx];
    if (!cls.mover) continue;
    const s = flat[idx];
    const place = placementOf(s.layer);
    for (let piece = 0; piece < cls.pieces; piece++) {
      parts.push({
        kind: 'stroke',
        layer: s.layer,
        assetName: NET_STRING_ASSET,
        stroke: {
          plate: false,
          prop: s.prop,
          label: s.label,
          xf: s.xf,
          opacity: s.opacity,
          piece,
          pieces: cls.pieces,
          overlap: plan.overlap,
          rebind: place.rebind,
          canonChain: place.canonChain,
        },
      });
    }
  }

  for (const p of parts) {
    if (p.stroke.rebind != null) continue;
    const place = placementOf(p.layer);
    p.stroke.rebind = place.rebind;
    p.stroke.canonChain = place.canonChain;
  }

  return { parts, strokeLayerInds };
}

/**
 * Local matrix (below the layer's parent chain) for a stroke part at
 * source-frame time `t`. Plates are baked in layer space, so their local is
 * identity; chord parts map the unit segment onto their endpoints.
 */
export function evalStrokeLocal(desc, t) {
  if (desc.plate) {
    return { matrix: identity(), opacity: desc.opacity };
  }
  const shape = evalShape(desc.prop, t, desc.label);
  const cubic = cubicOf(shape, desc.xf);
  const [a, b] = pieceEndpoints(cubic, desc.piece, desc.pieces, desc.overlap);
  const { matrix, opacity } = unitToSegmentMatrix(a, b);
  return { matrix, opacity: opacity * desc.opacity };
}

/**
 * Full precomp-space matrix for a stroke part at source time `t`.
 *
 * Non-reflected placement changes can rebind to the canonical idle chain.
 * Reflected chains keep `segChain`: the reflection carries the clip's
 * left/right semantics and rebinding it corrupts the affected side.
 */
export function evalStrokeMatrix(desc, segChain, t) {
  if (desc.plate) {
    const chain =
      desc.rebind && desc.canonChain ? desc.canonChain : segChain;
    return { matrix: chain, opacity: desc.opacity };
  }

  const local = evalStrokeLocal(desc, t);
  if (!desc.rebind || !desc.canonChain) {
    return {
      matrix: mulMat(segChain, local.matrix),
      opacity: local.opacity,
    };
  }

  return {
    matrix: mulMat(desc.canonChain, local.matrix),
    opacity: local.opacity,
  };
}
