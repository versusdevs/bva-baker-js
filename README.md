# bva-baker-js

## What is BVA?

**Baked Vector Animation (BVA)** is a two-stage pipeline for vector animation: **bake once**, then **play cheap**.

Lottie describes *how* to compute an animation — keyframes, easing, parented transform chains, nested precomps — and a Lottie runtime redoes that math on every frame, for every property, for every instance on screen. BVA moves all of it to build time. The baker evaluates the Lottie once, collapses each part's whole parent chain into a single 2D affine matrix per frame, and writes the result out. What ships to the browser is the cheapest useful representation of the same motion: **matrices + opacity + inlined SVG**.

The runtime cost per frame is then one `transform` attribute write per part. No keyframe interpolation, no layer-tree composition, no animation engine. That matters most at game scale — many instances on screen, tight frame budgets, and one shared motion reused across many visual skins.

A baked rig is two files:

- **`<name>.bva`** — the motion. A compact text stream of per-frame matrices (plus optional opacity / fill / stroke), delta- and run-length-encoded.
- **`assets/<name>.svg.json`** — the looks. One *layer* file holding shared geometry in `skins._common`, named visual variants as attribute diffs, and `$var` placeholders for play-time colour overrides.

Splitting them this way is the point: motion is baked once and reused, while skins and colours swap at play time without a re-bake and without restarting playback.

**Trade-off:** everything is resolved at bake time, so a `.bva` cannot do what a matrix cannot express. Vertex-level path morphs, masks, track mattes, effects, time remapping, and 3D are not supported — the baker rejects them loudly rather than baking something subtly wrong. Reach for Lottie when you need those; reach for BVA when you need the same motion drawn many times, cheaply.

This package is the **baker** (build time). The runtime half is [`bva-player-react`](../bva-player-react).

## This package

Pre-renders Lottie rigs into a compact runtime format made of two parts:

- a `.bva` text stream of per-frame 2D affine matrices plus optional opacity / fill / stroke (one set per part, per frame), and
- one `<name>.svg.json` **layer** file holding shared geometry in `skins._common`, named visual variants as attribute diffs, and optional `$var` placeholders.

At runtime `BakedVectorPlayer` from `bva-player-react` mounts a single `<svg>` per instance with one `<g transform="matrix(...)">` per part and rewrites `transform` / `opacity` / optional paint attrs on every frame. No Lottie math, no per-property keyframe evaluation, no per-part HTTP fetches.

## Quick start

```bash
# From a project that depends on this package
npx bva-bake path/to/config.json

# Multiple rigs in one run
npx bva-bake configs/character.json configs/prop.json
```

Direct CLI:

```bash
node index.mjs <config.json> [<config2.json> ...]
```

Config paths (`input`, `output`, `assets[].dir`) are resolved relative to the current working directory.

Each config bakes one rig into:

```
<output>/
  <name>.bva              # compact text motion stream
  assets/
    <name>.svg.json       # one layer file (skins._common + skin diffs)
    <name>.rasters/       # WebP of each part at screen-density 1x / 2x / 3x
```

## Pipeline

| stage  | input                          | module                | output                     |
|--------|---------------------------------|-----------------------|----------------------------|
| motion | Lottie JSON (`cfg.input`)       | `lib/bake-motion.mjs` | `MotionData` (segments + matrices + opacities) |
| encode | `MotionData`                    | `lib/motion-text.mjs` | `<name>.bva` text stream   |
| skins  | folders of `*.svg` (`cfg.assets`) | `lib/bake-skins.mjs`  | `assets/<name>.svg.json`   |
| raster | resolved layer parts + motion     | `lib/bake-raster.mjs` | `assets/<name>.rasters/` screen-density 1x/2x/3x WebP |

The motion stage walks every top-level Lottie layer (each becomes a "segment"), then for each segment walks the parent transform chain at every output frame and collapses it down to a single matrix (and multiplied opacity) per renderable image-layer ("part"). The skins stage parses each input SVG folder as a named skin, auto-diffs shared geometry into `skins._common`, and emits per-skin attribute overlays.

## Config schema

```jsonc
{
  "name":   "character",                       // rig label → .bva + layer filename
  "input":  "path/to/animation.json",          // Lottie source
  "output": "path/to/bva/character",           // output directory
  "fps":    24,                                // optional, default 24

  // Optional: rename top-level Lottie layers to compact segment keys.
  // If omitted, sanitised Lottie layer names are used.
  "segments": {
    "Character_Idle":      "idle",
    "Character_Jump Left": "jump_left"
  },

  // Optional: bake folders of SVGs into one layer JSON. Each entry
  // discovers subfolders under `dir`; folders become named skins and
  // shared geometry is auto-diffed into skins._common. If no subfolders
  // match, `dir` itself is treated as a single skin.
  "assets": [
    {
      "dir":     "path/to/Skins",
      "pattern": "Skin_*",        // optional glob/regex; default = all subdirs
      "subdir":  "SVG",           // optional; read *.svg from dir/<skin>/SVG/
      "include": ["*.svg"]        // optional; default = "*.svg"
    }
  ],

  // Optional: empty named skins when part artwork lives outside the layer
  // (e.g. a prop frame drawn as a static scene image).
  "skinStubs": ["Frame_Day", "Frame_Night"],

  // Optional: raster each resolved part to lossless WebP. Default [1, 2, 3];
  // set `false` to skip. SVG in the layer file is unchanged.
  "raster": { "scales": [1, 2, 3] }
}
```

