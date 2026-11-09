// Lower the author's coincident and tangent rows to the area builder's declared
// contacts. The builder (Rust `detect_topology`) welds these by identity
// instead of trusting the solver's numerics: a satisfied coincident can sit
// farther apart than the builder's absolute merge on a large sketch, and a
// converged tangency is numerically zero or two intersections, never one.
//
// Pure and WASM-free: the sketch lowering already resolved every ref to a
// `{entity, point}` dict, and `resolveVertexRef` (the shared ref reader) is the
// only parser. Sugar (`ngon`, `dock`) arrives already expanded to primitive
// rows with synthetic ids, so it lowers exactly like the authored rows it came
// from.

import type { EntityLayout, SketchInput } from '@/wasm-kernel/lowerSketch'
import { resolveVertexRef } from '@/types/vertexRef'

/** One operand: an entity, optionally a curve endpoint. */
export interface DeclaredContactRef {
  entity: string
  point?: string
}

export interface DeclaredContact {
  // The authored (or synthetic sugar) constraint id, named in an unmet report.
  id: string
  kind: 'join' | 'on' | 'tangent'
  a: DeclaredContactRef
  b: DeclaredContactRef
  // Tangent only: a join ties the two curves at their shared endpoint.
  join?: boolean
}

/** Kinds whose `start`/`end` are real curve endpoints a join can weld. */
const ENDPOINT_KINDS = new Set(['line', 'arc', 'spline', 'fit_spline'])
/** Kinds that can host a point-on-curve locus (a point entity cannot). */
const CURVE_KINDS = new Set(['line', 'arc', 'circle', 'ellipse', 'spline', 'fit_spline'])

const START_OR_END = new Set(['start', 'end'])

/**
 * The declared contacts of one solved sketch, in wire order: joins first (so a
 * tangent can see them), then point-on-curve contacts, then tangents.
 *
 * Returns none for an overconstrained solve. Its geometry is a least-squares
 * compromise and the declared contacts are exactly the rows that failed, so
 * welding them would paper over the conflict; the solve's own culprit marking
 * is the report for that case.
 */
export function declaredContacts(
  sketch: SketchInput,
  layout: EntityLayout[],
  status: string,
): DeclaredContact[] {
  if (status === 'overconstrained') return []

  const known = new Set(layout.map((l) => l.id))
  const kindOf = new Map(layout.map((l) => [l.id, l.kind]))
  const constructionOf = new Map(layout.map((l) => [l.id, l.construction === true]))
  const curve = (entity: string): boolean =>
    (CURVE_KINDS.has(kindOf.get(entity) ?? '') && !constructionOf.get(entity)) === true
  const endpoint = (ref: unknown): DeclaredContactRef | null => {
    const resolved = resolveVertexRef(known, ref)
    if (!resolved || !resolved.point || !START_OR_END.has(resolved.point)) return null
    if (!ENDPOINT_KINDS.has(kindOf.get(resolved.entity) ?? '')) return null
    if (constructionOf.get(resolved.entity)) return null
    return { entity: resolved.entity, point: resolved.point }
  }
  const locus = (ref: unknown): DeclaredContactRef | null => {
    const resolved = resolveVertexRef(known, ref)
    if (!resolved || resolved.point !== undefined) return null
    if (!curve(resolved.entity)) return null
    return { entity: resolved.entity }
  }

  const joins: DeclaredContact[] = []
  const ons: DeclaredContact[] = []
  for (const c of sketch.constraints) {
    if (c.kind !== 'coincident') continue
    const id = typeof c.id === 'string' ? c.id : ''
    const a = endpoint(c.a)
    const b = endpoint(c.b)
    if (a && b) {
      joins.push({ id, kind: 'join', a, b })
      continue
    }
    if (a) {
      const host = locus(c.b)
      if (host) ons.push({ id, kind: 'on', a, b: host })
      continue
    }
    if (b) {
      const host = locus(c.a)
      if (host) ons.push({ id, kind: 'on', a: b, b: host })
    }
  }

  const joinsEntities = new Set(joins.map((j) => pairKey(j.a.entity, j.b.entity)))
  const tangents: DeclaredContact[] = []
  for (const c of sketch.constraints) {
    if (c.kind !== 'tangent') continue
    const a = locus(c.a)
    const b = locus(c.b)
    if (!a || !b) continue
    const id = typeof c.id === 'string' ? c.id : ''
    tangents.push({
      id,
      kind: 'tangent',
      a,
      b,
      join: joinsEntities.has(pairKey(a.entity, b.entity)),
    })
  }

  return [...joins, ...ons, ...tangents]
}

function pairKey(a: string, b: string): string {
  return a <= b ? `${a}\u0000${b}` : `${b}\u0000${a}`
}
