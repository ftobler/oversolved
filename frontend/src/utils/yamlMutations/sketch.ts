import type { PartDoc, PartEntityDef, PartFeature, PartConstraint, PartTarget } from '@/types/cad'
import { VERTEX_POINT_KEYS } from '@/types/vertexKeys'
import { VERTEX_INDICES, ALL_COORD_INDICES } from '@/registry'
import {
  warn, round, allFinite, findFeature, parseTarget, uniqueConstraintId, freshEntityIds,
  mintEntityId, CONSTRAINT_REF_FIELDS, refMatchesEntity,
} from './helpers'
import { offsetCorners, lineIntersect, lineVertexIndices } from '@/utils/geometry/offsetProfile'
import { dockLocationOf } from '@/utils/geometry/dockHosts'
import { ellipseAxisDrag, isEllipseAxisKey } from '@/utils/geometry/ellipseAxis'
import { isProperRect, centerRectCorners } from '@/utils/geometry/rectGeometry'
import { sameSnapVertex } from '@/utils/snapRefs'

// ─── Mutation preamble ───

/** The three lazily-created containers of a sketch feature. A feature straight out
 *  of YAML may be missing any of them, so every mutation that writes one has to
 *  materialize it first. */
type SketchLists = {
  entities: PartEntityDef[]
  initial: Record<string, number[]>
  constraints: PartConstraint[]
}

/** Find a sketch feature and materialize exactly the containers named in `lists`,
 *  returning it narrowed so the mutation body can index them without a `!` per
 *  line. Which containers get created is per call rather than all three always:
 *  an unrequested `constraints: []` would show up in the serialized document.
 *
 *  A missing feature yields undefined and every mutation below bails on it -- a
 *  stale feature id from the UI is not an error, the feature was just deleted.
 *
 *  Pass string LITERALS. A union-typed argument (`which: 'entities' | 'initial'`)
 *  infers K as the whole union, so the return type would claim both containers
 *  while only one was created. Every caller today passes literals. */
function resolveSketch<K extends keyof SketchLists>(
  doc: PartDoc,
  featureId: string,
  ...lists: K[]
): (PartFeature & Pick<SketchLists, K>) | undefined {
  const feature = findFeature(doc, featureId)
  if (!feature) return undefined
  for (const list of lists) {
    if (list === 'entities') {
      if (!feature.entities) feature.entities = []
    } else if (list === 'initial') {
      if (!feature.initial) feature.initial = {}
    } else if (list === 'constraints') {
      if (!feature.constraints) feature.constraints = []
    } else {
      // Exhaustive by construction: a container added to SketchLists without a
      // branch here would be asserted present by the cast below and materialized
      // by nobody. Fail at the type level rather than at the first index.
      const unhandled: never = list
      throw new Error(`resolveSketch: unhandled container ${String(unhandled)}`)
    }
  }
  return feature as PartFeature & Pick<SketchLists, K>
}

/** Drag commit: adopt the last WASM drag frame for ALL entities, so the hard solve
 *  seeds from the on-screen state instead of pre-drag geometry plus one teleported
 *  element (which can land in a different solution basin). Only known entity ids
 *  with matching param counts are written -- a stale or kind-mismatched entry must
 *  not corrupt the doc. Returns whether a frame was adopted, which is what tells a
 *  caller its own delta is already baked in.
 */
function adoptSolvedGeometry(
  initial: Record<string, number[]>,
  solvedGeometry?: Record<string, number[]>,
): boolean {
  if (!solvedGeometry) return false
  for (const [eid, p] of Object.entries(solvedGeometry)) {
    const cur = initial[eid]
    if (!cur || cur.length !== p.length) continue
    initial[eid] = p.map(round)
  }
  return true
}

// ─── Internals ───

function _refMatchesDeleted(ref: unknown, deletedIds: Set<string>): boolean {
  for (const eid of deletedIds) {
    if (refMatchesEntity(ref, eid)) return true
  }
  return false
}

function _refsDeletedEntity(c: PartConstraint, deletedIds: Set<string>): boolean {
  for (const field of CONSTRAINT_REF_FIELDS) {
    if (_refMatchesDeleted(c[field], deletedIds)) return true
  }
  // N-ary refs (ngon sugar): GC the whole constraint if any member is deleted,
  // otherwise a dangling member ref breaks the next lowering.
  if (Array.isArray(c.refs)) {
    for (const r of c.refs) if (_refMatchesDeleted(r, deletedIds)) return true
  }
  return false
}

// True when a local ref resolves to a single point: a `point` entity referenced
// bare, or a vertex sub-point of another entity (a line end, an arc center, ...).
// Cross-sketch (`@`) refs are out of scope and treated as valid. Used to spot the
// two-point form of horizontal/vertical, whose operands must both be points.
function _isPointOperand(ref: unknown, kindById: Map<string, string>): boolean {
  if (typeof ref !== 'string') return false
  if (ref.startsWith('@')) return true
  if (!ref.startsWith('$')) return false
  const bare = ref.slice(1)
  // A whole-entity id wins over the suffix reading: when the bare ref names an
  // entry in the sketch it is that entity, never `<other-entity><vertex-key>`,
  // even if it happens to end with a vertex key. Only a point entity counts.
  if (kindById.has(bare)) return kindById.get(bare) === 'point'
  for (const key of VERTEX_POINT_KEYS) {
    if (bare.length > key.length && bare.endsWith(key)) {
      const eid = bare.slice(0, -key.length)
      if (kindById.has(eid)) return true
    }
  }
  return false
}

// Self-cleanup for stale documents: drop horizontal/vertical constraints whose
// two-point (a/b) form references a whole non-point entity (e.g. a circle or an
// extra line picked up alongside the real target). Such an operand resolves to a
// single sub-point, so the residual is degenerate and already satisfied -- the
// line never turns axis-aligned and a stray symbol floats on the canvas. These
// can no longer be authored (applyAddConstraint rejects them) but documents from
// before that fix may still carry them. Returns the number removed.
// See bugreports/weird_constraint_20260621_214037.md.
export function dropDeadAxisConstraints(doc: PartDoc): number {
  let removed = 0
  for (const feature of doc.features ?? []) {
    if (!feature.constraints) continue
    const kindById = new Map((feature.entities ?? []).map(e => [e.id, e.kind]))
    const before = feature.constraints.length
    feature.constraints = feature.constraints.filter(c => {
      if (c.kind !== 'horizontal' && c.kind !== 'vertical') return true
      if (c.a === undefined || c.b === undefined) return true  // single-line target form
      return _isPointOperand(c.a, kindById) && _isPointOperand(c.b, kindById)
    })
    removed += before - feature.constraints.length
  }
  return removed
}

