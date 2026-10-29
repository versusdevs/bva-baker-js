/**
 * Tiny SVG inner-element parser for the skin pipeline.
 *
 * Produces a tree of `{_tag, ...attrs, _children?}` objects. Container tags
 * (`defs`, `filter`, `mask`, `clipPath`, paint servers, and presentation-bearing `g`) keep
 * their children so luminosity masks / filters survive bake + runtime
 * serialization. Pure grouping `<g>` wrappers (id/class only) are flattened.
 *
 * The runtime decoder serialises the tree back to markup with nested tags.
 */

const ATTR_RE = /([a-zA-Z_:][\w:.-]*)="([^"]*)"/g

/**
 * Tags that may legally contain child elements we need to preserve.
 * Looked up with `tag.toLowerCase()`, so entries must be lowercase
 * (`clippath`, not `clipPath`) — otherwise paint servers flatten and
 * fills like `url(#shell)` bake to an empty disc.
 */
const CONTAINER_TAGS = new Set([
  'defs',
  'filter',
  'mask',
  'clippath',
  'g',
  'lineargradient',
  'radialgradient',
])

/** Attrs that make a `<g>` meaningful (must not be flattened away). */
const GROUP_KEEP_ATTRS = new Set([
  'mask',
  'filter',
  'transform',
  'opacity',
  'fill',
  'stroke',
  'clip-path',
  'style',
])

function parseAttrs(attrText) {
  const obj = {}
  if (!attrText) return obj
  ATTR_RE.lastIndex = 0
  let am
  while ((am = ATTR_RE.exec(attrText))) {
    if (am[1] === 'xmlns') continue
    obj[am[1]] = am[2]
  }
  return obj
}

function skipNoise(html, i) {
  const n = html.length
  while (i < n) {
    if (/\s/.test(html[i])) {
      i++
      continue
    }
    if (html.startsWith('<!--', i)) {
      const end = html.indexOf('-->', i + 4)
      i = end === -1 ? n : end + 3
      continue
    }
    break
  }
  return i
}

/**
 * Parse an SVG fragment into a flat-ish element tree.
 * Pure grouping `<g>` nodes are hoisted; presentation `<g>` / defs / mask /
 * filter containers retain `_children`.
 */
export function parseSvgElements(html) {
  const { nodes } = parseNodes(html, 0, null)
  return nodes
}

function parseNodes(html, start, stopTag) {
  const nodes = []
  let i = start
  const n = html.length

  while (i < n) {
    i = skipNoise(html, i)
    if (i >= n) break

    if (html[i] !== '<') {
      // Text content is unused by the skin pipeline — skip until next tag.
      const next = html.indexOf('<', i)
      i = next === -1 ? n : next
      continue
    }

    if (html.startsWith('</', i)) {
      const close = html.indexOf('>', i + 2)
      if (close === -1) break
      const name = html.slice(i + 2, close).trim().toLowerCase()
      if (stopTag && name === stopTag) {
        return { nodes, next: close + 1 }
      }
      // Unmatched close — skip.
      i = close + 1
      continue
    }

    const tagMatch = html.slice(i).match(/^<([a-zA-Z][\w:-]*)\b([^>]*?)(\/?)>/)
    if (!tagMatch) {
      i++
      continue
    }

    const tag = tagMatch[1]
    const tagLower = tag.toLowerCase()
    const attrText = tagMatch[2]
    const selfClose = tagMatch[3] === '/' || attrText.trimEnd().endsWith('/')
    const fullOpenLen = tagMatch[0].length
    const attrs = parseAttrs(attrText.replace(/\/\s*$/, ''))
    const openEnd = i + fullOpenLen

    if (tagLower === 'svg' || tagLower === 'style') {
      // Skip nested svg / leftover style blocks entirely.
      if (selfClose || CONTAINER_TAGS.has(tagLower) === false) {
        i = openEnd
        if (!selfClose && tagLower === 'style') {
          const close = html.toLowerCase().indexOf('</style>', openEnd)
          i = close === -1 ? n : close + '</style>'.length
        }
        continue
      }
    }

    if (selfClose || !CONTAINER_TAGS.has(tagLower)) {
      nodes.push({ _tag: tag, ...attrs })
      i = openEnd
      if (!selfClose && CONTAINER_TAGS.has(tagLower)) {
        // Non-void but we chose not to parse children — consume to close.
        const close = html.toLowerCase().indexOf(`</${tagLower}>`, openEnd)
        i = close === -1 ? n : close + tagLower.length + 3
      } else if (!selfClose) {
        // Leaf that used `<path ...>` without `/>` — already consumed open tag;
        // if a matching close exists immediately empty, skip it.
        const close = html.toLowerCase().indexOf(`</${tagLower}>`, openEnd)
        if (close === openEnd || (close !== -1 && html.slice(openEnd, close).trim() === '')) {
          i = close + tagLower.length + 3
        }
      }
      continue
    }

    // Container with children.
    const { nodes: children, next } = parseNodes(html, openEnd, tagLower)

    if (tagLower === 'g' && !shouldKeepGroup(attrs)) {
      nodes.push(...children)
    } else {
      const el = { _tag: tag, ...attrs }
      if (children.length) el._children = children
      nodes.push(el)
    }
    i = next
  }

  return { nodes, next: i }
}

