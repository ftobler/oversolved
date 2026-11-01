// Vertex-key suffixes a local query or constraint ref may carry, e.g.
// `$<eid>start` or `$<eid>major1`. The ellipse axis-endpoint keys
// (major1/major2/minor1/minor2) sit alongside the base line/arc/circle/point
// keys so `$<eid>major1` round-trips to { eid, sub: 'major1' }.
//
// A fit spline adds one positional key per INTERIOR fit point, `fit1` up to
// MAX_FIT_POINT_KEY (point 0 is `start` and the last is `end`). The key pattern
// and the suffix list are both generated from that one bound, so raising the
// limit cannot leave the regex rejecting the new interior keys.
//
// This is the single source for that suffix set. It is deliberately broader
// than the per-entity registry VERTEX_INDICES, which (currently) omits the
// ellipse axis keys; keep the literal here until the registry covers them.
export const VERTEX_POINT_KEYS = [
  'start', 'end', 'center', 'xy',
  'major1', 'major2', 'minor1', 'minor2',
  'c1', 'c2',
] as const

/** The largest interior fit-point index. Both the key pattern and the suffix
 *  list below are built from it, so the limit has one home. */
export const MAX_FIT_POINT_KEY = 62

/** The interior indexes as strings, `1`..MAX_FIT_POINT_KEY. */
const FIT_POINT_INDEXES: readonly string[] = Array.from(
  { length: MAX_FIT_POINT_KEY },
  (_, i) => String(i + 1),
)

/** An interior fit-point key, `fit1` through the bound above. `fit0`, the index
 *  past the bound, `fit` and `fit01` are not points: point 0 is `start`, the
 *  last is `end`, and a positional key never carries a leading zero. */
export const FIT_POINT_KEY = new RegExp(`^fit(${FIT_POINT_INDEXES.join('|')})$`)

/** The interior fit-point index named by `key`, or null when it is not one. */
export function fitPointIndex(key: string): number | null {
  const match = FIT_POINT_KEY.exec(key)
  return match ? Number(match[1]) : null
}

/** True when `key` names a vertex point: a fixed key or an interior `fit<k>`. */
export function isVertexPointKey(key: string): boolean {
  return (VERTEX_POINT_KEYS as readonly string[]).includes(key) || FIT_POINT_KEY.test(key)
}

/** Every vertex-key spelling, the fixed list plus the generated interior keys.
 *  The suffix splitters walk this, so a fit-point ref parses like `start`. */
export const VERTEX_POINT_KEY_SUFFIXES: readonly string[] = [
  ...VERTEX_POINT_KEYS,
  ...FIT_POINT_INDEXES.map(index => `fit${index}`),
]