// midpoint needs specific keys depending on selection:
//   entity + vertex  → line: $entity,  point: $vertex
//   3 vertices       → point_a: $v1, point_b: $v2, point: $v3
// Returns false when the target combination is unrecognized.
function applyMidpointConstraint(
  c: PartConstraint,
  targets: string[],
  pt: (t: string) => PartTarget,
): boolean {
  const entityTargets = targets.filter(t => t.startsWith('entity:'))
  const vertexTargets = targets.filter(t => t.startsWith('vertex:'))
  if (entityTargets.length === 1 && vertexTargets.length === 1) {
    c.line = pt(entityTargets[0])
    c.point = pt(vertexTargets[0])
    return true
  }
  if (entityTargets.length === 0 && vertexTargets.length === 3) {
    c.point_a = pt(vertexTargets[0])
    c.point_b = pt(vertexTargets[1])
    c.point   = pt(vertexTargets[2])
    return true
  }
  return false
}

/** Helper: add 4 rectangle lines with corner/edge/dimension constraints.
 *  Returns the 4 line IDs [lA, lB, lC, lD] for use in additional constraints.
 */
function _applyRectLines(
  // Only the two containers this body indexes. The corner constraints go through
  // applyAddConstraint, which materializes `constraints` itself.
  feature: PartFeature & Pick<SketchLists, 'entities' | 'initial'>,
  featureId: string,
  doc: PartDoc,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): [string, string, string, string] {
  const [lA, lB, lC, lD] = freshEntityIds(feature.entities, 4)
  const fid = featureId

  const lines: [string, number[]][] = [
    [lA, [x0, y0, x1, y0]],
    [lB, [x1, y0, x1, y1]],
    [lC, [x1, y1, x0, y1]],
    [lD, [x0, y1, x0, y0]],
  ]
  for (const [eid, params] of lines) {
    feature.entities.push({ id: eid, kind: 'line' })
    feature.initial[eid] = params.map(round)
  }

  applyAddConstraint(doc, fid, 'coincident',   [`vertex:${fid}:${lA}:end`,  `vertex:${fid}:${lB}:start`])
  applyAddConstraint(doc, fid, 'coincident',   [`vertex:${fid}:${lB}:end`,  `vertex:${fid}:${lC}:start`])
  applyAddConstraint(doc, fid, 'coincident',   [`vertex:${fid}:${lC}:end`,  `vertex:${fid}:${lD}:start`])
  applyAddConstraint(doc, fid, 'coincident',   [`vertex:${fid}:${lD}:end`,  `vertex:${fid}:${lA}:start`])
  applyAddConstraint(doc, fid, 'equal_length', [`entity:${fid}:${lA}`,      `entity:${fid}:${lC}`])
  applyAddConstraint(doc, fid, 'equal_length', [`entity:${fid}:${lB}`,      `entity:${fid}:${lD}`])
  applyAddConstraint(doc, fid, 'horizontal',   [`entity:${fid}:${lA}`])
  applyAddConstraint(doc, fid, 'vertical',     [`entity:${fid}:${lB}`])

  return [lA, lB, lC, lD]
}

// ─── Sketch mutations ───

export function applyMoveVertex(
  doc: PartDoc,
  featureId: string,
  entityId: string,
  vertexKey: string,
  to: [number, number],
  solvedGeometry?: Record<string, number[]>,
): void {
  const feature = findFeature(doc, featureId)
  if (!feature?.initial) return
  // A non-finite drop position is broken pointer math upstream. round(NaN) is
  // still NaN, so letting it through would persist the poison into the doc and
  // into every later solve seeded from it.
  if (!Number.isFinite(to[0]) || !Number.isFinite(to[1])) {
    warn('applyMoveVertex: ignoring non-finite drop position', { featureId, entityId, vertexKey, to })
    return
  }
  // The adopted frame already carries the other vertices; this one is then
  // teleported onto the drop position below.
  adoptSolvedGeometry(feature.initial, solvedGeometry)
  const params = feature.initial[entityId]
  if (!params) return
  const kind = feature.entities?.find(e => e.id === entityId)?.kind
  if (!kind) return
  const indices = VERTEX_INDICES[kind]?.[vertexKey]
  if (indices) {
    params[indices[0]] = round(to[0])
    params[indices[1]] = round(to[1])
    return
  }
  // Ellipse axis endpoints are derived from center/a/b/theta, so like the arc
  // endpoints below they have no direct param pair. Invert the drop position
  // back into (a, b, theta) (params: [cx, cy, a, b, theta]).
  if (kind === 'ellipse' && isEllipseAxisKey(vertexKey)) {
    const next = ellipseAxisDrag(params, vertexKey, to)
    if (!next) return
    params[2] = round(next.a)
    params[3] = round(next.b)
    params[4] = round(next.theta)
    return
  }
  // Arc start/end are derived (center + radius at an angle), so they have no
  // direct param pair. Map the drop position into the arc's radius and angle
  // (params: [cx, cy, radius, angle_start, angle_end]) so the endpoint lands on
  // `to`. The center is whatever the drag frame solved to (already in params).
  if (kind === 'arc' && (vertexKey === 'start' || vertexKey === 'end')) {
    const dx = to[0] - params[0]
    const dy = to[1] - params[1]
    params[2] = round(Math.hypot(dx, dy))
    const ai = vertexKey === 'start' ? 3 : 4
    let ang = (Math.atan2(dy, dx) * 180) / Math.PI
    ang += Math.round((params[ai] - ang) / 360) * 360
    params[ai] = round(ang)
  }
}