See `configs/shadow-ellipse.json` for a complete working example that bakes against the checked-in fixture. Configs for your own rigs belong in your project, not in this package.

## Lottie input requirements

The baker is intentionally strict so the runtime never receives a silently truncated rig. It will throw a **not implemented** error if it sees a layer or feature it can't represent — it will not bake past it.

- Each top-level layer must be a **precomp** (one segment per layer).
- Inside a segment precomp, every renderable layer must itself be a **precomp wrapping a single image leaf**. Null layers used as transform-only parents are allowed (they never render).
- Exception: a shape layer named **`Shadow`** that is a single ellipse + fill (optional stroke + group transform) is auto-baked. Ellipse size animation is folded into scale; a shared `Shadow` SVG part is synthesized into `skins._common` (a hand-authored `Shadow.svg` in a skin folder wins). Animated Shadow fill / stroke colours become per-frame `f` / `s` suffixes in the `.bva` stream; constant colours stay in the SVG only.
- Exception: shape-only precomps whose name starts with **`Face`** (e.g. “Face Animated*” comps holding eye / brow morphs) fall back to the rig’s `Face.svg` image leaf, parented to **Head**, so facial features stay on the skull without baking path morphs.
- After collecting parts, paint order is normalized so Pelvis sits under Body and the head stack (ears / head / hair / face) sits above Body (still under arms). Action comps otherwise leave hip-joint circles on the torso and hide Face while the character is horizontal.
- Image references must resolve to an asset in the Lottie `assets` table.
- **2D transform** channels and **opacity** are baked into the `.bva` stream (anchor / position / rotation / scale / skew-angle → matrix; opacity chain → 0–1 factor). Layer in/out points (`ip` / `op`) zero opacity outside `[ip, op)` for both the segment-level precomp and each image leaf (on the precomp clock `t - st`). That keeps multi-leaf spins (`Phase_*` frames of one prop) from stacking. Same-asset duplicates are then coalesced into one part (e.g. a prop handed between two instances on consecutive ranges). Layer blend modes (`bm`) are ignored (treated as Normal). Unsupported features fail the bake, including: masks / track mattes, effects, time remapping, time stretch, auto-orient, 3D (ddd / rx / ry / rz / orientation), skew-axis, separated position dimensions, animated or differing stage transforms, and other non-precomp layer types (solid / text / non-Shadow shapes).

Either restructure the Lottie source or map the offending top-level layer to `null` in `cfg.segments` to skip it.

## `.bva` text format

A hand-rolled compact text encoding tuned for delta-heavy per-frame matrix streams. Files start with a `##version <N>` header; the runtime checks it against `BVA_VERSION` in `bva-player-react` and refuses payloads it doesn't understand. Current version: **3**.

A whole (tiny) file, one part in two segments:

```text
##version
3
#fps
24
#srcFps
30
#canvas
1200,675
#stage
1,0,0,1,0,0
#segments
##idle
###parts
####Base
833.24,827.41,.27,0,0,.27
*23
##jump
###parts
####Base
833.24,827.41,.27,0,0,.27
836.19
..75
o.5
*4
```

Reading it top to bottom:

- Headers come first: the playback `fps`, the `srcFps` it was resampled from, the authoring `canvas` size, and the `stage` matrix that places the whole rig on that canvas.
- `##idle` and `##jump` are segments; `####Base` is a part inside one. Every line after a part header is one frame.
- `833.24,827.41,.27,0,0,.27` is the first frame's full matrix — but written **reversed**, so it reads `f,e,d,c,b,a` and means `matrix(.27, 0, 0, .27, 827.41, 833.24)`. Translate changes every frame and rotation usually doesn't, so putting translate first turns a run of empty leading columns into a trimmable trailing one.
- `*23` fills out the rest of `idle`: the previous frame repeated 23 more times, 24 frames in total.
- `836.19` is a frame where only the first column changed. The other five are unchanged, so they are blank and the trailing blanks are dropped entirely.
- `..75` is the same column again, now `836.75`. The integer part matches the previous frame, so it collapses to a leading `.`.
- `o.5` is a frame with no matrix change at all, only opacity dropping to `0.5`.

Highlights of the encoding (full spec lives in `lib/motion-text.mjs`):

