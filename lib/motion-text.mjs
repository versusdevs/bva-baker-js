/**
 * Encoder for the `.bva` text format used to ship baked motion data to the
 * runtime. It's a hand-rolled compact text encoding tuned for delta-heavy
 * per-frame matrix streams (plus optional per-frame opacity / fill / stroke
 * suffixes).
 *
 * Files start with a `##version <N>` header so the runtime can refuse
 * payloads it doesn't understand. Bump `BVA_VERSION` whenever the wire
 * format changes in a non-additive way.
 *
 * Encoding rules:
 *
 *   1. Numeric values are floored to N decimals (default 3 for matrices,
 *      2 for opacity), then serialised with the redundant leading "0"
 *      stripped:
 *        0.98  -> ".98"
 *        -0.17 -> "-.17"
 *        720.0 -> "720"
 *      Negative zero is normalised to "0".
 *
 *   2. Within a single part's frame stream each matrix position is compared
 *      against the same position in the previous frame. If unchanged the
 *      field is left blank. If only the fractional part changed AND the
 *      previous frame's integer part is a positive non-zero integer, the
 *      integer prefix is replaced with a single ".":
 *        595.68 (prev 595.28) -> "..68"
 *        720.7  (prev 720)    -> "..7"
 *      Negative or zero-integer values are left as-is so the parser can stay
 *      single-pass.
 *
 *   3. Each frame's six fields are written REVERSED (column 5 first,
 *      column 0 last) and trailing blanks are trimmed. Translate columns
 *      (4,5) change every frame and rotation columns (0..3) usually don't,
 *      so reversing turns the long ",,,," prefix into a trimmable suffix.
 *      A frame whose six values all match the previous frame is written as
 *      an empty line (before any paint suffixes).
 *
 *   4. Optional glued suffixes follow the matrix CSV with no commas, in
 *      fixed order — opacity, then fill, then stroke:
 *        <matrix>[o<opacity>][f<hex>][s<hex>]
 *      Opacity (0–1) is emitted when it differs from the previous frame
 *      (or on the first frame when ≠ 1):
 *        827.41,833.24,.27,0,0,.27o.23
 *        o.5          ← matrix unchanged, opacity changed
 *      Fill / stroke are uppercase hex with no `#` — 6 digits, or 3 when
 *      each channel pair matches (FF0000 → F00). Emitted when that channel
 *      is active for the part and the colour differs from the previous
 *      frame (always on the first frame when active):
 *        827.41,833.24,.27,0,0,.27o.23fF1F1F1
 *        fABC         ← matrix + opacity unchanged, fill #AABBCC
 *        o.5s000      ← opacity + stroke #000000
 *      Unchanged channels omit their suffix. Opacity uses the same fmt /
 *      compressIntPrefix rules, floored to 2 decimals.
 *
 *   5. Two or more consecutive "all-repeat" frames (matrix AND opacity
 *      AND fill AND stroke unchanged) are collapsed into a single `*N`
 *      line (run-length encoding). A lone repeat stays as an empty line
 *      because `*1` would be longer.
 *
 *   6. Per-segment frame counts are NOT written; the runtime derives them
 *      from the number of frames produced for the first part.
 *
 *      Example file shape:
 *
 *        #fps
 *        24
 *        #srcFps
 *        30
 *        #canvas
 *        1920,1080
 *        #stage
 *        1,0,0,1,0,0
 *        #segments
 *        ##idle
 *        ###parts
 *        ####S_Ankle_R
 *        720.7,1041.67,.98,.17,-.17,.98
 *        1041.66
 *        *19
 */

export const BVA_VERSION = 3;

const DEFAULT_DECIMALS = 3;
const OPACITY_DECIMALS = 2;

/**
 * Truncate `v` toward zero to `decimals` decimals. Truncation (not round)
 * keeps delta encoding stable when a value straddles a bucket boundary, and
 * unlike `Math.floor` it treats ±x symmetrically — important for mirrored
 * net layers whose scale is ±1.16976 (floor would yield 1.169 vs -1.17).
 */
function roundDown(v, decimals) {
  const f = Math.pow(10, decimals);
  const r = Math.trunc(v * f) / f;
  return Object.is(r, -0) ? 0 : r;
}

function fmt(v) {
  let s = String(v);
  if (s.startsWith('0.')) s = s.slice(1);
  else if (s.startsWith('-0.')) s = '-' + s.slice(2);
  return s;
}

/**
 * Normalise a colour to wire hex (no `#`, uppercase): 6 digits, or 3 when
 * each channel pair matches (`#FF0000` / `F00` → `F00`, `#AABBCC` → `ABC`).
 */
function fmtHex(color) {
  let s = String(color);
  if (s.charCodeAt(0) === 35 /* '#' */) s = s.slice(1);
  s = s.toUpperCase();
  if (s.length === 3) return s;
  if (
    s.length === 6 &&
    s[0] === s[1] &&
    s[2] === s[3] &&
    s[4] === s[5]
  ) {
    return s[0] + s[2] + s[4];
  }
  return s;
}

/**
 * Collapse runs of >=2 consecutive empty lines into a single `*N` line.
 * A lone empty line stays empty because "*1" is one byte longer.
 */
function rleEmptyLines(lines) {
  const out = [];
  let runStart = -1;
  for (let i = 0; i <= lines.length; i++) {
    const isEmpty = i < lines.length && lines[i] === '';
    if (isEmpty) {
      if (runStart === -1) runStart = i;
      continue;
    }
    if (runStart !== -1) {
      const runLen = i - runStart;
      if (runLen >= 2) out.push(`*${runLen}`);
      else out.push('');
      runStart = -1;
    }
    if (i < lines.length) out.push(lines[i]);
  }
  return out;
}