export function applyMoveEntity(
  doc: PartDoc,
  featureId: string,
  entityId: string,
  delta: [number, number],
  solvedGeometry?: Record<string, number[]>,
): void {
  const [dx, dy] = delta
  const feature = findFeature(doc, featureId)
  if (!feature?.initial) return
  // A non-finite delta is broken pointer math upstream (a drag frame divided by
  // a zero extent, or an empty numeric input parsed). round(NaN) is still NaN,
  // so the translate would persist the poison into the doc and every later
  // solve. Refuse before adopting any solved frame: a bad delta must not also
  // half-commit by adopting the frame it arrived with.
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) {
    warn('applyMoveEntity: ignoring non-finite delta', { featureId, entityId, delta })
    return
  }

  // The adopted frame already reflects the translated position, so `delta` must
  // not be applied on top of it (that would translate twice).
  if (adoptSolvedGeometry(feature.initial, solvedGeometry)) return

  if (dx === 0 && dy === 0) return
  const params = feature.initial[entityId]
  if (!params) return
  const kind = feature.entities?.find(e => e.id === entityId)?.kind
  if (!kind) return
  const coordPairs = ALL_COORD_INDICES[kind]
  if (!coordPairs) return
  for (const [xi, yi] of coordPairs) {
    params[xi] = round(params[xi] + dx)
    params[yi] = round(params[yi] + dy)
  }
}

/** Drag commit for a circle whose centre is pinned: the rim drag changed the
  *  radius instead of translating. Adopts the last WASM drag frame first (so the
  *  other entities reflect the on-screen solve), rejects a non-finite or
  *  non-positive radius the way applyMoveVertex rejects a non-finite drop, then
  *  writes params[2] = radius. Only acts on a circle; a non-circle entity is left
  *  untouched. */
export function applyResizeCircle(
  doc: PartDoc,
  featureId: string,
  entityId: string,
  radius: number,
  solvedGeometry?: Record<string, number[]>,
): void {
  const feature = findFeature(doc, featureId)
  if (!feature?.initial) return
  // A non-finite or non-positive radius is broken pointer math upstream, or an
  // attempt to invert the circle. round(NaN) is still NaN, so letting it through
  // would poison the doc and every later solve seeded from it.
  if (!Number.isFinite(radius) || radius <= 0) {
    warn('applyResizeCircle: ignoring non-finite or non-positive radius', { featureId, entityId, radius })
    return
  }
  // The adopted frame already carries the on-screen solve; only the radius is
  // then pinned onto it below.
  adoptSolvedGeometry(feature.initial, solvedGeometry)
  const params = feature.initial[entityId]
  if (!params) return
  const kind = feature.entities?.find(e => e.id === entityId)?.kind
  if (kind !== 'circle') return
  params[2] = round(radius)
}

export function applyAddConstraint(
  doc: PartDoc,
  featureId: string,
  kind: string,
  targets: string[],
  value?: number,
  pos?: [number, number],
  sign?: number,
): void {
  const feature = resolveSketch(doc, featureId, 'constraints')
  if (!feature) return
  // Materialize-on-reference: an inferred-point handle target (`dock:`/`isect:`)
  // promotes to a real point before the constraint is built, so the rest of this
  // function never sees one. A null return means a dock handle named a contact
  // the document can no longer materialize; authoring the raw handle would persist
  // a `$dock:` literal the solver can never resolve, so the whole pick is dropped.
  const resolved = _resolveInferredTargets(doc, featureId, targets)
  if (!resolved) {
    warn('applyAddConstraint: unresolvable inferred target, skipping', { featureId, kind, targets })
    return
  }
  targets = resolved
  const cid = uniqueConstraintId(feature.constraints, kind)
  const c: PartConstraint = { id: cid, kind }
  const pt = (t: string) => parseTarget(t, featureId)
  if (kind === 'midpoint') {
    if (!applyMidpointConstraint(c, targets, pt)) {
      warn('applyAddConstraint: unrecognized midpoint target combination', targets)
      return
    }
  } else if (kind === 'horizontal' || kind === 'vertical') {
    // Overloaded: one line -> `target` (make the line axis-aligned); two points
    // -> `a`/`b` (share a coordinate). The a/b form is only meaningful for two
    // points: a whole-entity operand (a circle or extra line picked up alongside
    // the real target) resolves to a single sub-point and yields a degenerate
    // residual that is often already satisfied, so the line never turns vertical.
    // Reject that combination instead of authoring a dead constraint.
    // See bugreports/vertical_constraint_20260621_102915.md.
    // Same min-guard as the generic branch below: an empty pick falls through
    // both forms and would author an operand-less constraint the solver can
    // only read as garbage.
    if (targets.length < 1) {
      warn(`applyAddConstraint: ${kind} needs a target`, targets)
      return
    }
    if (targets.length >= 2) {
      if (targets[0].startsWith('entity:') || targets[1].startsWith('entity:')) {
        warn(`applyAddConstraint: ${kind} needs one line or two points, got`, targets)
        return
      }
      c.a = pt(targets[0])
      c.b = pt(targets[1])
    } else if (targets.length === 1) {
      c.target = pt(targets[0])
    }
  } else {
    // Generic kinds need operands: coincident pairs two refs, everything else
    // at least one. An empty (or single-target coincident) pick used to fall
    // through every branch and author an operand-less -- or half-authored --
    // constraint the solver can only read as garbage.
    const min = kind === 'coincident' ? 2 : 1
    if (targets.length < min) {
      warn(`applyAddConstraint: ${kind} needs ${min === 1 ? 'a target' : 'two targets'}, got`, targets)
      return
    }
    if (targets.length >= 2) {
      c.a = pt(targets[0])
      c.b = pt(targets[1])
    } else {
      c.target = pt(targets[0])
    }
  }
  // A dimension value, label position, or sign is persisted verbatim into the
  // doc. A non-finite one would round into the document and poison every later
  // solve, so each is gated here exactly like applySetConstraintValue/Pos.
  if (value !== undefined && Number.isFinite(value)) c.value = value
  if (pos !== undefined && Number.isFinite(pos[0]) && Number.isFinite(pos[1])) c.pos = pos
  if (sign !== undefined && Number.isFinite(sign)) c.sign = sign
  feature.constraints.push(c)
}

