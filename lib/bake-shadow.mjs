/**
 * Bake Lottie "Shadow" shape layers (simple ellipse + fill) into a BVA part.
 *
 * Supported schema (strict):
 *   - layer.nm === "Shadow", ty === 4
 *   - exactly one shape group containing one ellipse, one fill, one transform,
 *     and optionally one stroke
 *   - animated ellipse size is folded into scale relative to a fixed base size
 *   - fill / stroke colour may be static (SVG only) or animated (per-frame
 *     `.bva` `f` / `s` suffixes); fill / group / layer opacity multiply into
 *     part opacity
 *
 * Anything richer (paths, gradients, multiple shapes, animated fill/stroke
 * opacity, animated ellipse center) fails the bake loudly.
 */

import { evalProp } from './lottie-eval.mjs';
import { mulMat, scale, translate } from './matrix.mjs';

export const SHADOW_ASSET_NAME = 'Shadow';

function notImplemented(label, detail) {
  throw new Error(
    `[bva] Not implemented: ${detail} on ${label}. ` +
      `Shadow layers must be a single ellipse + fill group ` +
      `(optional stroke + group transform; ellipse size may animate).`,
  );
}

function propStaticValue(prop, label, field) {
  if (!prop || typeof prop !== 'object') {
    notImplemented(label, `missing ${field}`);
  }
  if (prop.a === 1) {
    notImplemented(label, `animated ${field}`);
  }
  return prop.k;
}

function firstSizeValue(sizeProp, label) {
  if (!sizeProp || typeof sizeProp !== 'object') {
    notImplemented(label, 'missing ellipse size');
  }
  if (sizeProp.a === 0) {
    const k = sizeProp.k;
    if (!Array.isArray(k) || k.length < 2) {
      notImplemented(label, 'invalid static ellipse size');
    }
    return [k[0], k[1]];
  }
  const keys = sizeProp.k;
  if (!Array.isArray(keys) || keys.length === 0) {
    notImplemented(label, 'empty animated ellipse size');
  }
  const s = keys[0].s;
  if (!Array.isArray(s) || s.length < 2) {
    notImplemented(label, 'invalid ellipse size keyframe');
  }
  return [s[0], s[1]];
}

/** First / static RGB triple from a Lottie colour property (0–1 channels). */
function firstColorValue(colorProp, label, field) {
  if (!colorProp || typeof colorProp !== 'object') {
    notImplemented(label, `missing ${field}`);
  }
  if (colorProp.a === 0) {
    const k = colorProp.k;
    if (!Array.isArray(k) || k.length < 3) {
      notImplemented(label, `invalid static ${field}`);
    }
    return [k[0], k[1], k[2]];
  }
  const keys = colorProp.k;
  if (!Array.isArray(keys) || keys.length === 0) {
    notImplemented(label, `empty animated ${field}`);
  }
  const s = keys[0].s;
  if (!Array.isArray(s) || s.length < 3) {
    notImplemented(label, `invalid ${field} keyframe`);
  }
  return [s[0], s[1], s[2]];
}

export function rgbToHex(rgb) {
  const toByte = (v) => {
    const n = Math.round(Math.max(0, Math.min(1, Number(v) || 0)) * 255);
    return n.toString(16).padStart(2, '0');
  };
  return `#${toByte(rgb[0])}${toByte(rgb[1])}${toByte(rgb[2])}`;
}

function opacityFactor(prop) {
  if (!prop) return 1;
  if (prop.a === 1) {
    throw new Error('animated opacity in static helper');
  }
  const v = Array.isArray(prop.k) ? prop.k[0] : prop.k;
  return (v ?? 100) / 100;
}

function evalColorHex(colorProp, t, fallbackRgb) {
  const v = evalProp(colorProp, t);
  if (!Array.isArray(v) || v.length < 3) {
    return rgbToHex(fallbackRgb);
  }
  return rgbToHex(v);
}