/**
 * If a column's integer part is unchanged from the previous frame and is a
 * positive non-zero integer, replace the integer prefix with a single dot.
 * Skipped when:
 *   - prev is null (first frame),
 *   - the field has no fractional part,
 *   - the field is negative ("-..68" would be ambiguous),
 *   - the integer part is 0 (already encoded as ".68" / "-.17").
 */
function compressIntPrefix(field, prevVal) {
  if (field === '' || field.charCodeAt(0) === 45 /* '-' */) return field;
  const dot = field.indexOf('.');
  if (dot <= 0) return field;
  const prevInt = Math.trunc(prevVal);
  if (prevInt <= 0) return field;
  if (field.slice(0, dot) !== String(prevInt)) return field;
  return '.' + field.slice(dot);
}

/** True when every frame carries the exact same matrix. */
function matrixStreamIsConstant(matrices) {
  const first = matrices[0];
  if (!first) return true;
  for (let i = 1; i < matrices.length; i++) {
    const m = matrices[i];
    for (let c = 0; c < 6; c++) {
      if (m[c] !== first[c]) return false;
    }
  }
  return true;
}

function encodePart(matrices, opacities, decimals, fills, strokes) {
  const lines = [];
  let prev = null;
  let prevOpacity = null;
  let prevFill = null;
  let prevStroke = null;
  const hasFills = Array.isArray(fills);
  const hasStrokes = Array.isArray(strokes);

  for (let fi = 0; fi < matrices.length; fi++) {
    const raw = matrices[fi];
    const m = raw.map((v) => roundDown(v, decimals));
    const rawO = opacities ? opacities[fi] : 1;
    const opacity = roundDown(rawO == null ? 1 : rawO, OPACITY_DECIMALS);

    const fields =
      prev === null
        ? m.map(fmt)
        : m.map((v, i) =>
            v === prev[i] ? '' : compressIntPrefix(fmt(v), prev[i]),
          );

    fields.reverse();

    let end = fields.length;
    while (end > 0 && fields[end - 1] === '') end--;
    let line = fields.slice(0, end).join(',');

    const opacityChanged =
      prevOpacity === null ? opacity !== 1 : opacity !== prevOpacity;
    if (opacityChanged) {
      const oField =
        prevOpacity === null
          ? fmt(opacity)
          : compressIntPrefix(fmt(opacity), prevOpacity);
      line += 'o' + oField;
    }

    if (hasFills) {
      const fill = fmtHex(fills[fi]);
      if (prevFill === null || fill !== prevFill) {
        line += 'f' + fill;
      }
      prevFill = fill;
    }

    if (hasStrokes) {
      const stroke = fmtHex(strokes[fi]);
      if (prevStroke === null || stroke !== prevStroke) {
        line += 's' + stroke;
      }
      prevStroke = stroke;
    }

    lines.push(line);

    prev = m;
    prevOpacity = opacity;
  }

  return rleEmptyLines(lines).join('\n');
}

/**
 * Encode a MotionData object into the `.bva` text format. Returns the file
 * contents as a string with a trailing newline.
 *
 * `decimals` controls how many fractional digits per matrix entry survive
 * the floor in `roundDown`. Lower values shrink the file; higher values
 * preserve sub-pixel motion. Defaults to 3. Opacity always uses 2 decimals.
 * The stage, and any part whose matrix never changes, always keep at least
 * the default precision: they cost one line each, so degrading them only
 * loses accuracy.
 */
export function encodeMotionText(motion, { decimals = DEFAULT_DECIMALS } = {}) {
  const out = [];

  // Version is the very first line so the runtime can fail fast on payloads
  // it doesn't understand without parsing the rest of the file.
  out.push('##version');
  out.push(String(BVA_VERSION));

  out.push('#fps');
  out.push(String(motion.fps));

  if (motion.srcFps != null) {
    out.push('#srcFps');
    out.push(String(motion.srcFps));
  }

  out.push('#canvas');
  out.push(`${motion.canvas.w},${motion.canvas.h}`);

  // The stage is one line for the whole rig, so it always keeps full
  // precision: a coarse `decimals` chosen to shrink the per-frame streams
  // would otherwise resize the entire rig (0.625 → 0.6 at one decimal).
  const stageDecimals = Math.max(decimals, DEFAULT_DECIMALS);
  out.push('#stage');
  out.push(
    motion.stage.map((v) => roundDown(v, stageDecimals)).map(fmt).join(','),
  );

  // Additive: unknown `#tag` lines are skipped by older players together
  // with their value line, so aliases need no version bump.
  if (motion.aliases && typeof motion.aliases === 'object') {
    const pairs = Object.entries(motion.aliases)
      .map(([alias, target]) => `${alias}=${target}`)
      .join(',');
    if (pairs) {
      out.push('#aliases');
      out.push(pairs);
    }
  }

  out.push('#segments');
  for (const [segName, seg] of Object.entries(motion.segments)) {
    out.push(`##${segName}`);
    out.push('###parts');
    for (const part of seg.parts) {
      out.push(`####${part.asset}`);
      // A part that never moves writes a single matrix line, so coarse
      // `decimals` buys nothing there while still distorting it — and a
      // constant matrix is exactly the case that carries whole plates of
      // artwork, where a hundredth in the scale column is pixels on screen.
      const partDecimals = matrixStreamIsConstant(part.matrices)
        ? stageDecimals
        : decimals;
      out.push(
        encodePart(
          part.matrices,
          part.opacities,
          partDecimals,
          part.fills,
          part.strokes,
        ),
      );
    }
  }

  return out.join('\n') + '\n';
}
