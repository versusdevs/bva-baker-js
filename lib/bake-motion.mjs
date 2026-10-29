/**
 * Lottie -> baked MotionData.
 *
 * Walks every top-level Lottie layer (each becomes a "segment"), then for
 * each segment walks the parent transform chain at every output frame and
 * collapses it to a single 2D affine matrix (and multiplied opacity) per
 * renderable image-layer ("part"). The result is animation-engine-free
 * playback at runtime: each frame is just a matrix / opacity / optional
 * fill / stroke attribute write per part.
 *
 * Shape layers named "Shadow" (simple ellipse + fill, optional stroke) are
 * also baked: ellipse size is folded into scale and a shared SVG part is
 * synthesized for skins. Animated Shadow fill / stroke colours become
 * per-frame `fills` / `strokes` arrays on the part.
 *
 * Stroke-mesh shape layers (stroke-only 2-vertex paths, e.g. a net) are
 * baked via bake-strokes.mjs. Strings are classified rig-wide before the
 * segment loop: movers become one matrix stream per chord over a shared
 * Net_String unit-line artwork, everything else merges into the Net_Static
 * and Net_Rest_Movers plates.
 *
 * Any other shape layer is skipped with a warning. Anything else outside
 * the supported transform subset still fails the bake with a
 * "not implemented" error.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import {
  assertSupportedLayer,
  matricesEqual,
} from './assert-supported.mjs';
import {
  SHADOW_ASSET_NAME,
  buildShadowLocal,
  evalShadowFill,
  evalShadowStroke,
  parseShadowLayer,
  rememberSynthesizedShadow,
  stripConstantColorChannel,
} from './bake-shadow.mjs';
import {
  collectStrokeParts,
  evalStrokeMatrix,
  planStrokeNets,
  unitToSegmentMatrix,
} from './bake-strokes.mjs';
import { identity, mulMat, roundMat } from './matrix.mjs';
import { buildLocal, evalOpacity } from './lottie-eval.mjs';
import { sanitizeName } from './naming.mjs';

function applyMatPoint(m, x, y) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

function partRestMid(part) {
  const m = part.matrices[0];
  const a = applyMatPoint(m, 0, 0);
  const b = applyMatPoint(m, 1, 0);
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

/**
 * Build a centre segment by blending `left` with a horizontally mirrored
 * `right`. Used when the Lottie has side variants but no centre clip.
 *
 * Net_String parts are paired by rest-pose mirror about the midline; other
 * parts (frames, …) are copied from `left` (idle-compatible orientation).
 */