export function applyToggleConstruction(doc: PartDoc, targets: string[]): void {
  const byFeature: Record<string, Set<string>> = {}
  for (const t of targets) {
    const parts = t.split(':')
    if (parts[0] !== 'entity') continue
    const fid = parts[1]
    const eid = parts[2]
    if (!byFeature[fid]) byFeature[fid] = new Set()
    byFeature[fid].add(eid)
  }
  for (const [fid, eids] of Object.entries(byFeature)) {
    const feature = findFeature(doc, fid)
    if (!feature?.entities) continue
    for (const def of feature.entities) {
      if (eids.has(def.id) && def.kind !== 'point') {
        if (def.construction) delete def.construction
        else def.construction = true
      }
    }
  }
}

export function applyDeleteElements(doc: PartDoc, targets: string[]): void {
  const byFeature: Record<string, { entities: Set<string>; constraints: Set<string> }> = {}
  for (const t of targets) {
    const parts = t.split(':')
    const fid = parts[1]
    if (!byFeature[fid]) byFeature[fid] = { entities: new Set(), constraints: new Set() }
    if (parts[0] === 'entity') byFeature[fid].entities.add(parts[2])
    if (parts[0] === 'constraint') byFeature[fid].constraints.add(parts[2])
    if (parts[0] === 'vertex') byFeature[fid].entities.add(parts[2])
  }
  for (const [fid, { entities: entsToDelete, constraints: consToDelete }] of Object.entries(byFeature)) {
    const feature = findFeature(doc, fid)
    if (!feature) continue
    if (entsToDelete.size > 0) {
      if (feature.entities) feature.entities = feature.entities.filter(e => !entsToDelete.has(e.id))
      if (feature.initial) for (const eid of entsToDelete) delete feature.initial[eid]
      // Garbage-collect constraints that reference deleted entities.
      if (feature.constraints) {
        for (const c of feature.constraints) {
          if (_refsDeletedEntity(c, entsToDelete)) consToDelete.add(c.id)
          // An n-gon survives losing its circumcircle: it stays regular and just
          // has no center any more, so only the circle field goes.
          else if (c.circle !== undefined && _refMatchesDeleted(c.circle, entsToDelete)) delete c.circle
        }
      }
    }
    if (consToDelete.size > 0 && feature.constraints) {
      feature.constraints = feature.constraints.filter(c => !consToDelete.has(c.id))
    }
  }
}

export function applySetConstraintValue(
  doc: PartDoc,
  featureId: string,
  constraintId: string,
  value: number,
): void {
  const feature = findFeature(doc, featureId)
  if (!feature?.constraints) return
  // A dimension value is persisted verbatim into the doc; a NaN/Inf must be
  // rejected at the boundary rather than rounded into it.
  if (!Number.isFinite(value)) {
    warn('applySetConstraintValue: ignoring non-finite value', { featureId, constraintId, value })
    return
  }
  const c = feature.constraints.find(c => c.id === constraintId)
  if (c) c.value = Math.round(value * 1000) / 1000
}

export function applySetConstraintPos(
  doc: PartDoc,
  featureId: string,
  constraintId: string,
  pos: [number, number],
): void {
  const feature = findFeature(doc, featureId)
  if (!feature?.constraints) return
  // Same boundary as applySetConstraintValue: label positions are stored, not
  // derived, so a non-finite coordinate would persist as-is.
  if (!Number.isFinite(pos[0]) || !Number.isFinite(pos[1])) {
    warn('applySetConstraintPos: ignoring non-finite position', { featureId, constraintId, pos })
    return
  }
  const c = feature.constraints.find(c => c.id === constraintId)
  if (c) c.pos = [round(pos[0]), round(pos[1])]
}

/** Set the orientation sign (+1 / -1) of a directional dimension. Normalized to
 *  +1/-1 so a stray magnitude can never leak into the residual scaling. */
export function applySetConstraintSign(
  doc: PartDoc,
  featureId: string,
  constraintId: string,
  sign: number,
): void {
  const feature = findFeature(doc, featureId)
  if (!feature?.constraints) return
  const c = feature.constraints.find(c => c.id === constraintId)
  if (c) c.sign = sign < 0 ? -1 : 1
}

export function applyAddEntity(
  doc: PartDoc,
  featureId: string,
  kind: string,
  params: number[],
  entityId?: string,
): void {
  const feature = resolveSketch(doc, featureId, 'entities', 'initial')
  if (!feature) return
  // The seed params are persisted verbatim into the doc. round(NaN) is still
  // NaN, so a non-finite coordinate would survive into the YAML and every later
  // solve seeded from it.
  if (!allFinite(params)) {
    warn('applyAddEntity: ignoring non-finite seed params', { featureId, kind, params })
    return
  }
  const eid = mintEntityId(feature.entities, entityId)
  feature.entities.push({ id: eid, kind })
  feature.initial[eid] = params.map(round)
}

export function applyAddProjectedEntity(
  doc: PartDoc,
  featureId: string,
  kind: string,
  source: string,
  entityId?: string,
): void {
  const feature = resolveSketch(doc, featureId, 'entities')
  if (!feature) return
  feature.entities.push({ id: mintEntityId(feature.entities, entityId), kind, source })
}

export function applyAddEntityWithConstraint(
  doc: PartDoc,
  featureId: string,
  kind: string,
  params: number[],
  vertexKey: string,
  snapVertexId: string | undefined,
  constraintKind: string,
  snapEntityRef?: string,
  entityId?: string,
): void {
  const feature = resolveSketch(doc, featureId, 'entities', 'initial', 'constraints')
  if (!feature) return
  // Seed params are persisted verbatim (same gate as applyAddEntity); refusing
  // here keeps the snap constraint from being authored against an entity that
  // was never created.
  if (!allFinite(params)) {
    warn('applyAddEntityWithConstraint: ignoring non-finite seed params', { featureId, kind, params })
    return
  }
  const eid = mintEntityId(feature.entities, entityId)
  feature.entities.push({ id: eid, kind })
  feature.initial[eid] = params.map(round)

  let target: string
  if (snapEntityRef) {
    // Entity path snap: constraint references the entity directly
    target = snapEntityRef
  } else if (snapVertexId && snapVertexId.startsWith('@builtin_')) {
    target = snapVertexId
  } else if (snapVertexId) {
    // Use snapVertexId directly: it encodes "vertex:sourceFeatId:entityId:key".
    // Reconstructing with featureId would break cross-sketch snaps by replacing
    // the source feature ID with the current sketch's ID.
    target = snapVertexId
  } else {
    return
  }

  // Create constraint between new entity vertex and snapped target
  applyAddConstraint(doc, featureId, constraintKind, [
    `vertex:${featureId}:${eid}:${vertexKey}`,
    target,
  ])
}