function shouldKeepGroup(attrs) {
  for (const key of Object.keys(attrs)) {
    if (GROUP_KEEP_ATTRS.has(key)) return true
  }
  return false
}

/**
 * Pull the inner markup + viewBox/width/height out of a raw SVG document.
 * Returns null if the input doesn't look like an SVG.
 */
export function extractSvgInner(raw) {
  const cleaned = raw.replace(/<\?xml[^?]*\?>/g, '').trim()
  const openMatch = cleaned.match(/<svg\b([^>]*)>/)
  const closeIdx = cleaned.lastIndexOf('</svg>')
  if (!openMatch || closeIdx === -1) return null
  const attrs = openMatch[1]
  const inner = cleaned.slice(openMatch.index + openMatch[0].length, closeIdx)

  const viewBoxMatch = attrs.match(/viewBox="([^"]+)"/)
  const widthMatch = attrs.match(/width="([^"]+)"/)
  const heightMatch = attrs.match(/height="([^"]+)"/)

  return {
    viewBox: viewBoxMatch ? viewBoxMatch[1] : '0 0 0 0',
    width: widthMatch ? Number(widthMatch[1]) : 0,
    height: heightMatch ? Number(heightMatch[1]) : 0,
    body: parseSvgElements(inner),
  }
}

function escapeAttr(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function resolveVar(value, variables) {
  if (typeof value !== 'string' || !value.startsWith('$')) return value
  const key = value.slice(1)
  if (Object.prototype.hasOwnProperty.call(variables, key)) {
    return variables[key]
  }
  return value
}

function shouldRenderElement(render, variables) {
  if (render === undefined) return true
  const resolved =
    typeof render === 'string' && render.startsWith('$')
      ? Object.prototype.hasOwnProperty.call(variables, render.slice(1))
        ? variables[render.slice(1)]
        : false
      : render
  return (
    resolved === true ||
    resolved === 1 ||
    resolved === 'true' ||
    resolved === '1'
  )
}

/**
 * Serialize a part body to inner SVG markup. `$var` tokens are substituted
 * from `variables`; unknown tokens stay as-is. `render` is never emitted.
 */
export function serializeSvgElements(els, variables = {}) {
  let out = ''
  for (const el of els ?? []) {
    if (!el?._tag) continue
    if (!shouldRenderElement(el.render, variables)) continue
    const children = Array.isArray(el._children) ? el._children : null
    out += '<' + el._tag
    for (const k of Object.keys(el)) {
      if (k === '_tag' || k === 'render' || k === '_children') continue
      const v = el[k]
      if (v === undefined || Array.isArray(v)) continue
      const resolved = resolveVar(v, variables)
      out += ' ' + k + '="' + escapeAttr(resolved) + '"'
    }
    if (children && children.length > 0) {
      out += '>'
      out += serializeSvgElements(children, variables)
      out += '</' + el._tag + '>'
    } else {
      out += '/>'
    }
  }
  return out
}

/**
 * Wrap a part body in a standalone SVG document for rasterization.
 */
export function serializePartDocument(part, defaults = {}, variables = {}) {
  const viewBox = part.viewBox ?? defaults.viewBox ?? '0 0 0 0'
  const parsed = String(viewBox).trim().split(/[\s,]+/).map(Number)
  const vbW = parsed[2]
  const vbH = parsed[3]
  const width = part.width > 0 ? part.width : defaults.width > 0 ? defaults.width : vbW
  const height = part.height > 0 ? part.height : defaults.height > 0 ? defaults.height : vbH
  const inner = serializeSvgElements(part.body ?? [], variables)
  return {
    svg:
      `<svg xmlns="http://www.w3.org/2000/svg"` +
      ` xmlns:xlink="http://www.w3.org/1999/xlink"` +
      ` viewBox="${escapeAttr(viewBox)}"` +
      ` width="${width}" height="${height}">${inner}</svg>`,
    viewBox,
    width,
    height,
  }
}