function synthesizeMirrorBlendSegment(motion, name, leftName, rightName) {
  const left = motion.segments[leftName];
  const right = motion.segments[rightName];
  if (!left || !right) {
    throw new Error(
      `[bva] synthesizeSegments["${name}"]: need segments "${leftName}" and ` +
        `"${rightName}".`,
    );
  }
  if (left.frames !== right.frames) {
    throw new Error(
      `[bva] synthesizeSegments["${name}"]: "${leftName}" and "${rightName}" ` +
        `must share the same frame count.`,
    );
  }

  const leftNet = [];
  const rightNet = [];
  const leftOther = [];
  for (let i = 0; i < left.parts.length; i++) {
    const lp = left.parts[i];
    if (lp.asset === 'Net_String') leftNet.push({ i, part: lp });
    else leftOther.push(lp);
  }
  for (let i = 0; i < right.parts.length; i++) {
    const rp = right.parts[i];
    if (rp.asset === 'Net_String') rightNet.push({ i, part: rp });
  }
  if (leftNet.length !== rightNet.length) {
    throw new Error(
      `[bva] synthesizeSegments["${name}"]: Net_String counts differ ` +
        `(${leftNet.length} vs ${rightNet.length}).`,
    );
  }

  const midsL = leftNet.map(({ part }) => partRestMid(part));
  const midsR = rightNet.map(({ part }) => partRestMid(part));
  let minX = Infinity;
  let maxX = -Infinity;
  for (const m of midsL) {
    minX = Math.min(minX, m[0]);
    maxX = Math.max(maxX, m[0]);
  }
  for (const m of midsR) {
    minX = Math.min(minX, m[0]);
    maxX = Math.max(maxX, m[0]);
  }
  const cx = (minX + maxX) / 2;

  const pair = new Array(leftNet.length).fill(-1);
  const used = new Set();
  for (let i = 0; i < leftNet.length; i++) {
    let best = -1;
    let bestE = Infinity;
    for (let j = 0; j < rightNet.length; j++) {
      if (used.has(j)) continue;
      const e = Math.hypot(
        2 * cx - midsL[i][0] - midsR[j][0],
        midsL[i][1] - midsR[j][1],
      );
      if (e < bestE) {
        bestE = e;
        best = j;
      }
    }
    if (best < 0 || bestE > 4) {
      throw new Error(
        `[bva] synthesizeSegments["${name}"]: could not mirror-pair Net_String ` +
          `#${i} (best err ${bestE.toFixed(2)}).`,
      );
    }
    pair[i] = best;
    used.add(best);
  }

  const frames = left.frames;
  const netParts = leftNet.map(({ part: lp }, i) => {
    const rp = rightNet[pair[i]].part;
    const matrices = new Array(frames);
    const opacities = new Array(frames);
    for (let f = 0; f < frames; f++) {
      const lm = lp.matrices[f];
      const rm = rp.matrices[f];
      const l0 = applyMatPoint(lm, 0, 0);
      const l1 = applyMatPoint(lm, 1, 0);
      const r0 = applyMatPoint(rm, 0, 0);
      const r1 = applyMatPoint(rm, 1, 0);
      const mr0 = [2 * cx - r0[0], r0[1]];
      const mr1 = [2 * cx - r1[0], r1[1]];

      // Pick endpoint pairing that best matches left's orientation.
      const same =
        Math.hypot(l0[0] - mr0[0], l0[1] - mr0[1]) +
        Math.hypot(l1[0] - mr1[0], l1[1] - mr1[1]);
      const flip =
        Math.hypot(l0[0] - mr1[0], l0[1] - mr1[1]) +
        Math.hypot(l1[0] - mr0[0], l1[1] - mr0[1]);
      let a0;
      let a1;
      if (flip < same) {
        a0 = [(l0[0] + mr1[0]) / 2, (l0[1] + mr1[1]) / 2];
        a1 = [(l1[0] + mr0[0]) / 2, (l1[1] + mr0[1]) / 2];
      } else {
        a0 = [(l0[0] + mr0[0]) / 2, (l0[1] + mr0[1]) / 2];
        a1 = [(l1[0] + mr1[0]) / 2, (l1[1] + mr1[1]) / 2];
      }
      const { matrix, opacity: segO } = unitToSegmentMatrix(a0, a1);
      matrices[f] = roundMat(matrix);
      const lo = lp.opacities?.[f] ?? 1;
      const ro = rp.opacities?.[f] ?? 1;
      opacities[f] = ((lo + ro) / 2) * segO;
    }
    return { asset: 'Net_String', matrices, opacities };
  });

  // Preserve left draw order: Net_String slots filled with blended parts,
  // other assets copied from left.
  let netIdx = 0;
  const parts = left.parts.map((p) => {
    if (p.asset === 'Net_String') return netParts[netIdx++];
    return {
      asset: p.asset,
      matrices: p.matrices.map((m) => m.slice()),
      opacities: p.opacities ? p.opacities.slice() : undefined,
      fills: p.fills ? p.fills.slice() : undefined,
      strokes: p.strokes ? p.strokes.slice() : undefined,
    };
  });

  motion.segments[name] = { frames, parts };
}

/**
 * Local point both rest poses agree on. Side clips are often mirrors
 * (`a` flips sign), so a component-wise matrix mean collapses scale to 0.
 */
function restPivot(left0, right0) {
  const A00 = left0[0] - right0[0];
  const A01 = left0[2] - right0[2];
  const A10 = left0[1] - right0[1];
  const A11 = left0[3] - right0[3];
  const bx = right0[4] - left0[4];
  const by = right0[5] - left0[5];
  const det = A00 * A11 - A01 * A10;
  if (Math.abs(det) > 1e-6) {
    return [(A11 * bx - A01 * by) / det, (A00 * by - A10 * bx) / det];
  }
  if (Math.abs(A00) > 1e-6) return [bx / A00, 0];
  if (Math.abs(A01) > 1e-6) return [0, bx / A01];
  return [0, 0];
}

/**
 * Centre path from mirrored side clips: keep `left`'s scale/spin (so the
 * part stays visible) and average the world position of each part's rest
 * pivot. Used for ball `middle_goal` — the Lottie has no true centre clip.
 */