/** Materialize a real `point` entity at a curve-curve contact (a tangency or an
 *  intersection) and pin it to every curve through the point with a
 *  `coincident`-to-locus constraint.
 *
 *  Point-on-curve is just the locus form of `coincident` (see `r_coincident` in
 *  the solver): `coincident(pointVertex, entityLocus)` -- where the locus ref is
 *  the whole entity `entity:<fid>:<eid>` with no vertexKey -- keeps the point on
 *  that curve. With >= 2 curves the point is pinned to the contact and stays
 *  there as the sketch solves, so it becomes a normal draggable point that other
 *  constraints can reference. Fewer than 2 distinct usable loci authors a free
 *  point with no constraint: a single locus is not an intersection. */
export function applyAddPointAtIntersection(
  doc: PartDoc,
  featureId: string,
  at: [number, number],
  curveEntityIds: string[],
): string | null {
  const feature = resolveSketch(doc, featureId, 'entities', 'initial')
  if (!feature) return null
  // The contact location is persisted verbatim as the point's seed. A malformed
  // `isect:` handle parses to NaN upstream, so the gate lives here rather than
  // at the one call seam: null tells the caller nothing was materialized.
  if (!allFinite(at)) {
    warn('applyAddPointAtIntersection: ignoring non-finite location', { featureId, at })
    return null
  }

  // Usable loci: distinct, existing, non-point curves. A point entity has no
  // locus to lie on; construction curves are allowed (a construction tangency is
  // still a real contact point).
  const seen = new Set<string>()
  const loci: string[] = []
  for (const cid of curveEntityIds) {
    if (seen.has(cid)) continue
    seen.add(cid)
    const def = feature.entities.find(e => e.id === cid)
    if (!def || def.kind === 'point') continue
    loci.push(cid)
  }

  const eid = mintEntityId(feature.entities)
  feature.entities.push({ id: eid, kind: 'point' })
  feature.initial[eid] = [round(at[0]), round(at[1])]

  if (loci.length < 2) return eid  // not an intersection; leave a free point
  for (const cid of loci) {
    applyAddConstraint(doc, featureId, 'coincident', [
      `vertex:${featureId}:${eid}:xy`,
      `entity:${featureId}:${cid}`,
    ])
  }
  return eid
}

/** Materialize the inferred point of a dockable host (lazy inferred
 *  materialization). Inserts a real `point` entity P seeded at the host's current
 *  contact location and a `dock` constraint tying P to the host. The dock lowers
 *  (in `partDocToSketches`) to operand locus pins reusing the existing coincident
 *  primitive -- no new solver constraint. P is an ordinary point thereafter: other
 *  constraints reference it, it is draggable, and deleting the host just floats it.
 *
 *  Idempotent: a second materialization of the same host reuses the existing P,
 *  so naming the same contact twice never spawns a duplicate point.
 *
 *  Returns the materialized point's entity id (new or reused), or null when the
 *  host does not exist. The id lets the caller rewrite an authored constraint to
 *  reference the point -- the materialize-on-reference path in applyAddConstraint. */
export function applyAddDock(
  doc: PartDoc,
  featureId: string,
  at: [number, number],
  hostConstraintId: string,
): string | null {
  const feature = resolveSketch(doc, featureId, 'entities', 'initial', 'constraints')
  if (!feature) return null

  const host = feature.constraints.find(c => c.id === hostConstraintId)
  if (!host) return null  // nothing to dock to

  // Idempotent: reuse the point of an existing dock on the same host. The seed
  // is unused on this path, so it is gated only below where it is persisted.
  const existingDock = feature.constraints.find(c => c.kind === 'dock' && c.host === hostConstraintId)
  if (existingDock) return _dockPointId(existingDock, new Set(feature.entities.map(e => e.id)))

  // The contact seed is written verbatim. dockLocationOf can hand back a
  // non-finite pair for a degenerate host, so gate before the point is minted.
  if (!allFinite(at)) {
    warn('applyAddDock: ignoring non-finite contact location', { featureId, hostConstraintId, at })
    return null
  }

  const eid = mintEntityId(feature.entities)
  feature.entities.push({ id: eid, kind: 'point' })
  feature.initial[eid] = [round(at[0]), round(at[1])]

  const cid = uniqueConstraintId(feature.constraints, 'dock')
  feature.constraints.push({
    id: cid,
    kind: 'dock',
    point: parseTarget(`vertex:${featureId}:${eid}:xy`, featureId),
    host: hostConstraintId,
  })
  return eid
}

/** Extract the point entity id a `dock` constraint names, from either the live
 *  `$<eid>xy` wire form or the resolved `{entity, point}` dict form. */
function _dockPointId(dock: PartConstraint, knownIds: Set<string>): string | null {
  const ref = dock.point
  if (ref && typeof ref === 'object') {
    const e = (ref as { entity?: unknown }).entity
    // Membership matters as much here as on the wire form below: a dict ref left
    // behind by a deleted point would hand the caller a dead id, and the
    // idempotence reuse in applyAddDock would rewrite a constraint onto it.
    return typeof e === 'string' && knownIds.has(e) ? e : null
  }
  if (typeof ref === 'string' && ref.startsWith('$')) {
    const bare = ref.slice(1)
    if (bare.endsWith('xy')) {
      const eid = bare.slice(0, -2)
      if (knownIds.has(eid)) return eid
    }
  }
  return null
}

