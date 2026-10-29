/**
 * Strict "supported subset" checks for the BVA baker.
 *
 * The runtime applies per-frame 2D affine matrices plus optional opacity /
 * fill / stroke. Shadow ellipse shape layers are handled separately in
 * bake-shadow.mjs (size folded into scale; animated paint → stream).
 * Blend modes (`bm`) are ignored (treated as Normal). Anything else that
 * would affect the picture (masks, time remap, 3D, …) must fail the bake
 * with a loud "not implemented" error instead of being silently dropped.
 */

function propPresent(prop) {
  return prop != null && typeof prop === 'object';
}

function isStaticZero(prop) {
  if (!propPresent(prop)) return true;
  if (prop.a === 1) return false;
  const k = prop.k;
  if (Array.isArray(k)) return (k[0] ?? 0) === 0;
  return k === 0;
}

function notImplemented(layerLabel, feature) {
  throw new Error(
    `[bva] Not implemented: ${feature} on ${layerLabel}. ` +
      `The baker only supports 2D transform + opacity baking ` +
      `(anchor/position/rotation/scale/skew-angle/opacity). ` +
      `Remove or bake this feature out of the Lottie source before retrying.`,
  );
}

/**
 * Assert that a Lottie layer uses only features the baker can represent.
 * `layerLabel` should already include segment / path context.
 */
export function assertSupportedLayer(layer, layerLabel) {
  if (layer.hd) notImplemented(layerLabel, 'hidden layer (hd)');

  if (layer.hasMask || (layer.masksProperties && layer.masksProperties.length)) {
    notImplemented(layerLabel, 'masks');
  }
  if (layer.tt) notImplemented(layerLabel, `track matte (tt=${layer.tt})`);
  if (layer.td) notImplemented(layerLabel, 'track matte target (td)');
  // Blend modes are dismissed: runtime has no mix-blend support, so any
  // `bm` is treated as Normal (0) and baking continues.
  if (layer.ef && layer.ef.length) notImplemented(layerLabel, 'effects');
  // Animated time remapping is unsupported. Static `tm` is allowed — collectParts
  // picks the image leaf visible at that fixed precomp time.
  if (propPresent(layer.tm) && layer.tm.a === 1) {
    notImplemented(layerLabel, 'animated time remapping');
  }
  if (layer.ao) notImplemented(layerLabel, 'auto-orient');
  if (layer.ddd) notImplemented(layerLabel, '3D layer');
  if (layer.sr != null && layer.sr !== 1) {
    notImplemented(layerLabel, `time stretch (sr=${layer.sr})`);
  }

  const ks = layer.ks;
  if (!ks) return;

  if (!isStaticZero(ks.sk)) notImplemented(layerLabel, 'skew axis (sk)');
  if (!isStaticZero(ks.rx)) notImplemented(layerLabel, '3D rotation X (rx)');
  if (!isStaticZero(ks.ry)) notImplemented(layerLabel, '3D rotation Y (ry)');
  if (!isStaticZero(ks.rz)) notImplemented(layerLabel, '3D rotation Z (rz)');

  if (propPresent(ks.or)) {
    const or = ks.or;
    if (or.a === 1) notImplemented(layerLabel, '3D orientation');
    const k = or.k;
    if (Array.isArray(k) && k.slice(0, 3).some((v) => v !== 0)) {
      notImplemented(layerLabel, '3D orientation');
    }
  }

  // Separated dimensions: position split into x/y props (Bodymovin `p.s`).
  if (ks.p && (ks.p.s === true || ks.p.x != null || ks.p.y != null)) {
    notImplemented(layerLabel, 'separated position dimensions');
  }
}

/**
 * Compare two stage matrices for equality at bake precision.
 */
export function matricesEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