function synthesizeAverageBlendSegment(motion, name, leftName, rightName) {
  const left = motion.segments[leftName];
  const right = motion.segments[rightName];
  if (!left || !right) {
    throw new Error(
      `[bva] synthesizeSegments["${name}"]: need segments "${leftName}" and ` +
        `"${rightName}".`,
    );
  }
  if (left.frames !== right.frames) {
    throw new Error(
      `[bva] synthesizeSegments["${name}"]: "${leftName}" and "${rightName}" ` +
        `must share the same frame count.`,
    );
  }
  const rightByAsset = new Map(right.parts.map((p) => [p.asset, p]));
  const frames = left.frames;
  const parts = left.parts.map((lp) => {
    const rp = rightByAsset.get(lp.asset);
    if (!rp) {
      throw new Error(
        `[bva] synthesizeSegments["${name}"]: part "${lp.asset}" missing on ` +
          `"${rightName}".`,
      );
    }
    if (rp.matrices.length !== lp.matrices.length) {
      throw new Error(
        `[bva] synthesizeSegments["${name}"]: part "${lp.asset}" frame ` +
          `counts differ.`,
      );
    }
    const pivot = restPivot(lp.matrices[0], rp.matrices[0]);
    const matrices = lp.matrices.map((lm, f) => {
      const rm = rp.matrices[f];
      const lw = applyMatPoint(lm, pivot[0], pivot[1]);
      const rw = applyMatPoint(rm, pivot[0], pivot[1]);
      const wx = (lw[0] + rw[0]) / 2;
      const wy = (lw[1] + rw[1]) / 2;
      return roundMat([
        lm[0],
        lm[1],
        lm[2],
        lm[3],
        wx - (lm[0] * pivot[0] + lm[2] * pivot[1]),
        wy - (lm[1] * pivot[0] + lm[3] * pivot[1]),
      ]);
    });
    const out = { asset: lp.asset, matrices };
    if (lp.opacities) out.opacities = lp.opacities.slice();
    if (lp.fills) out.fills = lp.fills.slice();
    if (lp.strokes) out.strokes = lp.strokes.slice();
    return out;
  });
  motion.segments[name] = { frames, parts };
}

/**
 * Resolves a Lottie image asset id to a part name: the bare basename without
 * extension, optionally renamed through `cfg.imageParts`. The alias lets skin
 * folders use a neutral filename ("Gates.svg") while the Lottie keeps
 * whichever variant the animator happened to place ("Stadium gates.svg").
 */
function makeImageResolver(assetsById, aliases = null) {
  return (id) => {
    const a = assetsById[id];
    if (!a || !a.p) return null;
    const bn = String(a.p).replace(/\\/g, '/').split('/').pop();
    const name = bn.replace(/\.(png|jpg|jpeg|svg|webp)$/i, '');
    if (aliases && Object.prototype.hasOwnProperty.call(aliases, name)) {
      return aliases[name];
    }
    return name;
  };
}

/**
 * Lottie layer type ids we encounter inside segment precomps. The baker
 * understands:
 *   - PRECOMP (0)  segment-layer wrapper holding the animated transform.
 *   - NULL    (3)  transform-only parent (never renders).
 *   - SHAPE   (4)  "Shadow" (ellipse + fill → SVG part); stroke-mesh path
 *                  groups → Net_String / Net_Static parts; other shapes skipped.
 * Anything else (solid/text/…) fails the bake loudly.
 */
const LAYER_TY_PRECOMP = 0;
const LAYER_TY_IMAGE = 2;
const LAYER_TY_NULL = 3;
const LAYER_TY_SHAPE = 4;

/**
 * Find the idle `Face.svg` image layer (with its local transform). Action
 * segments reference shape-only "Face Animated*" precomps; we reuse this
 * leaf so the skinned Face part still tracks the head.
 */
function findFaceSvgImageLayer(assetsById) {
  let faceImgId = null;
  for (const [id, a] of Object.entries(assetsById)) {
    if (a?.p && /(?:^|\/)Face\.svg$/i.test(String(a.p).replace(/\\/g, '/'))) {
      faceImgId = id;
      break;
    }
  }
  if (faceImgId == null) return null;
  for (const a of Object.values(assetsById)) {
    if (!a?.layers) continue;
    for (const l of a.layers) {
      if (l.ty === LAYER_TY_IMAGE && String(l.refId) === String(faceImgId)) {
        return l;
      }
    }
  }
  return null;
}

function isFaceAnimatedPrecompName(name) {
  return /^face\b/i.test(String(name ?? '').trim());
}

/** Segment-layer precomp named Head (S_Head / ears live under it). */
function findHeadLayer(segPrecomp) {
  return (
    segPrecomp.layers.find(
      (l) => l.ty === LAYER_TY_PRECOMP && String(l.nm ?? '').trim() === 'Head',
    ) ?? null
  );
}

/**
 * Face.svg's own Lottie image-layer offset is paired with the idle Face
 * wrapper. When we parent the fallback to Head (so a null-Face track cannot
 * slide features off the skull), use the same local as S_Head.svg.
 */
function makeHeadAlignedFaceImageLayer(faceImageLayer) {
  return {
    ty: LAYER_TY_IMAGE,
    refId: faceImageLayer.refId,
    nm: faceImageLayer.nm ?? 'Face.svg',
    ks: {
      a: { a: 0, k: [1080, 1080] },
      p: { a: 0, k: [1080, 1080, 0] },
      s: { a: 0, k: [100, 100] },
      r: { a: 0, k: 0 },
      sa: { a: 0, k: 0 },
      o: { a: 0, k: 100 },
    },
  };
}

