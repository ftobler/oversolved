// PURE LOGIC: shared by the draw click (drawLogic) and the doc writers.

/** True when two snap refs pinning two vertices of one new entity would say
 *  the same thing twice.
 *
 *  Only a vertex ref qualifies: both new vertices coincident with one existing
 *  point is one statement (and a zero-length pull). An entity ref is the
 *  point-on-curve locus, and two different points on the same curve are two
 *  independent statements (a chord), so both are authored. The prefix test
 *  mirrors `carriedSnapFields`: anything not `entity:` names a point. */
export function sameSnapVertex(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && a === b && !a.startsWith('entity:')
}
