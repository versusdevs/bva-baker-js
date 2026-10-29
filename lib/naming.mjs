/**
 * Filename / identifier helpers shared across the BVA pipeline.
 */

/** Make a JS-friendly key from a free-form Lottie layer name. */
export function sanitizeName(name) {
  return String(name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

/** Sort `Skin_2` before `Skin_10`. */
export function naturalSort(a, b) {
  const ax = a.match(/(\d+)/)?.[1];
  const bx = b.match(/(\d+)/)?.[1];
  if (ax && bx) return Number(ax) - Number(bx);
  return a.localeCompare(b);
}

/** Build a predicate from a glob-ish or RegExp pattern. */
export function makePatternMatcher(pattern) {
  if (!pattern) return () => true;
  if (pattern instanceof RegExp) return (n) => pattern.test(n);
  const re = new RegExp(
    '^' +
      String(pattern)
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.') +
      '$',
  );
  return (n) => re.test(n);
}