/**
 * Action comps in humanoid Lottie rigs often put Pelvis above Body and leave
 * the head stack under Body. Flattened to 2D that draws hip-joint circles on
 * the torso and hides Face when the character is horizontal. Re-assert
 * idle-like occlusion: Pelvis < Body < ears/head/hair/face, still under the
 * arms.
 *
 * Skipped when the same torso/head asset appears more than once (crowd /
 * multi-character scenes) so per-instance draw order stays intact.
 */
function fixCharacterOcclusionOrder(parts) {
  const names = [
    'Pelvis',
    'Body',
    'S_Ears',
    'S_Head',
    'Hairstyle',
    'Face',
  ];
  for (const name of names) {
    let count = 0;
    for (const p of parts) {
      if (p.assetName === name) count++;
      if (count > 1) return parts;
    }
  }
  const pulled = [];
  for (const name of names) {
    const i = parts.findIndex((p) => p.assetName === name);
    if (i >= 0) pulled.push(parts.splice(i, 1)[0]);
  }
  if (!pulled.length) return parts;

  let insertAt = parts.findIndex((p) =>
    /^(?:S_)?(?:Arm|Palm|Forearm)_/.test(p.assetName),
  );
  if (insertAt < 0) insertAt = parts.length;
  parts.splice(insertAt, 0, ...pulled);
  return parts;
}

/**
 * Walk the parent chain (within the segment precomp) of `layer`,
 * returning all layers from leaf -> root. Cycle-safe.
 */
function walkParentChain(layer, layerByInd) {
  const chain = [];
  const guard = new Set();
  let cur = layer;
  while (cur) {
    if (guard.has(cur.ind)) break;
    guard.add(cur.ind);
    chain.push(cur);
    if (cur.parent !== undefined && cur.parent !== null) {
      cur = layerByInd[cur.parent];
    } else {
      cur = null;
    }
  }
  return chain;
}

const LAYER_TY_NAME = {
  0: 'precomp',
  1: 'solid',
  2: 'image',
  3: 'null',
  4: 'shape',
  5: 'text',
};

function describeLayer(l) {
  const tyName = LAYER_TY_NAME[l.ty] ?? `ty=${l.ty}`;
  return `${tyName} layer "${l.nm ?? '(unnamed)'}" (ind=${l.ind})`;
}

/**
 * Lottie layer visibility: active on `[ip, op)`. Parenting only moves a
 * layer — it does not inherit in/out. A rig that hands a prop between two
 * precomps on consecutive ranges relies on this; without it both bake at
 * full opacity and the prop draws twice.
 */
function layerVisibleAt(layer, t) {
  const ip = layer.ip ?? 0;
  const op = layer.op ?? Number.POSITIVE_INFINITY;
  return t >= ip && t < op;
}

/**
 * A hand-off bakes the same image asset twice — a brief incoming instance
 * and the one that takes over. After per-frame ip/op opacity is applied,
 * keep paint order but merge same-asset streams so the runtime mounts one
 * part and picks the visible instance's matrix.
 *
 * Crowd / multi-character scenes intentionally emit many simultaneous
 * instances of Body/Face/… — leave those groups unmerged.
 */
function groupHasSimultaneousVisibility(group) {
  const frames = group[0]?.matrices?.length ?? 0;
  for (let f = 0; f < frames; f++) {
    let visible = 0;
    for (const p of group) {
      if ((p.opacities[f] ?? 1) > 0.001) {
        visible++;
        if (visible > 1) return true;
      }
    }
  }
  return false;
}

function coalesceDuplicateAssetParts(parts) {
  const groups = new Map();
  const order = [];
  for (const p of parts) {
    const key = p.assetName;
    if (!groups.has(key)) {
      groups.set(key, []);
      order.push(key);
    }
    groups.get(key).push(p);
  }

  const out = [];
  for (const key of order) {
    const group = groups.get(key);
    if (group.length === 1 || groupHasSimultaneousVisibility(group)) {
      out.push(...group);
      continue;
    }

    const frames = group[0].matrices.length;
    const matrices = new Array(frames);
    const opacities = new Array(frames);
    const hasFills = group.some((p) => p.fills);
    const hasStrokes = group.some((p) => p.strokes);
    const fills = hasFills ? new Array(frames) : null;
    const strokes = hasStrokes ? new Array(frames) : null;

    for (let f = 0; f < frames; f++) {
      let best = group[0];
      let bestO = best.opacities[f] ?? 1;
      for (let i = 1; i < group.length; i++) {
        const o = group[i].opacities[f] ?? 1;
        if (o > bestO) {
          best = group[i];
          bestO = o;
        }
      }
      matrices[f] = best.matrices[f];
      opacities[f] = bestO;
      if (fills) fills[f] = best.fills?.[f] ?? group[0].fills?.[f] ?? null;
      if (strokes) {
        strokes[f] = best.strokes?.[f] ?? group[0].strokes?.[f] ?? null;
      }
    }

    const merged = {
      kind: group[0].kind,
      assetName: key,
      matrices,
      opacities,
    };
    if (fills) merged.fills = fills;
    if (strokes) merged.strokes = strokes;
    out.push(merged);
  }
  return out;
}