/**
 * Parse and validate a Shadow shape layer.
 * Returns a descriptor used for SVG synthesis and per-frame evaluation.
 */
export function parseShadowLayer(layer, label) {
  if (layer.ty !== 4 || layer.nm !== SHADOW_ASSET_NAME) {
    notImplemented(label, 'non-Shadow shape layer');
  }

  const shapes = layer.shapes;
  if (!Array.isArray(shapes) || shapes.length !== 1) {
    notImplemented(label, 'Shadow must contain exactly one shape group');
  }
  const group = shapes[0];
  if (group.ty !== 'gr') {
    notImplemented(label, 'Shadow root shape must be a group');
  }

  const items = group.it || [];
  let ellipse = null;
  let fill = null;
  let stroke = null;
  let groupTr = null;
  for (const it of items) {
    if (it.ty === 'el') {
      if (ellipse) notImplemented(label, 'multiple ellipses');
      ellipse = it;
    } else if (it.ty === 'fl') {
      if (fill) notImplemented(label, 'multiple fills');
      fill = it;
    } else if (it.ty === 'st') {
      if (stroke) notImplemented(label, 'multiple strokes');
      stroke = it;
    } else if (it.ty === 'tr') {
      if (groupTr) notImplemented(label, 'multiple group transforms');
      groupTr = it;
    } else {
      notImplemented(label, `unsupported shape item ty=${it.ty}`);
    }
  }
  if (!ellipse || !fill || !groupTr) {
    notImplemented(label, 'Shadow group must contain ellipse + fill + transform');
  }

  const baseSize = firstSizeValue(ellipse.s, label);
  if (!(baseSize[0] > 0) || !(baseSize[1] > 0)) {
    notImplemented(label, 'ellipse base size must be positive');
  }

  const elPos = propStaticValue(ellipse.p, label, 'ellipse center');
  const ellipseOffset = Array.isArray(elPos)
    ? [elPos[0] ?? 0, elPos[1] ?? 0]
    : [0, 0];

  const fillRgb = firstColorValue(fill.c, label, 'fill color');
  if (fill.o?.a === 1) {
    notImplemented(label, 'animated fill opacity');
  }
  const fillOpacity = opacityFactor(fill.o);

  let strokeRgb = null;
  let strokeWidth = null;
  let strokeColorProp = null;
  let strokeColorAnimated = false;
  if (stroke) {
    strokeRgb = firstColorValue(stroke.c, label, 'stroke color');
    strokeColorProp = stroke.c;
    strokeColorAnimated = stroke.c?.a === 1;
    if (stroke.o?.a === 1) {
      notImplemented(label, 'animated stroke opacity');
    }
    // Stroke opacity multiplies into part opacity at bake time (static only).
    // Keep width static in the SVG.
    const w = propStaticValue(stroke.w, label, 'stroke width');
    strokeWidth = Array.isArray(w) ? w[0] : w;
    if (!(strokeWidth > 0)) {
      notImplemented(label, 'stroke width must be positive');
    }
  }

  // Group transform channels we care about: a/p/r/s/sa/o (same as layer ks).
  // Animated group opacity/transform are allowed (evaluated per frame).
  const groupKs = {
    a: groupTr.a ?? { a: 0, k: [0, 0] },
    p: groupTr.p ?? { a: 0, k: [0, 0] },
    r: groupTr.r ?? { a: 0, k: 0 },
    s: groupTr.s ?? { a: 0, k: [100, 100] },
    sa: groupTr.sa ?? { a: 0, k: 0 },
    o: groupTr.o ?? { a: 0, k: 100 },
  };

  return {
    baseSize,
    ellipseOffset,
    ellipseSizeProp: ellipse.s,
    fillRgb,
    fillOpacity,
    fillColorProp: fill.c,
    fillColorAnimated: fill.c?.a === 1,
    strokeRgb,
    strokeWidth,
    strokeColorProp,
    strokeColorAnimated,
    strokeOpacity: stroke ? opacityFactor(stroke.o) : 1,
    groupKs,
  };
}

