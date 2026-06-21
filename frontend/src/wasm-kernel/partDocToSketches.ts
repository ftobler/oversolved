/**
 * Lower the sketch features of a live PartDoc into the resolved `SketchInput`
 * the Rust shadow solver consumes.
 *
 * Live constraints carry sketch-local query-string refs (`$line1`, `$arc1start`)
 * which we resolve to `{entity, point}` dict form here -- the same sketch-local
 * resolution `geometryMapping.resolveQueryRef` already does for rendering, NOT
 * the ancestral / projection query system (that is phase 2c). A constraint whose
 * refs do not all resolve to local entities is dropped, mirroring the previous
 * `_filter_local_constraints` behavior; the Python solver used to drop them too, so the
 * constraint sets stay aligned.
 *
 * Sketches that need resolution we cannot do client-side yet -- projected
 * entities (a `source` query into ancestral brep) and `center_rect` sugar -- are
 * skipped with a reason. Those await the phase-2 projection lowering.
 */

import type { PartConstraint, PartFeature } from '@/types/cad'
import { VERTEX_POINT_KEYS } from '@/types/vertexKeys'
import type { SketchInput } from './lowerSketch'

export interface ExtractedSketch {
  featureId: string
  sketch: SketchInput
}

export interface SkippedSketch {
  featureId: string
  reason: string
}

export interface ExtractResult {
  sketches: ExtractedSketch[]
  skipped: SkippedSketch[]
}

const REF_KEYS = ['target', 'a', 'b', 'line', 'arc', 'point', 'point_a', 'point_b'] as const

/**
 * Resolve a constraint ref against the sketch's local entity ids. Accepts
 * the live `$entityId[point]` query-string form, the already-resolved
 * `{entity, point}` dict form, and `@builtin_origin` (the origin-point
 * query that every sketch needs for coincident-to-origin constraints --
 * maps to `{external_xy: originLocal}` which the Rust solver's coincident
 * handler accepts natively).
 *
 * `originLocal` is the document origin (0,0,0) expressed in this sketch's local
 * 2D frame. It is [0,0] for the builtin planes (which pass through the global
 * origin) but nonzero for a sketch on an offset/projected face -- using a bare
 * [0,0] there would pin the constraint to the plane's local origin, a different
 * 3D point than the document origin (the "line constrained to origin" bug).
 */
function resolveLocal(
  q: unknown,
  entityIds: Set<string>,
  originLocal: [number, number],
): { entity: string; point?: string } | { external_xy: [number, number] } | null {
  if (q && typeof q === 'object') {
    const obj = q as { entity?: unknown; point?: unknown }
    if (typeof obj.entity === 'string' && entityIds.has(obj.entity)) {
      return typeof obj.point === 'string'
        ? { entity: obj.entity, point: obj.point }
        : { entity: obj.entity }
    }
    return null
  }
  if (typeof q === 'string') {
    if (q === '@builtin_origin') return { external_xy: [...originLocal] }
    if (!q.startsWith('$')) return null
    const local = q.slice(1)
    for (const pt of VERTEX_POINT_KEYS) {
      if (local.length > pt.length && local.endsWith(pt)) {
        const eid = local.slice(0, -pt.length)
        if (entityIds.has(eid)) return { entity: eid, point: pt }
      }
    }
    if (entityIds.has(local)) return { entity: local }
  }
  return null
}

/**
 * Lower one constraint to dict-ref form. Returns null (drop the constraint) when
 * any present ref does not resolve to a local entity -- matching the historical behavior.
 */
function lowerConstraint(
  c: PartConstraint,
  entityIds: Set<string>,
  originLocal: [number, number],
): Record<string, unknown> | null {
  const out: Record<string, unknown> = { id: c.id, kind: c.kind }
  for (const key of REF_KEYS) {
    const raw = c[key]
    if (raw == null) continue
    const resolved = resolveLocal(raw, entityIds, originLocal)
    if (!resolved) return null
    out[key] = resolved
  }
  if (typeof c.value === 'number') out.value = c.value
  if (typeof c.x === 'number' && typeof c.y === 'number') {
    out.x = c.x
    out.y = c.y
  }
  if (typeof c.axis === 'string') out.axis = c.axis
  return out
}

/**
 * Expand a single `ngon` sugar constraint into the primitive constraints that
 * make the member lines a regular polygon: every side equal in length, and a
 * minimal set of fixed turn angles. The member lines already form a closed
 * coincident chain (added at mutation time), which together with N-1 equal
 * lengths and N-3 fixed exterior angles (360/N degrees, the angle the solver
 * measures between consecutive edge directions) pins the polygon to the
 * similarity family of regular N-gons. The solver never sees `ngon`.
 */
function lowerNgonConstraint(c: PartConstraint): PartConstraint[] {
  const refs = c.refs ?? []
  const n = refs.length
  if (n < 3) return []
  const out: PartConstraint[] = []
  // All sides equal length (pair every side with the first).
  for (let i = 1; i < n; i++) {
    out.push({ id: `${c.id}_eq${i}`, kind: 'equal_length', a: refs[0], b: refs[i] })
  }
  // Fix N-3 consecutive turn angles; closure + equal lengths determine the rest.
  const turn = 360 / n
  for (let i = 0; i < n - 3; i++) {
    out.push({ id: `${c.id}_ang${i}`, kind: 'angle', a: refs[i], b: refs[i + 1], value: turn })
  }
  return out
}