/** Materialize-on-reference: replace any inferred-point handle in a constraint's
 *  target list with the vertex ref of its materialized point. Naming an inferred
 *  point is what makes it real (lazy inferred materialization). Two handle kinds,
 *  the two halves of the inferred set:
 *
 *  - `dock:<featureId>:<hostId>` -- a dockable host's contact (today a tangent).
 *    Inserts the point + `dock` constraint (or reuses one); the seed is recomputed
 *    from current params via `dockLocationOf`, never carried on the handle.
 *  - `isect:<featureId>:<x>:<y>:<curveA>:<curveB>...` -- a free curve-curve
 *    intersection (no host). The contributing curves are baked into the handle at
 *    pick time, so this just calls `applyAddPointAtIntersection`.
 *
 *  Non-handle targets pass through untouched. Returns null when a `dock:` handle
 *  cannot materialize (its host already carries a dock whose point entity is
 *  gone): there is no vertex to point at and persisting the handle itself would
 *  author an unresolvable `$dock:` ref, so the caller must drop the pick. */
function _resolveInferredTargets(doc: PartDoc, featureId: string, targets: string[]): string[] | null {
  if (!targets.some(t => t.startsWith('dock:') || t.startsWith('isect:'))) return targets
  const feature = findFeature(doc, featureId)
  if (!feature) return targets
  const resolved: string[] = []
  for (const t of targets) {
    if (t.startsWith('dock:')) {
      const parts = t.split(':')
      const fid = parts[1]
      const hostId = parts.slice(2).join(':')  // host ids are colon-free base64url, but be safe
      const at = dockLocationOf(feature.entities ?? [], feature.constraints ?? [], feature.initial ?? {}, hostId)
      const pid = applyAddDock(doc, fid, at ?? [0, 0], hostId)
      if (!pid) return null
      resolved.push(`vertex:${fid}:${pid}:xy`)
      continue
    }
    if (t.startsWith('isect:')) {
      const parts = t.split(':')  // isect, fid, x, y, ...curveIds
      const fid = parts[1]
      // A malformed handle parses to NaN; applyAddPointAtIntersection gates on
      // that itself and returns null, so the target is left alone below rather
      // than rewritten to a NaN pose.
      const at: [number, number] = [parseFloat(parts[2]), parseFloat(parts[3])]
      const curves = parts.slice(4)
      const pid = applyAddPointAtIntersection(doc, fid, at, curves)
      resolved.push(pid ? `vertex:${fid}:${pid}:xy` : t)
      continue
    }
    resolved.push(t)
  }
  return resolved
}

/** Pin the sugar entity's own vertices to what the draw clicks snapped onto,
 *  in click order. Each ref is a `vertex:` ref (a point pair) or an `entity:`
 *  ref (the locus form, a point on that curve); both are one `coincident`. Two
 *  clicks on the same vertex say one thing, so only the first is authored; two
 *  clicks on the same curve are two points on it and both are pinned. Same
 *  rule (`sameSnapVertex`) as the line/arc/spline tools apply to their ends. */
function _pinSnappedVertices(
  doc: PartDoc,
  featureId: string,
  pins: [vertexRef: string, snapRef: string | null | undefined][],
): void {
  const pinned: string[] = []
  for (const [vertexRef, snapRef] of pins) {
    if (!snapRef || pinned.some(p => sameSnapVertex(p, snapRef))) continue
    pinned.push(snapRef)
    applyAddConstraint(doc, featureId, 'coincident', [vertexRef, snapRef])
  }
}

export function applyAddRect(
  doc: PartDoc,
  featureId: string,
  p0: [number, number],
  p1: [number, number],
  p0Ref?: string | null,
  p1Ref?: string | null,
): void {
  const [x0, y0] = p0
  const [x1, y1] = p1
  // The draw tool refuses a degenerate second click itself; this is the
  // backstop for any other caller. Bail before anything, even container
  // materialization, touches the document.
  if (!isProperRect(x0, y0, x1, y1)) {
    warn('applyAddRect: degenerate rectangle skipped', { p0, p1 })
    return
  }
  const feature = resolveSketch(doc, featureId, 'entities', 'initial', 'constraints')
  if (!feature) return

  // _applyRectLines starts lA at (x0, y0) and lC at the diagonal (x1, y1).
  const [lA, , lC] = _applyRectLines(feature, featureId, doc, x0, y0, x1, y1)
  _pinSnappedVertices(doc, featureId, [
    [`vertex:${featureId}:${lA}:start`, p0Ref],
    [`vertex:${featureId}:${lC}:start`, p1Ref],
  ])
}

export function applyAddCenterRect(
  doc: PartDoc,
  featureId: string,
  center: [number, number],
  corner: [number, number],
  centerRef?: string | null,
  cornerRef?: string | null,
): void {
  const [cx, cy] = center
  // 4 corners of the rectangle (symmetric around center); (x1, y1) is the click.
  const [x0, y0, x1, y1] = centerRectCorners(center, corner)
  // Same guard as applyAddRect, on the derived corners so one collapsed axis is
  // caught too; here it must also keep the center point and its two diagonal
  // midpoint constraints from being authored.
  if (!isProperRect(x0, y0, x1, y1)) {
    warn('applyAddCenterRect: degenerate rectangle skipped', { center, corner })
    return
  }
  const feature = resolveSketch(doc, featureId, 'entities', 'initial', 'constraints')
  if (!feature) return

  const [lA, lB, lC, lD] = _applyRectLines(feature, featureId, doc, x0, y0, x1, y1)

  // Create point entity at center
  const pointId = mintEntityId(feature.entities)
  feature.entities.push({ id: pointId, kind: 'point' })
  feature.initial[pointId] = [cx, cy].map(round)

  // The center point is the midpoint of each diagonal. Which corner is "top" or
  // "left" depends on where the user clicked, so the corners are named by the
  // click: (x1, y1) is the clicked corner, (x0, y0) its mirror through center.
  // Diagonal 1: lA:start (x0, y0, the mirror) to lC:start (x1, y1, the click)
  applyAddConstraint(doc, featureId, 'midpoint', [
    `vertex:${featureId}:${lA}:start`,
    `vertex:${featureId}:${lC}:start`,
    `vertex:${featureId}:${pointId}:xy`,
  ])
  // Diagonal 2: lB:start (x1, y0) to lD:start (x0, y1)
  applyAddConstraint(doc, featureId, 'midpoint', [
    `vertex:${featureId}:${lB}:start`,
    `vertex:${featureId}:${lD}:start`,
    `vertex:${featureId}:${pointId}:xy`,
  ])

  // The clicked corner is (x1, y1), where lC starts.
  _pinSnappedVertices(doc, featureId, [
    [`vertex:${featureId}:${pointId}:xy`, centerRef],
    [`vertex:${featureId}:${lC}:start`, cornerRef],
  ])
}