function layerLabel(segLabel, l) {
  return `${describeLayer(l)} in segment "${segLabel}"`;
}

function staticTimeRemap(layer) {
  if (layer.tm == null || typeof layer.tm !== 'object') return null;
  const k = layer.tm.k;
  const tmTime = Array.isArray(k) ? Number(k[0]) : Number(k);
  return Number.isFinite(tmTime) ? tmTime : null;
}

function indexLayersByInd(layers) {
  const byInd = {};
  for (const layer of layers) {
    if (layer.ind !== undefined && layer.ind !== null) {
      byInd[layer.ind] = layer;
    }
  }
  return byInd;
}

/**
 * For one segment precomp, return an ordered list of renderable parts.
 *
 * Supports:
 *   - Flat rigs (a character or prop): segment → image-precomp → image leaf
 *   - Nested crowd rigs: segment → actor precomp → part precomp → image
 *
 * Image parts carry a `levels` transform stack (parent chains + precomp time
 * remaps) plus the leaf `imageLayer`. Shadow shape layers become parts with
 * `kind: 'shadow'`. Stroke-mesh shape layers become `kind: 'stroke'` parts.
 * Order is back-to-front in DOM terms.
 */
function collectParts(
  segPrecomp,
  segLabel,
  assetsById,
  resolveImage,
  synthesizedParts,
  strokePlan = null,
) {
  const parts = [];
  const segLayerByInd = indexLayersByInd(segPrecomp.layers);

  // Stroke meshes sit behind the frame image. Emit them first so DOM order
  // is mesh → image when the image leaf is pushed during visit.
  const { parts: strokeParts, strokeLayerInds } = collectStrokeParts(
    segPrecomp,
    segLabel,
    synthesizedParts,
    strokePlan,
  );
  for (const sp of strokeParts) {
    assertSupportedLayer(sp.layer, layerLabel(segLabel, sp.layer));
    parts.push(sp);
  }

  function visit(comp, levels, assetStack, tmTime) {
    const layerByInd = indexLayersByInd(comp.layers);

    for (let li = comp.layers.length - 1; li >= 0; li--) {
      const l = comp.layers[li];
      const label = layerLabel(segLabel, l);

      if (l.ty === LAYER_TY_NULL) {
        assertSupportedLayer(l, label);
        continue;
      }

      if (l.ty === LAYER_TY_SHAPE) {
        // Already consumed by collectStrokeParts (top-level stroke meshes).
        if (levels.length === 0 && strokeLayerInds.has(l.ind)) {
          continue;
        }
        if (levels.length === 0 && l.nm === SHADOW_ASSET_NAME) {
          assertSupportedLayer(l, label);
          const shadow = parseShadowLayer(l, label);
          rememberSynthesizedShadow(synthesizedParts, shadow);
          parts.push({
            kind: 'shadow',
            layer: l,
            assetName: SHADOW_ASSET_NAME,
            shadow,
          });
          continue;
        }
        console.warn(
          `[bva] Skipping unsupported ${label} ` +
            `(non-"${SHADOW_ASSET_NAME}" / non-stroke-mesh shape layers are ignored).`,
        );
        continue;
      }

      if (l.ty === LAYER_TY_IMAGE) {
        if (tmTime != null) {
          const ip = l.ip ?? 0;
          const op = l.op ?? Number.POSITIVE_INFINITY;
          if (tmTime < ip || tmTime >= op) continue;
        }
        assertSupportedLayer(l, label);
        const assetName = resolveImage(l.refId);
        if (!assetName) {
          throw new Error(
            `[bva] ${label} references unknown image asset "${l.refId}".`,
          );
        }
        // Parent nulls above the image go in `levels`. The image leaf itself
        // must NOT — evaluateImagePart applies imageLayer via innerChain, and
        // putting it in both doubles the transform.
        const ancestors = walkParentChain(l, layerByInd).reverse().slice(0, -1);
        const nextLevels =
          ancestors.length > 0
            ? [
                ...levels,
                {
                  chain: ancestors,
                  sourceLayer: null,
                },
              ]
            : levels;
        parts.push({
          kind: 'image',
          levels: nextLevels,
          imageLayer: l,
          imageLayerByInd: layerByInd,
          assetName,
        });
        continue;
      }

      if (l.ty !== LAYER_TY_PRECOMP) {
        throw new Error(
          `[bva] Not implemented: ${label}. ` +
            `Only nested precomps, image leaves, null parents, ` +
            `"${SHADOW_ASSET_NAME}" ellipse shape layers, and stroke-mesh ` +
            `shape layers are baked. ` +
            `Convert this layer to a precomp containing an image, or remove it.`,
        );
      }

      assertSupportedLayer(l, label);

      const childComp = assetsById[l.refId];
      if (!childComp || !childComp.layers) {
        throw new Error(
          `[bva] ${label} references missing precomp "${l.refId}".`,
        );
      }
      if (assetStack.has(l.refId)) {
        throw new Error(
          `[bva] Cyclic precomp reference "${l.refId}" in segment "${segLabel}".`,
        );
      }

      const level = {
        chain: walkParentChain(l, layerByInd).reverse(),
        sourceLayer: l,
      };
      const childTm = staticTimeRemap(l) ?? tmTime;
      const hasNestedPrecomp = childComp.layers.some(
        (child) => child.ty === LAYER_TY_PRECOMP,
      );

      if (hasNestedPrecomp) {
        const nextStack = new Set(assetStack);
        nextStack.add(l.refId);
        visit(childComp, [...levels, level], nextStack, childTm);
        continue;
      }

      let pushedImage = false;
      const imageLayerByInd = indexLayersByInd(childComp.layers);
      for (let ii = childComp.layers.length - 1; ii >= 0; ii--) {
        const imgLayer = childComp.layers[ii];
        const imgLabel =
          `${describeLayer(imgLayer)} inside precomp "${l.refId}" ` +
          `of segment "${segLabel}"`;

        if (imgLayer.ty !== LAYER_TY_IMAGE) {
          console.warn(
            `[bva] Skipping unsupported ${imgLabel}. ` +
              `Only image leaves inside segment precomps are baked.`,
          );
          continue;
        }

        if (childTm != null) {
          const ip = imgLayer.ip ?? 0;
          const op = imgLayer.op ?? Number.POSITIVE_INFINITY;
          if (childTm < ip || childTm >= op) continue;
        }

        assertSupportedLayer(imgLayer, imgLabel);

        const assetName = resolveImage(imgLayer.refId);
        if (!assetName) {
          throw new Error(
            `[bva] ${imgLabel} references unknown image asset "${imgLayer.refId}".`,
          );
        }

        parts.push({
          kind: 'image',
          levels: [...levels, level],
          imageLayer: imgLayer,
          imageLayerByInd,
          assetName,
        });
        pushedImage = true;
      }

      // Animated face comps are shape-only (eyes/brows morphs). Reuse Face.svg
      // parented to Head (not the animated Face null) so features stay on the
      // skull — the null-Face track would otherwise slide the static plate off.
      if (
        !pushedImage &&
        levels.length === 0 &&
        isFaceAnimatedPrecompName(l.nm)
      ) {
        const faceImageLayer = findFaceSvgImageLayer(assetsById);
        if (!faceImageLayer) {
          throw new Error(
            `[bva] ${label} has no image leaves and no Face.svg asset was ` +
              `found to use as a static face fallback.`,
          );
        }
        const headLayer = findHeadLayer(segPrecomp);
        if (!headLayer) {
          throw new Error(
            `[bva] ${label} is shape-only but segment "${segLabel}" has no ` +
              `Head precomp to attach a Face.svg fallback to.`,
          );
        }
        console.warn(
          `[bva] ${label} is shape-only; baking static Face.svg on Head.`,
        );
        parts.push({
          kind: 'image',
          levels: [
            {
              chain: walkParentChain(headLayer, segLayerByInd).reverse(),
              sourceLayer: headLayer,
            },
          ],
          imageLayer: makeHeadAlignedFaceImageLayer(faceImageLayer),
          imageLayerByInd: {},
          assetName: 'Face',
        });
      }
    }
  }

  visit(segPrecomp, [], new Set(), null);
  return fixCharacterOcclusionOrder(parts);
}