/** Coerce a constraint ref into LOCUS form (the whole curve, no vertex key) so a
 *  `coincident` against it reads as point-on-curve, not point-to-point. A tangent
 *  host's operands are already entity-only, but stripping defensively keeps the
 *  dock lowering correct for any future dockable host whose operand carries a
 *  vertex key. */
function toLocus(ref: unknown): unknown {
  if (ref && typeof ref === 'object') {
    const obj = ref as { entity?: unknown; point?: unknown }
    if (typeof obj.entity === 'string') return { entity: obj.entity }
  }
  return ref  // `$entityId` string is already a bare locus
}

/** Expand a `dock` constraint into the operand locus pins that materialize an
 *  inferred point at its host's implied contact (lazy inferred materialization).
 *
 *  A `dock` names a point `P` and a `host` constraint id. The host is the thing
 *  that defines the contact (today: a `tangent(A, B)`, whose implied foot is the
 *  point where A and B touch). Lowering pins P to both of the host's operands as
 *  loci -- `coincident(P, A)` + `coincident(P, B)` -- which is exactly the
 *  existing `r_coincident` locus form, so there is NO new solver primitive.
 *
 *  Lifetime is fail-soft: the lowering is gated on the host still existing. Delete
 *  the host and this returns nothing, leaving P an ordinary under-constrained
 *  point resting at its last solved position (it floats until reconstrained). */
function expandDockConstraint(c: PartConstraint, feature: PartFeature): PartConstraint[] {
  if (!c.host || !c.point) return []
  const host = (feature.constraints ?? []).find((h) => h.id === c.host)
  if (!host) return []  // host deleted: float (emit no residual)
  // Dockable hosts: those with an implied contact not already an explicit operand.
  // `tangent` has an implied foot. coincident/parallel/dimensions do not.
  if (host.kind === 'tangent' && host.a != null && host.b != null) {
    return [
      { id: `${c.id}_d0`, kind: 'coincident', a: c.point, b: toLocus(host.a) as PartConstraint['b'] },
      { id: `${c.id}_d1`, kind: 'coincident', a: c.point, b: toLocus(host.b) as PartConstraint['b'] },
    ]
  }
  return []
}

/** Replace sugar constraints (`ngon`, `dock`) with their primitive expansions,
 *  leaving every other constraint untouched. Runs before the resolve loop so the
 *  solver only ever sees real constraint kinds. (Offset is not sugar at this
 *  layer: it is stored directly as parallel/concentric + an ordinary dimension.) */
function expandSugarConstraints(feature: PartFeature): PartConstraint[] {
  const out: PartConstraint[] = []
  for (const c of feature.constraints ?? []) {
    if (c.kind === 'ngon') out.push(...lowerNgonConstraint(c))
    else if (c.kind === 'dock') out.push(...expandDockConstraint(c, feature))
    else out.push(c)
  }
  return out
}

/**
 * Lower sketch features to solver `SketchInput`. `originLocal` is the document
 * origin (0,0,0) in the sketch's local 2D frame, applied to every
 * `@builtin_origin` ref; it defaults to [0,0] (correct for builtin planes) and
 * the caller passes the projected value for a sketch on an offset/projected
 * plane. Callers that lower more than one feature at once must share a plane, or
 * resolve per-feature themselves (today both callers pass a single feature).
 */
export function partDocToSketches(
  features: PartFeature[] | undefined,
  originLocal: [number, number] = [0, 0],
  pinnedEntityIds: string[] = [],
): ExtractResult {
  const sketches: ExtractedSketch[] = []
  const skipped: SkippedSketch[] = []

  for (const feature of features ?? []) {
    if (feature.kind !== 'sketch') continue
    const entities = feature.entities ?? []

    if (entities.some((e) => e.source)) {
      skipped.push({ featureId: feature.id, reason: 'projection (needs phase-2 lowering)' })
      continue
    }
    if (entities.some((e) => e.kind === 'center_rect')) {
      skipped.push({ featureId: feature.id, reason: 'center_rect sugar (not expanded)' })
      continue
    }

    const entityIds = new Set(entities.map((e) => e.id))
    const constraints: Array<Record<string, unknown>> = []
    for (const c of expandSugarConstraints(feature)) {
      const lowered = lowerConstraint(c, entityIds, originLocal)
      if (lowered) constraints.push(lowered)
    }

    const sketch: SketchInput = {
      id: feature.id,
      plane: feature.plane ?? null,
      entities: entities.map((e) => ({ id: e.id, kind: e.kind })),
      initial: feature.initial ?? {},
      constraints,
      pinnedEntityIds,
    }
    sketches.push({ featureId: feature.id, sketch })
  }

  return { sketches, skipped }
}
