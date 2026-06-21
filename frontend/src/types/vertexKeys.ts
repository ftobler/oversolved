// Vertex-key suffixes a local query or constraint ref may carry, e.g.
// `$<eid>start` or `$<eid>major1`. The ellipse axis-endpoint keys
// (major1/major2/minor1/minor2) sit alongside the base line/arc/circle/point
// keys so `$<eid>major1` round-trips to { eid, sub: 'major1' }.
//
// This is the single source for that suffix set. It is deliberately broader
// than the per-entity registry VERTEX_INDICES, which (currently) omits the
// ellipse axis keys; keep the literal here until the registry covers them.
export const VERTEX_POINT_KEYS = [
  'start', 'end', 'center', 'xy',
  'major1', 'major2', 'minor1', 'minor2',
  'c1', 'c2',
] as const