/** N-gon sugar: N line entities forming a closed coincident chain, a
 *  construction circumcircle, and a single `ngon` regularity constraint. The
 *  lines store the circumscribed polygon (vertices on the circumcircle through
 *  `corner`); the circle's center is the polygon's center vertex and its radius
 *  the circumradius, both dimensionable. The `ngon` constraint is expanded at
 *  solve time to equal-length + angle primitives plus the vertex-on-circle
 *  coupling, so the solver never sees a real `ngon` kind. */
export function applyAddNgon(
  doc: PartDoc,
  featureId: string,
  center: [number, number],
  corner: [number, number],
  sides: number,
  cornerRef?: string | null,
  centerRef?: string | null,
): void {
  const feature = resolveSketch(doc, featureId, 'entities', 'initial', 'constraints')
  if (!feature) return

  const n = Math.max(3, Math.floor(sides))
  const [cx, cy] = center
  const [vx, vy] = corner
  // A non-finite center, corner, or side count is broken pointer math upstream.
  // round(NaN) is still NaN, so a bad corner would seed NaN vertices for every
  // side, and a NaN side count collapses the push loop. Refuse before anything
  // is authored, so no orphan `ngon` constraint is left behind with no lines.
  if (!allFinite([cx, cy, vx, vy]) || !Number.isFinite(sides)) {
    warn('applyAddNgon: ignoring non-finite geometry', { featureId, center, corner, sides })
    return
  }
  const radius = Math.hypot(vx - cx, vy - cy)
  if (radius <= 0) return  // degenerate: a point, not a polygon
  const angle0 = Math.atan2(vy - cy, vx - cx)

  const lineIds = freshEntityIds(feature.entities, n)
  for (let i = 0; i < n; i++) {
    const id = lineIds[i]
    const a1 = angle0 + (i / n) * 2 * Math.PI
    const a2 = angle0 + ((i + 1) / n) * 2 * Math.PI
    feature.entities.push({ id, kind: 'line' })
    feature.initial[id] = [
      cx + radius * Math.cos(a1), cy + radius * Math.sin(a1),
      cx + radius * Math.cos(a2), cy + radius * Math.sin(a2),
    ].map(round)
  }

  // Closed coincident chain: each line's end meets the next line's start.
  for (let i = 0; i < n; i++) {
    applyAddConstraint(doc, featureId, 'coincident', [
      `vertex:${featureId}:${lineIds[i]}:end`,
      `vertex:${featureId}:${lineIds[(i + 1) % n]}:start`,
    ])
  }

  // The circumcircle carries the n-gon's center. Construction, so it never
  // becomes profile geometry.
  const circleId = mintEntityId(feature.entities)
  feature.entities.push({ id: circleId, kind: 'circle', construction: true })
  feature.initial[circleId] = [cx, cy, radius].map(round)

  // The single regularity constraint, which also owns the circle coupling.
  // Deleting it "breaks" the n-gon: the closed line chain becomes an editable
  // irregular polygon and the circle a free construction circle.
  const cid = uniqueConstraintId(feature.constraints, 'ngon')
  feature.constraints.push({
    id: cid,
    kind: 'ngon',
    refs: lineIds.map(eid => parseTarget(`entity:${featureId}:${eid}`, featureId)),
    circle: parseTarget(`entity:${featureId}:${circleId}`, featureId),
  })

  // Click order: the center click first, then the corner, where the first line
  // starts (angle0).
  _pinSnappedVertices(doc, featureId, [
    [`vertex:${featureId}:${circleId}:center`, centerRef],
    [`vertex:${featureId}:${lineIds[0]}:start`, cornerRef],
  ])
}

/** Compute the offset seed params for a cloned entity: the source geometry moved
 *  by `distance`, with the sign selecting the side. Returns null for a degenerate
 *  source (a zero-length line) that has no well-defined normal.
 *
 *  Sign convention (locked by tests so a refactor cannot silently flip it): a
 *  positive `distance` moves a line along the LEFT normal of its start->end
 *  direction `(-dy, dx)/L`, and grows the radius of a circle/arc (outward).
 *  Spline/ellipse have no clean parametric offset, so the seed is an exact copy.
 *  Shared with the connected-profile offset so both author identical seeds. */
function offsetSeed(kind: string, p: number[], distance: number): number[] | null {
  switch (kind) {
    case 'line': {
      const dx = p[2] - p[0], dy = p[3] - p[1]
      const L = Math.hypot(dx, dy)
      if (L < 1e-9) return null  // no direction, hence no normal: caller skips it
      const nx = -dy / L, ny = dx / L
      return [p[0] + distance * nx, p[1] + distance * ny,
              p[2] + distance * nx, p[3] + distance * ny]
    }
    case 'circle':
      return [p[0], p[1], Math.max(1e-6, p[2] + distance)]
    case 'arc':
      return [p[0], p[1], Math.max(1e-6, p[2] + distance), p[3], p[4]]
    default:
      return [...p]  // spline / ellipse: copy at source
  }
}

/** Reconnect the corners among offset clones: miter line/line corners to the
 *  intersection of the two *seeded* (untrimmed) offset lines (NOT the offset of
 *  the shared vertex), and carry line/arc and arc/arc tangency over so the
 *  solver settles the fillet join. Snapshot the seeds before trimming endpoints
 *  -- otherwise the second corner of a shared line would intersect an
 *  already-moved line and drift. Spline/ellipse corners stay ungrafted (matches
 *  the copy-at-source clone policy). */