- Numeric matrix values are floored to 3 decimals and serialised with the redundant leading `0` stripped (`0.98` → `.98`, `-0.17` → `-.17`).
- Each matrix column is delta-encoded against the previous frame; an unchanged column is left blank, and an unchanged integer prefix collapses to a single `.` (`595.68` after `595.28` → `..68`).
- The six matrix fields per frame are written **reversed** so the noisy translate columns lead and the mostly-static rotation columns trail, then trailing blanks are trimmed. A frame with no matrix changes becomes an empty matrix CSV.
- Optional glued suffixes follow in fixed order — opacity, fill, stroke: `<matrix>[o<opacity>][f<hex>][s<hex>]`. Opacity (0–1, floored to 2 decimals) when it differs from the previous frame (or on the first frame when ≠ 1): `827.41,833.24,.27,0,0,.27o.23`, or `o.5` when only opacity changes. Fill / stroke are uppercase hex with no `#` (6 digits, or 3 when each channel pair matches), emitted when that channel is active and the colour changed (always on the first active frame): `…o.23fF1F1F1`, `fABC`, `o.5s000`. Unchanged channels omit their suffix.
- Two or more consecutive all-repeat frames (matrix **and** opacity **and** fill **and** stroke unchanged) are run-length encoded as `*N`. A lone repeat stays empty.

> When changing the wire format in a non-additive way, bump `BVA_VERSION` in **both** `lib/motion-text.mjs` and `bva-player-react`.

## Layer bundles

Each `<name>.svg.json` layer file looks roughly like:

```jsonc
{
  "name": "character",
  "defaults": { "viewBox": "0 0 200 400", "width": 200, "height": 400 },
  "variables": {},
  "skins": {
    "_common": {
      "S_Head": {
        "body": [
          { "_tag": "path", "d": "M…", "fill": "#db8f7d" }
        ]
      }
    },
    "Skin_1": {
      "S_Head": {
        "body": [{ "fill": "#f0ab9a" }]
      }
    }
  }
}
```

Merge rules at play time: resolve skin `S` as `_common` overlaid by `skins[S]`. Body elements merge by index; skin entries may omit `_tag` and unchanged attrs. After bake, authors may rewrite selected attrs to `$var` and fill `variables` defaults; the player substitutes play-time overrides.

The baker also writes `assets/<name>.rasters/` — lossless WebP sidecars of each resolved part at 1x, 2x, and 3x. Those are screen-density variants of the posed on-field CSS size (stage × max part scale at field 1:1), cropped to opaque ink — not 1 / 2 / 3 pixels per viewBox unit. A `rasters` block on the layer file records `format`, `scales`, `dir`, `units` (1x pixels per local unit, per part), and per-part crop rectangles (`x`/`y`/`w`/`h` in local viewBox units) so a later player can place `<image>` and pick a density with `fit × dpr × placement`. Playback still uses the SVG `body`. Set `raster: false` in the config to skip.

Body elements may include a meta `render` field (boolean or `$var`, default `true` when omitted). The player never writes it to SVG; when it resolves falsy the element is skipped. This lets one part hold several alternate shapes (e.g. hairstyles) selected via variables.

The SVG parser is a tiny regex pair that only handles flat self-closing primitive tags (`path`, `rect`, `circle`, `line`, `ellipse`, `polygon`, `polyline`); wrapper `<svg>` / `<g>` elements are stripped. Source SVGs must come out of the design tool already flattened to that shape.

## Layout

```
bva-baker-js/
  index.mjs              # CLI entry point (`bva-bake`)
  configs/
    shadow-ellipse.json  # fixture config (your own configs live in your project)
  lib/
    bake-motion.mjs      # Lottie -> MotionData
    bake-shadow.mjs      # Shadow ellipse shape -> SVG part + size→scale
    bake-skins.mjs       # SVG folders -> layer bundle (auto-diff)
    bake-raster.mjs      # resolved parts -> 1x/2x/3x WebP sidecars
    bake-strokes.mjs     # stroke-mesh shape layers -> Net_* parts
    motion-text.mjs      # MotionData -> .bva text encoder
    assert-supported.mjs # refuse unsupported Lottie features
    lottie-eval.mjs      # minimal Lottie keyframe evaluator
    matrix.mjs           # 2D affine matrix helpers
    naming.mjs           # sanitise / sort / glob helpers
    svg-parse.mjs        # minimal SVG inner-element parser
  fixtures/
    shadow-ellipse.json  # minimal Shadow bake fixture
```


## Adding a new rig

1. Drop the Lottie export and skin SVG folders into your project.
2. Add a config JSON describing the input, output, and segment / asset mapping.
3. Run `npx bva-bake path/to/config.json` from the project root.
4. Point a `BakedVectorPlayer` / `<BvaPlayer>` at the resulting `<output>` directory.