/** Evaluate nested precomp transform stack + image leaf for one frame. */
function evaluateImagePart(part, tSrc) {
  let acc = identity();
  let opacity = 1;
  let compTime = tSrc;

  for (const level of part.levels ?? []) {
    for (const layer of level.chain) {
      opacity *= layerVisibleAt(layer, compTime) ? 1 : 0;
      acc = mulMat(acc, buildLocal(layer.ks, compTime));
      opacity *= evalOpacity(layer.ks, compTime);
    }
    if (level.sourceLayer) {
      const stretch = level.sourceLayer.sr ?? 1;
      compTime = (compTime - (level.sourceLayer.st ?? 0)) / stretch;
    }
  }

  opacity *= layerVisibleAt(part.imageLayer, compTime) ? 1 : 0;
  const innerChain = walkParentChain(
    part.imageLayer,
    part.imageLayerByInd ?? {},
  );
  for (let i = innerChain.length - 1; i >= 0; i--) {
    acc = mulMat(acc, buildLocal(innerChain[i].ks, compTime));
    opacity *= evalOpacity(innerChain[i].ks, compTime);
  }

  return { matrix: roundMat(acc), opacity };
}

export async function bakeMotion(cfg, root) {
  const lottiePath = path.resolve(root, cfg.input);
  const lottie = JSON.parse(await fs.readFile(lottiePath, 'utf8'));
  const SRC_FPS = lottie.fr;
  const OUTPUT_FPS = cfg.fps ?? 24;

  if (lottie.ddd) {
    throw new Error(
      `[bva] Not implemented: 3D composition (ddd) in "${cfg.input}".`,
    );
  }

  const assetsById = {};
  for (const a of lottie.assets) assetsById[a.id] = a;
  const resolveImage = makeImageResolver(assetsById, cfg.imageParts);

  const motion = {
    fps: OUTPUT_FPS,
    srcFps: SRC_FPS,
    canvas: { w: lottie.w, h: lottie.h },
    stage: identity(),
    segments: {},
  };
  const synthesizedParts = {};

  // `null` in cfg.segments skips the layer. Use hasOwnProperty (not `??`)
  // so a mapped null is not replaced by sanitizeName.
  const segNameOf = (rawName) =>
    cfg.segments && Object.prototype.hasOwnProperty.call(cfg.segments, rawName)
      ? cfg.segments[rawName]
      : sanitizeName(rawName);

  // Stroke meshes are classified rig-wide before baking: whether a string is a
  // mover or belongs to a shared plate has to agree across every segment, so
  // it cannot be decided one segment at a time. Malformed segments are left
  // alone here — the main loop below reports them properly.
  const strokePlan = planStrokeNets(
    lottie.layers.flatMap((topLayer) => {
      const name = segNameOf(topLayer.nm);
      if (name == null || topLayer.ty !== LAYER_TY_PRECOMP) return [];
      const precomp = assetsById[topLayer.refId];
      if (!precomp?.layers) return [];
      return [{ name, precomp, stage: buildLocal(topLayer.ks, 0) }];
    }),
    {
      minMotionPx: cfg.strokes?.minMotionPx,
      curveTolerancePx: cfg.strokes?.curveTolerancePx,
      curveSegments: cfg.strokes?.curveSegments,
    },
  );

  let segCount = 0;
  for (const topLayer of lottie.layers) {
    const rawName = topLayer.nm;
    const segName = segNameOf(rawName);
    if (segName == null) continue;

    const topLabel = `top-level ${describeLayer(topLayer)} (segment "${segName}")`;

    if (topLayer.ty !== LAYER_TY_PRECOMP) {
      throw new Error(
        `[bva] Not implemented: ${topLabel} cannot be baked as a segment. ` +
          `Wrap it in a precomp or map "${rawName}" to null in cfg.segments to skip it.`,
      );
    }

    assertSupportedLayer(topLayer, topLabel);

    // Stage transform is a single static matrix for the whole rig. Animated
    // root placement is not represented in the .bva stream.
    const rootAnim = ['a', 'p', 'r', 's', 'sa'].some(
      (k) => topLayer.ks?.[k]?.a === 1,
    );
    if (rootAnim) {
      throw new Error(
        `[bva] Not implemented: animated stage transform on ${topLabel}. ` +
          `Segment root transforms must be static (they become the rig stage matrix).`,
      );
    }

    const segPrecomp = assetsById[topLayer.refId];
    if (!segPrecomp || !segPrecomp.layers) {
      throw new Error(
        `[bva] ${topLabel} references missing precomp "${topLayer.refId}".`,
      );
    }

    const stage = roundMat(buildLocal(topLayer.ks, 0));
    // First valid segment doubles as the default stage. Every later segment
    // must share that same static stage or the bake would pick one silently.
    if (segCount === 0) {
      motion.stage = stage;
    } else if (!matricesEqual(stage, motion.stage)) {
      throw new Error(
        `[bva] Not implemented: differing stage transforms across segments ` +
          `(${topLabel} disagrees with the first baked segment). ` +
          `All segment roots must share one static stage matrix.`,
      );
    }
    segCount++;

    const durFramesSrc = topLayer.op - topLayer.ip;
    const durFramesOut = Math.max(
      1,
      Math.round((durFramesSrc * OUTPUT_FPS) / SRC_FPS),
    );

    const layerByInd = {};
    for (const l of segPrecomp.layers) layerByInd[l.ind] = l;

    const parts = collectParts(
      segPrecomp,
      segName,
      assetsById,
      resolveImage,
      synthesizedParts,
      strokePlan,
    );
    for (const p of parts) {
      p.matrices = new Array(durFramesOut);
      p.opacities = new Array(durFramesOut);
      if (p.kind === 'shadow') {
        if (p.shadow.fillColorAnimated) {
          p.fills = new Array(durFramesOut);
        }
        if (p.shadow.strokeRgb) {
          p.strokes = new Array(durFramesOut);
        }
      }
    }

    for (let f = 0; f < durFramesOut; f++) {
      const tSrc = (f * SRC_FPS) / OUTPUT_FPS;
      for (const p of parts) {
        if (p.kind === 'shadow') {
          const chain = walkParentChain(p.layer, layerByInd);
          let acc = identity();
          let opacity = layerVisibleAt(p.layer, tSrc) ? 1 : 0;
          for (let i = chain.length - 1; i >= 0; i--) {
            acc = mulMat(acc, buildLocal(chain[i].ks, tSrc));
            opacity *= evalOpacity(chain[i].ks, tSrc);
          }
          acc = mulMat(acc, buildLocal(p.shadow.groupKs, tSrc));
          opacity *= evalOpacity(p.shadow.groupKs, tSrc);
          opacity *= p.shadow.fillOpacity;
          opacity *= p.shadow.strokeOpacity;
          acc = mulMat(acc, buildShadowLocal(p.shadow, tSrc));
          if (p.fills) p.fills[f] = evalShadowFill(p.shadow, tSrc);
          if (p.strokes) p.strokes[f] = evalShadowStroke(p.shadow, tSrc);
          p.matrices[f] = roundMat(acc);
          p.opacities[f] = opacity;
        } else if (p.kind === 'stroke') {
          const chain = walkParentChain(p.layer, layerByInd);
          let segChain = identity();
          let opacity = layerVisibleAt(p.layer, tSrc) ? 1 : 0;
          for (let i = chain.length - 1; i >= 0; i--) {
            segChain = mulMat(segChain, buildLocal(chain[i].ks, tSrc));
            opacity *= evalOpacity(chain[i].ks, tSrc);
          }
          const evaluated = evalStrokeMatrix(p.stroke, segChain, tSrc);
          opacity *= evaluated.opacity;
          p.matrices[f] = roundMat(evaluated.matrix);
          p.opacities[f] = opacity;
        } else {
          const evaluated = evaluateImagePart(p, tSrc);
          p.matrices[f] = evaluated.matrix;
          p.opacities[f] = evaluated.opacity;
        }
      }
    }

    const coalesced = coalesceDuplicateAssetParts(parts);
    motion.segments[segName] = {
      frames: durFramesOut,
      parts: coalesced.map((p) => {
        const out = {
          asset: p.assetName,
          matrices: p.matrices,
          opacities: p.opacities,
        };
        const fills = stripConstantColorChannel(p.fills);
        const strokes = stripConstantColorChannel(p.strokes);
        if (fills) out.fills = fills;
        if (strokes) out.strokes = strokes;
        return out;
      }),
    };
  }

  if (cfg.synthesizeSegments && typeof cfg.synthesizeSegments === 'object') {
    for (const [name, spec] of Object.entries(cfg.synthesizeSegments)) {
      if (!spec || typeof spec !== 'object') continue;
      if (spec.mode === 'mirrorBlend') {
        if (motion.segments[name]) {
          throw new Error(
            `[bva] synthesizeSegments["${name}"] collides with a baked segment.`,
          );
        }
        if (!spec.left || !spec.right) {
          throw new Error(
            `[bva] synthesizeSegments["${name}"]: mirrorBlend needs "left" ` +
              `and "right" segment names.`,
          );
        }
        synthesizeMirrorBlendSegment(motion, name, spec.left, spec.right);
      } else if (spec.mode === 'averageBlend') {
        if (motion.segments[name]) {
          throw new Error(
            `[bva] synthesizeSegments["${name}"] collides with a baked segment.`,
          );
        }
        if (!spec.left || !spec.right) {
          throw new Error(
            `[bva] synthesizeSegments["${name}"]: averageBlend needs "left" ` +
              `and "right" segment names.`,
          );
        }
        synthesizeAverageBlendSegment(motion, name, spec.left, spec.right);
      } else {
        throw new Error(
          `[bva] synthesizeSegments["${name}"]: unknown mode "${spec.mode}".`,
        );
      }
    }
  }

  if (cfg.segmentAliases && typeof cfg.segmentAliases === 'object') {
    const aliases = {};
    for (const [alias, target] of Object.entries(cfg.segmentAliases)) {
      if (!motion.segments[target]) {
        throw new Error(
          `[bva] segmentAliases["${alias}"] → "${target}" but segment ` +
            `"${target}" was not baked.`,
        );
      }
      aliases[alias] = target;
    }
    if (Object.keys(aliases).length > 0) {
      motion.aliases = aliases;
    }
  }

  return { motion, synthesizedParts };
}
