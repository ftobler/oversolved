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
import { resolveVertexRef } from '@/types/vertexRef'
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
 * Resolve a constraint ref against the sketch's local entity ids. Thin wrapper
 * over the shared vertex-ref reader (types/vertexRef), which owns the accepted
 * `$entityId[point]` / `{entity, point}` forms and the full-id-first +
 * longest-eid tie-break. This wrapper adds the `@builtin_origin` extra (the
 * origin-point query that every sketch needs for coincident-to-origin
 * constraints -- maps to `{external_xy: originLocal}` which the Rust solver's
 * coincident handler accepts natively).
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
  if (typeof q === 'string' && q === '@builtin_origin') return { external_xy: [...originLocal] }
  return resolveVertexRef(entityIds, q)
}

/** True when `v` is a usable finite number; undefined fails so a half-authored
 *  x/y pair is rejected. */
function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
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
  // A present-but-non-numeric scalar is corrupt: passing it through (or
  // stripping it) would lower a dimension with no residual, so the sketch
  // silently solves underconstrained. Drop the whole constraint, the same
  // fail-loud rule the ref path uses, rather than weakening the model.
  if (c.value != null && !isFiniteNumber(c.value)) return null
  if (c.value != null) out.value = c.value
  if (c.x != null || c.y != null) {
    if (!isFiniteNumber(c.x) || !isFiniteNumber(c.y)) return null
    out.x = c.x
    out.y = c.y
  }
  if (c.axis != null && typeof c.axis !== 'string') return null
  if (c.axis != null) out.axis = c.axis
  // Orientation selector for directional dimensions (+1/-1). Carried through so
  // the chosen side survives to the solver; absent for non-directional dims.
  if (c.sign != null && !isFiniteNumber(c.sign)) return null
  if (c.sign != null) out.sign = c.sign
  return out
}

/**
 * Expand a single `ngon` sugar constraint into the primitive constraints that
 * make the member lines a regular polygon: every side equal in length, and a
 * minimal set of fixed turn angles. The member lines already form a closed
 * coincident chain (added at mutation time), which together with N-1 equal
 * lengths and N-3 fixed exterior angles (360/N degrees, the angle the solver
 * measures between consecutive edge directions) pins the polygon to the
 * similarity family of regular N-gons (4 DOF). The solver never sees `ngon`.
 *
 * With a `circle` (the construction circumcircle) three vertices are also put
 * on it. A regular polygon's vertices are already concyclic, so three
 * point-on-circle rows are exactly what fixes the circle's 3 params; pinning
 * more vertices would only add redundant rows. Measured on the real solver
 * (ngonCenterSolve.test.ts): 4 DOF and rank === rows for N = 3, 4, 6, 8. The
 * pins go on vertices 0, N/3 and 2N/3, spread round the polygon so the three
 * points are never nearly collinear. An `ngon` without `circle` lowers as it
 * always did.
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
  if (c.circle != null) {
    for (let k = 0; k < 3; k++) {
      const start = lineStart(refs[Math.floor((k * n) / 3)])
      // A member ref that is not a plain line ref cannot name its start; the
      // pin is skipped rather than lowered onto the whole line.
      if (start) out.push({ id: `${c.id}_on${k}`, kind: 'coincident', a: start, b: toLocus(c.circle) as PartConstraint['b'] })
    }
  }
  return out
}

/** The start vertex of an `ngon` member line, in dict-ref form. Members are
 *  stored as bare entity refs (`$<eid>` or `{entity}`), never with a vertex key,
 *  so the entity id is the whole ref. */
function lineStart(ref: unknown): PartConstraint['a'] | null {
  let entity: unknown = null
  if (typeof ref === 'string' && ref.startsWith('$')) entity = ref.slice(1)
  else if (ref && typeof ref === 'object') entity = (ref as { entity?: unknown }).entity
  if (typeof entity !== 'string' || entity === '') return null
  return { entity, point: 'start' } as unknown as PartConstraint['a']
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
      entities: entities.map((e) => ({ id: e.id, kind: e.kind, construction: e.construction })),
      initial: feature.initial ?? {},
      constraints,
      pinnedEntityIds,
    }
    sketches.push({ featureId: feature.id, sketch })
  }

  return { sketches, skipped }
}
