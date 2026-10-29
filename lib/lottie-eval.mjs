/**
 * Lottie keyframe evaluator. Implements just enough of the Lottie spec to
 * collapse a property animation down to a single value (or vector) at an
 * arbitrary source-frame time `t`.
 *
 * `buildLocal(ks, t)` composes a layer's local transform from its anchor,
 * position, rotation, skew and scale tracks into a 2D affine matrix in the
 * order Lottie itself uses:
 *
 *     local = T(p) * R(r) * Skew(sa) * S(s) * T(-a)
 */

import { translate, rotate, skewX, scale, mulMat } from './matrix.mjs';

const first = (v) => (Array.isArray(v) ? v[0] : v);

/**
 * Lottie keyframe easing: solve the o/i control-point bezier for `u`.
 * Exported so path-property evaluators (bake-strokes) ease identically.
 */
export function bezierEase(u, o, i) {
  if (!o || !i) return u;
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  const ox = first(o.x);
  const oy = first(o.y);
  const ix = first(i.x);
  const iy = first(i.y);

  // Newton's method to solve bezierX(t) = u, then return bezierY(t).
  let t = u;
  for (let it = 0; it < 12; it++) {
    const mt = 1 - t;
    const bx = 3 * mt * mt * t * ox + 3 * mt * t * t * ix + t * t * t;
    const dbx =
      3 * mt * mt * ox + 6 * mt * t * (ix - ox) + 3 * t * t * (1 - ix);
    if (Math.abs(dbx) < 1e-8) break;
    const next = t - (bx - u) / dbx;
    t = next < 0 ? 0 : next > 1 ? 1 : next;
  }
  const mt = 1 - t;
  return 3 * mt * mt * t * oy + 3 * mt * t * t * iy + t * t * t;
}

export function evalProp(prop, t) {
  if (!prop) return 0;
  if (prop.a === 0) return prop.k;

  const keys = prop.k;
  if (!keys || keys.length === 0) return 0;
  if (t <= keys[0].t) return keys[0].s ?? 0;

  for (let i = 0; i < keys.length - 1; i++) {
    const k0 = keys[i];
    const k1 = keys[i + 1];
    if (t < k1.t) {
      const s0 = k0.s;
      const s1 = k1.s !== undefined ? k1.s : k0.e ?? s0;
      const u = (t - k0.t) / (k1.t - k0.t);
      const eased = bezierEase(u, k0.o, k0.i);
      if (Array.isArray(s0)) {
        return s0.map((v, idx) => v + ((s1[idx] ?? v) - v) * eased);
      }
      return s0 + (s1 - s0) * eased;
    }
  }
  return keys[keys.length - 1].s ?? 0;
}

export function buildLocal(ks, t) {
  const aProp = evalProp(ks.a, t);
  const pProp = evalProp(ks.p, t);
  const rProp = evalProp(ks.r, t);
  const saProp = evalProp(ks.sa, t);
  const sProp = evalProp(ks.s, t);

  const ax = Array.isArray(aProp) ? aProp[0] : aProp;
  const ay = Array.isArray(aProp) ? aProp[1] ?? 0 : 0;
  const px = Array.isArray(pProp) ? pProp[0] : pProp;
  const py = Array.isArray(pProp) ? pProp[1] ?? 0 : 0;
  const rot = Array.isArray(rProp) ? rProp[0] : rProp;
  const sax = Array.isArray(saProp) ? saProp[0] : saProp;
  const sx = (Array.isArray(sProp) ? sProp[0] : sProp) / 100;
  const sy = (Array.isArray(sProp) ? sProp[1] ?? sProp[0] ?? 100 : sProp) / 100;

  let m = translate(px, py);
  if (rot) m = mulMat(m, rotate(rot));
  if (sax) m = mulMat(m, skewX(sax));
  if (sx !== 1 || sy !== 1) m = mulMat(m, scale(sx, sy));
  if (ax || ay) m = mulMat(m, translate(-ax, -ay));
  return m;
}

/**
 * Evaluate a layer's opacity track at source-frame time `t`.
 * Lottie stores opacity as 0–100; returns a 0–1 factor for SVG.
 * Missing opacity defaults to fully opaque (1).
 */
export function evalOpacity(ks, t) {
  if (!ks || ks.o == null) return 1;
  const o = evalProp(ks.o, t);
  const v = Array.isArray(o) ? o[0] : o;
  return v / 100;
}
