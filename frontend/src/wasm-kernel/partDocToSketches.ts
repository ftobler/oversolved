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

import type { PartConstraint, PartFeature, SketchFeature, DroppedSketchConstraint } from '@/types/cad'
import { resolveVertexRef } from '@/types/vertexRef'
import { colinearShapeProblem, constraintOperandSide } from '@/utils/constraintOperands'
import { entityPointKeys } from '@/registry/entityRegistry'
import {
  constraintEntityKindProblem,
  type ConstraintKindOperand,
  type ConstraintOperandRole,
} from '@/utils/constraintApplicability'
import { isConstraintKindName } from './codec'
import type { SketchInput } from './lowerSketch'

/** A constraint the live-document lowering could not turn into a solver row.
 *  An unresolved ref used to vanish here, before the wire, so no verdict could
 *  name it; the sketch warning path reports these instead. The record shape is
 *  shared with the solve result (`dropped_constraints`) so the editor tile and
 *  the warning cannot disagree. */
export type DroppedConstraint = DroppedSketchConstraint

export interface ExtractedSketch {
  featureId: string
  sketch: SketchInput
  /** Constraints dropped during lowering, with the reason the sketch warning
   *  names. The solver never sees these, so it cannot flag them. */
  droppedConstraints: DroppedConstraint[]
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

/** What the key-existence check needs to know about a target entity: its
 *  current kind, and for a variable `fit_spline` the authored block shape. */
interface EntityLowerInfo {
  kind: string
  nParams?: number
  handles?: 'start' | 'end' | 'both'
  /** Held by a `projection` constraint, so its source's centre can be kept by a
   *  declared-point projection whatever kind the curve resolves to. */
  projected?: boolean
}

/**
 * Lower one constraint to dict-ref form. Returns null (drop the constraint) when
 * any present ref does not resolve to a local entity, when it names a point key
 * the target entity's current kind does not have, or when the constraint kind
 * cannot take the target's current kind -- matching the historical behavior for
 * stale refs and refusing a silent rebind of either sort.
 */
function lowerConstraint(
  c: PartConstraint,
  entityIds: Set<string>,
  originLocal: [number, number],
  dropped: DroppedConstraint[],
  authoredKind: string,
  entityInfo: ReadonlyMap<string, EntityLowerInfo>,
): Record<string, unknown> | null {
  const out: Record<string, unknown> = { id: c.id, kind: c.kind }
  // The whole-entity operands, by their CURRENT kind and the field they came
  // from: what the kind-applicability table reads once every ref has resolved.
  // A vertex ref and the origin are point operands, not whole entities; a bare
  // locus ref (a whole curve) IS one and carries its kind.
  const operands: ConstraintKindOperand[] = []
  for (const key of REF_KEYS) {
    const raw = c[key]
    if (raw == null) continue
    const resolved = resolveLocal(raw, entityIds, originLocal)
    if (!resolved) {
      // Name the kind the document stores, not the wire kind a lowering may
      // have substituted (`colinear` arrives here as `coincident`).
      dropped.push({ id: c.id, kind: authoredKind, reason: 'stale reference' })
      return null
    }
    if ('entity' in resolved) {
      const info = entityInfo.get(resolved.entity)
      // A point key the target's CURRENT kind does not have is not a meaningful
      // operand. The solver would fall back to the entity's first point
      // (`center` on a line binds its start), silently changing what the user
      // asked for, so the row is dropped and named instead. The document keeps
      // the row, so a source that changes back re-enables it on the next solve.
      if (resolved.point !== undefined) {
        if (info) {
          const keys = entityPointKeys(info.kind, info.nParams, info.handles)
          if (keys && !keys.has(resolved.point)) {
            // A projected curve's centre is the one lost key with a stable
            // alternative: a declared-point projection keeps it reachable in any
            // orientation, so the warning names that rather than only the loss.
            // A plain point or fit spline has no such source to re-project.
            const remedy = resolved.point === 'center' && info.projected
              ? '; project the center as a point to keep it'
              : ''
            dropped.push({
              id: c.id, kind: authoredKind,
              reason: `operand ${resolved.point} not on ${info.kind}${remedy}`,
            })
            return null
          }
        }
      } else if (info) {
        const role: ConstraintOperandRole =
          key === 'target' ? 'target' : key === 'a' ? 'a' : key === 'b' ? 'b' : 'operand'
        operands.push({ role, kind: info.kind })
      }
    }
    out[key] = resolved
  }
  // The kind-applicability half, read from the same table the add-time guards
  // use (`constraintEntityKindProblem`): a `length` on an arc or an `equal_length`
  // across a line and an ellipse has no row, whichever kind the entity was
  // authored as. The row stays in the document, so a kind round trip revives it.
  const kindProblem = constraintEntityKindProblem(authoredKind, operands)
  if (kindProblem !== null) {
    dropped.push({ id: c.id, kind: authoredKind, reason: kindProblem })
    return null
  }
  // N-ary refs: a group's member list. Each names a whole local entity; the
  // origin (`@builtin_origin`) and any other unresolved form is dropped with
  // the group, since a member the solver cannot address would leave the rest
  // half-held. Sugar kinds (ngon, dock) expanded before this loop, so their
  // refs never reach here.
  if (Array.isArray(c.refs)) {
    const refs: Array<{ entity: string; point?: string }> = []
    for (const raw of c.refs) {
      const resolved = resolveLocal(raw, entityIds, originLocal)
      if (!resolved || 'external_xy' in resolved) {
        dropped.push({ id: c.id, kind: authoredKind, reason: 'unresolvable group member' })
        return null
      }
      // A point member names a point the entity's CURRENT kind must still have:
      // the solver's `point()` falls back to the first point for a selector the
      // kind lacks, which would silently hold a different point than the user
      // picked. The document keeps the row, like the single-ref operand path.
      if (resolved.point !== undefined) {
        const info = entityInfo.get(resolved.entity)
        if (info !== undefined) {
          const keys = entityPointKeys(info.kind, info.nParams, info.handles)
          if (keys !== undefined && !keys.has(resolved.point)) {
            dropped.push({
              id: c.id, kind: authoredKind,
              reason: `operand ${resolved.point} not on ${info.kind}`,
            })
            return null
          }
        }
      }
      refs.push(resolved)
    }
    if (refs.length === 0) {
      dropped.push({ id: c.id, kind: authoredKind, reason: 'group has no members' })
      return null
    }
    out.refs = refs
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
function expandDockConstraint(c: PartConstraint, feature: SketchFeature): PartConstraint[] {
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

/** Replace sugar constraints (`ngon`, `dock`) with their primitive expansions
 *  and lower `colinear` to the solver's `coincident`, leaving every other
 *  constraint untouched. Runs before the resolve loop so the solver only ever
 *  sees real constraint kinds. (Offset is not sugar at this layer: it is stored
 *  directly as parallel/concentric + an ordinary dimension.)
 *
 *  `colinear` is a document kind with no wire code: the solver's coincident arm
 *  already reads two bare lines as the collinear row pair and a point against a
 *  line as point-on-line. Lowering here keeps the authored kind in the document
 *  (tile, undo label, intent) while the solve gets the rows that kind always
 *  meant. A pair with any other shape is dropped with the reason the sketch
 *  warning names, rather than lowered to a row the author did not ask for.
 */
function expandSugarConstraints(feature: SketchFeature, dropped: DroppedConstraint[]): PartConstraint[] {
  const entities = feature.entities ?? []
  const entityIds = new Set(entities.map((e) => e.id))
  const kindById = new Map(entities.map((e) => [e.id, e.kind]))
  const out: PartConstraint[] = []
  for (const c of feature.constraints ?? []) {
    if (c.kind === 'projection') continue
    if (c.kind === 'ngon') out.push(...lowerNgonConstraint(c))
    else if (c.kind === 'dock') out.push(...expandDockConstraint(c, feature))
    else if (c.kind === 'colinear') {
      const problem = colinearShapeProblem(c.a, c.b, (ref) => constraintOperandSide(ref, entityIds, kindById))
      if (problem !== null) dropped.push({ id: c.id, kind: c.kind, reason: problem })
      else out.push({ ...c, kind: 'coincident' })
    } else out.push(c)
  }
  return out
}

/** The document constraint kinds that never reach the solver as themselves:
 *  the sugar expanded here (`ngon`, `dock`), `projection` (resolved by the
 *  sketch solve before this module runs) and `colinear` (lowered to
 *  `coincident` above). Every other kind a document may carry must be a wire
 *  kind. Exported so the registry test can prove a new kind is in one of the
 *  two sets instead of shipping inert. */
export const LOWERED_KINDS: ReadonlySet<string> = new Set(['colinear', 'projection', 'ngon', 'dock'])

/** True when a constraint kind a document may carry can reach a residual:
 *  either the wire table decodes it or a lowering turns it into one that does.
 *  The document boundary reads this so a hand-edited unknown kind is refused
 *  by field instead of faulting the solve. */
export function isDocumentConstraintKind(kind: string): boolean {
  return isConstraintKindName(kind) || LOWERED_KINDS.has(kind)
}

/** Per-solve projection facts for one sketch, kept out of the document. A
 *  projected entity's kind is resolved by the lowerer (a circle seen edge-on is
 *  a line) and a face projection's members are derived entities, neither of
 *  which is a document row. Passing them here is what lets the key and
 *  kind-applicability gates read the resolved shape without an in-place write. */
export interface SketchProjectionFacts {
  resolvedKinds?: Readonly<Record<string, string>>
  derivedKinds?: Readonly<Record<string, string>>
  derivedInitial?: Readonly<Record<string, number[]>>
}

/**
 * Lower sketch features to solver `SketchInput`. `originLocal` is the document
 * origin (0,0,0) in the sketch's local 2D frame, applied to every
 * `@builtin_origin` ref; it defaults to [0,0] (correct for builtin planes) and
 * the caller passes the projected value for a sketch on an offset/projected
 * plane. Callers that lower more than one feature at once must share a plane, or
 * resolve per-feature themselves (today both callers pass a single feature).
 * `facts` carries this solve's resolved kinds and derived face members; applied
 * to a single feature, as every caller does.
 */
export function partDocToSketches(
  features: PartFeature[] | undefined,
  originLocal: [number, number] = [0, 0],
  pinnedEntityIds: string[] = [],
  facts: SketchProjectionFacts = {},
): ExtractResult {
  const sketches: ExtractedSketch[] = []
  const skipped: SkippedSketch[] = []

  for (const feature of features ?? []) {
    if (feature.kind !== 'sketch') continue
    const resolvedKinds = facts.resolvedKinds ?? {}
    const derivedKinds = facts.derivedKinds ?? {}
    const derivedInitial = facts.derivedInitial ?? {}
    const entities: NonNullable<SketchFeature['entities']> = [
      ...(feature.entities ?? []),
      ...Object.entries(derivedKinds).map(([id, kind]) => ({ id, kind })),
    ]
    const initial = { ...(feature.initial ?? {}), ...derivedInitial }

    if (entities.some((e) => e.kind === 'center_rect')) {
      skipped.push({ featureId: feature.id, reason: 'center_rect sugar (not expanded)' })
      continue
    }

    const entityIds = new Set(entities.map((e) => e.id))
    // A constraining row that loses a key gets the remedy only when the entity
    // has a projection to re-aim; a plain entity has no source to project.
    const projectedIds = new Set(
      (feature.constraints ?? [])
        .filter((c) => c.kind === 'projection' && typeof c.target === 'string')
        .map((c) => String(c.target).replace(/^\$/, '')),
    )
    const entityInfo = new Map<string, EntityLowerInfo>(entities.map((e) => [
      e.id,
      {
        kind: resolvedKinds[e.id] ?? e.kind,
        nParams: initial[e.id]?.length,
        handles: e.handles,
        projected: projectedIds.has(e.id),
      },
    ]))
    const authoredKinds = new Map((feature.constraints ?? []).map((c) => [c.id, c.kind]))
    const constraints: Array<Record<string, unknown>> = []
    const droppedConstraints: DroppedConstraint[] = []
    for (const c of expandSugarConstraints(feature, droppedConstraints)) {
      const authoredKind = authoredKinds.get(c.id) ?? c.kind
      const lowered = lowerConstraint(c, entityIds, originLocal, droppedConstraints, authoredKind, entityInfo)
      if (lowered) constraints.push(lowered)
    }

    const sketch: SketchInput = {
      id: feature.id,
      plane: feature.plane ?? null,
      entities: entities.map((e) => ({
        id: e.id,
        kind: resolvedKinds[e.id] ?? e.kind,
        construction: e.construction,
        handles: e.handles,
      })),
      initial,
      constraints,
      pinnedEntityIds,
    }
    sketches.push({ featureId: feature.id, sketch, droppedConstraints })
  }

  return { sketches, skipped }
}