/** Evaluate fill colour hex at source-frame time `t`. */
export function evalShadowFill(desc, t) {
  return evalColorHex(desc.fillColorProp, t, desc.fillRgb);
}

/** Evaluate stroke colour hex at source-frame time `t`, or null if no stroke. */
export function evalShadowStroke(desc, t) {
  if (!desc.strokeColorProp || !desc.strokeRgb) return null;
  return evalColorHex(desc.strokeColorProp, t, desc.strokeRgb);
}

/** Evaluate ellipse width/height at source-frame time `t`. */
export function evalShadowSize(desc, t) {
  const v = evalProp(desc.ellipseSizeProp, t);
  if (!Array.isArray(v) || v.length < 2) {
    return desc.baseSize.slice();
  }
  return [v[0], v[1]];
}

/**
 * Extra local matrix after the layer parent chain:
 *   T(ellipseOffset) * S(w/w0, h/h0) * T(-w0/2, -h0/2)
 * so a viewBox `0 0 w0 h0` SVG ellipse matches Lottie shape space.
 */
export function buildShadowLocal(desc, t) {
  const [w0, h0] = desc.baseSize;
  const [w, h] = evalShadowSize(desc, t);
  const [ox, oy] = desc.ellipseOffset;
  let m = translate(ox, oy);
  m = mulMat(m, scale(w / w0, h / h0));
  m = mulMat(m, translate(-w0 / 2, -h0 / 2));
  return m;
}

/** Stable key for cross-segment Shadow artwork consistency. */
export function shadowArtworkKey(desc) {
  const [w0, h0] = desc.baseSize;
  const [r, g, b] = desc.fillRgb;
  let key = `${w0},${h0},${r},${g},${b}`;
  if (desc.strokeRgb) {
    const [sr, sg, sb] = desc.strokeRgb;
    key += `,st:${sr},${sg},${sb},${desc.strokeWidth}`;
  }
  return key;
}

/**
 * Synthesize the SVG part body for skins._common.
 * Fill / stroke opacity are applied at bake time via part opacity, not in the SVG.
 */
export function shadowSvgPart(desc) {
  const [w0, h0] = desc.baseSize;
  const cx = w0 / 2;
  const cy = h0 / 2;
  const fill = rgbToHex(desc.fillRgb);
  const el = {
    _tag: 'ellipse',
    cx: String(cx),
    cy: String(cy),
    rx: String(cx),
    ry: String(cy),
    fill,
  };
  if (desc.strokeRgb) {
    el.stroke = rgbToHex(desc.strokeRgb);
    el['stroke-width'] = String(desc.strokeWidth);
  }
  return {
    viewBox: `0 0 ${w0} ${h0}`,
    width: w0,
    height: h0,
    body: [el],
  };
}

/**
 * Remember the first Shadow artwork for the rig; throw if a later segment
 * disagrees on base size / fill / stroke (one shared SVG part).
 */
export function rememberSynthesizedShadow(store, desc) {
  const key = shadowArtworkKey(desc);
  if (!store[SHADOW_ASSET_NAME]) {
    store[SHADOW_ASSET_NAME] = {
      key,
      part: shadowSvgPart(desc),
    };
    return;
  }
  if (store[SHADOW_ASSET_NAME].key !== key) {
    throw new Error(
      `[bva] Not implemented: Shadow artwork differs across segments ` +
        `(base size / fill / stroke must match for a single "${SHADOW_ASSET_NAME}" part).`,
    );
  }
}

/**
 * Drop a per-frame colour channel when every frame equals the same value
 * (constant colour stays in the SVG artwork only).
 */
export function stripConstantColorChannel(colors) {
  if (!colors || colors.length === 0) return undefined;
  const first = colors[0];
  for (let i = 1; i < colors.length; i++) {
    if (colors[i] !== first) return colors;
  }
  return undefined;
}