function reconnectOffsetCorners(
  doc: PartDoc,
  feature: PartFeature & Pick<SketchLists, 'initial' | 'constraints'>,
  featureId: string,
  cloneOf: Map<string, string>,
  kindOf: Map<string, string>,
): void {
  const initial = feature.initial
  const seedSnapshot = new Map<string, number[]>()
  for (const cloneId of cloneOf.values()) seedSnapshot.set(cloneId, [...initial[cloneId]])

  const curved = (k: string | undefined) => k === 'arc' || k === 'circle'
  for (const corner of offsetCorners([...cloneOf.keys()], feature.constraints)) {
    const cloneA = cloneOf.get(corner.a.entityId)
    const cloneB = cloneOf.get(corner.b.entityId)
    if (!cloneA || !cloneB) continue
    const kindA = kindOf.get(corner.a.entityId)
    const kindB = kindOf.get(corner.b.entityId)

    if (kindA === 'line' && kindB === 'line') {
      const ix = lineIntersect(seedSnapshot.get(cloneA)!, seedSnapshot.get(cloneB)!)
      if (!ix) continue  // near-parallel: leave the gap, no coincident, no crash
      const ia = lineVertexIndices(corner.a.vertexKey)
      const ib = lineVertexIndices(corner.b.vertexKey)
      if (!ia || !ib) continue
      const pa = initial[cloneA], pb = initial[cloneB]
      pa[ia[0]] = round(ix[0]); pa[ia[1]] = round(ix[1])
      pb[ib[0]] = round(ix[0]); pb[ib[1]] = round(ix[1])
      applyAddConstraint(doc, featureId, 'coincident', [
        `vertex:${featureId}:${cloneA}:${corner.a.vertexKey}`,
        `vertex:${featureId}:${cloneB}:${corner.b.vertexKey}`,
      ])
    } else if ((kindA === 'line' && curved(kindB)) || (curved(kindA) && kindB === 'line') ||
               (curved(kindA) && curved(kindB))) {
      // line/arc or arc/arc: a fillet corner. Endpoints of an arc clone cannot be
      // mitered into place (the geometry is center+radius+angles), so carry the
      // tangency over and let the solver settle the join.
      applyAddConstraint(doc, featureId, 'tangent', [
        `entity:${featureId}:${cloneA}`,
        `entity:${featureId}:${cloneB}`,
      ])
    }
    // spline/ellipse corners: no clean offset relationship, leave them ungrafted
    // (matches the copy-at-source clone policy above).
  }
}

/** Offset: for each source entity, clone it and tie the copy to the source with
 *  ONLY a geometric relationship (parallel for lines, concentric for
 *  circles/arcs). The offset distance and direction are baked into the clone's
 *  initial geometry via `offsetSeed`, NOT stored as a dimension. The result is
 *  intentionally under-constrained: the clone holds its seeded position because
 *  nothing drives it, and the user dimensions it afterward if they want it
 *  driven. Authoring zero dimensions is deliberate -- offsetting a multi-line
 *  profile must not spray a dimension per entity, and baking the side into the
 *  seed removes the solver's freedom to flip the offset to the wrong side.
 *  Splines/ellipses have no clean offset, so only the (at-source) copy is made.
 *
 *  Connectivity carry-over: a *connected* selection (rectangle, n-gon, fillet
 *  chain) is held together by `coincident` corners. Offsetting each entity in
 *  isolation would tear those corners apart, so after cloning we rebuild every
 *  corner among the selected sources on the clones -- mitering line/line corners
 *  to the intersection of the two offset lines (NOT the offset of the shared
 *  vertex) and carrying line/arc tangency over with a `tangent`. Still no
 *  dimensions; the reconnection is the only added structure. */
export function applyAddOffset(
  doc: PartDoc,
  featureId: string,
  sourceIds: string[],
  distance: number,
): void {
  const feature = resolveSketch(doc, featureId, 'entities', 'initial', 'constraints')
  if (!feature) return
  // The distance is persisted verbatim into every clone's seed. round(NaN) is
  // still NaN, so a non-finite distance would seed NaN clones (plus their miter
  // reconnections) across the whole selection.
  if (!Number.isFinite(distance)) {
    warn('applyAddOffset: ignoring non-finite distance', { featureId, sourceIds, distance })
    return
  }

  const cloneOf = new Map<string, string>()  // source id -> clone id
  const kindOf = new Map<string, string>()   // source id -> entity kind

  for (const srcId of sourceIds) {
    const src = feature.entities.find(e => e.id === srcId)
    const srcParams = feature.initial[srcId]
    if (!src || !srcParams) continue

    const seed = offsetSeed(src.kind, srcParams, distance)
    if (!seed) continue  // degenerate source: no offset direction

    // Each clone is pushed before the next id is drawn, so reading the live list
    // is what keeps the run collision-free.
    const dstId = mintEntityId(feature.entities)
    feature.entities.push({ id: dstId, kind: src.kind })
    feature.initial[dstId] = seed.map(round)
    cloneOf.set(srcId, dstId)
    kindOf.set(srcId, src.kind)

    const srcRef = `entity:${featureId}:${srcId}`
    const dstRef = `entity:${featureId}:${dstId}`
    switch (src.kind) {
      case 'line':
        applyAddConstraint(doc, featureId, 'parallel', [srcRef, dstRef])
        break
      case 'circle':
      case 'arc':
        applyAddConstraint(doc, featureId, 'concentric', [srcRef, dstRef])
        break
      default:
        break  // spline / ellipse: copy only, no relationship
    }
  }

  // Reconnect the corners. Miter points are intersections of the *seeded*
  // (untrimmed) offset lines, so snapshot the seeds before we start trimming
  // endpoints -- otherwise the second corner of a shared line would intersect an
  // already-moved line and drift.
  reconnectOffsetCorners(doc, feature, featureId, cloneOf, kindOf)
}

export function applySetFeaturePlane(doc: PartDoc, featureId: string, plane: string): void {
  const feature = findFeature(doc, featureId)
  if (!feature) return
  feature.plane = plane
}
