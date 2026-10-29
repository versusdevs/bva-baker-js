/**
 * 2D affine matrix helpers in SVG `matrix(a,b,c,d,e,f)` order:
 *   | a c e |
 *   | b d f |
 *   | 0 0 1 |
 */

export const identity = () => [1, 0, 0, 1, 0, 0];
export const translate = (x, y) => [1, 0, 0, 1, x, y];
export const scale = (sx, sy) => [sx, 0, 0, sy, 0, 0];

export function rotate(deg) {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [c, s, -s, c, 0, 0];
}

export function skewX(deg) {
  const r = (deg * Math.PI) / 180;
  return [1, 0, Math.tan(r), 1, 0, 0];
}

export function mulMat(A, B) {
  const [a1, b1, c1, d1, e1, f1] = A;
  const [a2, b2, c2, d2, e2, f2] = B;
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  ];
}

/** Inverse of a 2D affine matrix. Throws when the linear part is singular. */
export function invertMat(m) {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-12) {
    throw new Error('[bva] Cannot invert singular matrix');
  }
  const invDet = 1 / det;
  return [
    d * invDet,
    -b * invDet,
    -c * invDet,
    a * invDet,
    (c * f - d * e) * invDet,
    (b * e - a * f) * invDet,
  ];
}

/**
 * Round a baked matrix for storage. Rotation columns (a,b,c,d) keep more
 * decimals than the translate columns (e,f) which are pixel-space.
 */
export function roundMat(m) {
  return [
    +m[0].toFixed(5),
    +m[1].toFixed(5),
    +m[2].toFixed(5),
    +m[3].toFixed(5),
    +m[4].toFixed(2),
    +m[5].toFixed(2),
  ];
}
