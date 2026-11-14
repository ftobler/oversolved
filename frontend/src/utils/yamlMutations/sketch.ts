import type { PartDoc, PartConstraint, PartTarget } from '@/types/cad'
import { entityVertexIndices, entityCoordPairs } from '@/registry'
import {
  warn, round, allFinite, findSketchFeature, parseTarget, uniqueConstraintId,
  resolveSketch, mintEntityId, CONSTRAINT_REF_FIELDS, refMatchesEntity,
  canonicalLineDistanceTargets, isPointLikeEntityKind,
  pointDistanceZeroProblem,
} from './helpers'
import {
  ENTITY_SIZE_FLOOR, dimensionSizeProblem, entitySizeProblem,
} from '@/utils/entitySizeProblems'
import { resolveVertexRef } from '@/types/vertexRef'
import {
  addConstraintProblem, constraintTargetSide, midpointOperands, midpointShapeReason,
} from '@/utils/constraintProblems'
import { dockLocationOf } from '@/utils/geometry/dockHosts'
import { angleStoredValue } from '@/utils/geometry/dimensionNaturalValue'
import { unflattenGeometry } from '@/utils/geometry/geometryMapping'
import { isConstraintKindName } from '@/wasm-kernel/codec'
import { ellipseAxisDrag, isEllipseAxisKey } from '@/utils/geometry/ellipseAxis'
import { fitPointIndex } from '@/types/vertexKeys'
import { hidePlanesIfFirstBoundSketch } from './featureAdmin'
import { applyAddFitSpline, applyDeleteFitPoint, type FitSplineAddOptions } from './fitSpline'
import {
  deriveMemberIds, faceProjectionConstraintId, isFaceProjectionSource, reconcileFaceProjection,
} from '@/kernel/features/projectionMembers'
import type { FaceBoundaryLookup } from '@/kernel/features/faceBoundary'

// The rect/ngon/offset sugar lives in a sibling module so this file stays a
// focused set of the core sketch mutations. Re-exported here so the historical
// `@/utils/yamlMutations/sketch` import path keeps naming all of them.
export { applyAddRect, applyAddCenterRect, applyAddNgon, applyAddThreePointArc, applyAddOffset } from './sketchSugar'

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

// midpoint needs specific keys depending on selection:
//   entity + vertex  → line: $entity,  point: $vertex
//   3 vertices       → point_a: $v1, point_b: $v2, point: $v3
// The operands are classified by what they name, not by the `entity:`/`vertex:`
// prefix: the catalog also accepts a stored `$<entityId>`, a `$<entityId><key>`
// vertex and `@builtin_origin`, so all of those spell the same two shapes.
// Returns false when the target combination is unrecognized.
function applyMidpointConstraint(
  c: PartConstraint,
  targets: string[],
  pt: (t: string) => PartTarget,
  featureId: string,
  entityIds: ReadonlySet<string>,
  kindById: ReadonlyMap<string, string>,
): boolean {
  const operands = midpointOperands(targets, t => constraintTargetSide(t, featureId, entityIds, kindById))
  if (!operands) return false
  if ('line' in operands) {
    c.line = pt(operands.line)
    c.point = pt(operands.point)
    return true
  }
  c.point_a = pt(operands.point_a)
  c.point_b = pt(operands.point_b)
  c.point   = pt(operands.point)
  return true
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
  const feature = findSketchFeature(doc, featureId)
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
  const def = feature.entities?.find(e => e.id === entityId)
  if (!def) return
  // Instance-aware: a fit spline's `fit<k>`/`c1`/`c2` keys exist only in its
  // authored block, so its map is derived from the block length and handles.
  const indices = entityVertexIndices(def.kind, params.length, def.handles)?.[vertexKey]
  if (indices) {
    params[indices[0]] = round(to[0])
    params[indices[1]] = round(to[1])
    return
  }
  // Ellipse axis endpoints are derived from center/a/b/theta, so like the arc
  // endpoints below they have no direct param pair. Invert the drop position
  // back into (a, b, theta) (params: [cx, cy, a, b, theta]).
  if (def.kind === 'ellipse' && isEllipseAxisKey(vertexKey)) {
    // The handle clamp uses the same floor as the authoring boundary. A major
    // handle dropped inside b still arrives as a < b, which the boundary would
    // refuse, so check the whole candidate before touching the doc.
    const next = ellipseAxisDrag(params, vertexKey, to, ENTITY_SIZE_FLOOR)
    if (!next) return
    const candidate = [params[0], params[1], round(next.a), round(next.b), round(next.theta)]
    const problem = entitySizeProblem('ellipse', candidate)
    if (problem !== null) {
      warn(`applyMoveVertex: ${problem}`, { featureId, entityId, vertexKey, to })
      return
    }
    params[2] = candidate[2]
    params[3] = candidate[3]
    params[4] = candidate[4]
    return
  }
  // Arc start/end are derived (center + radius at an angle), so they have no
  // direct param pair. Map the drop position into the arc's radius and angle
  // (params: [cx, cy, radius, angle_start, angle_end]) so the endpoint lands on
  // `to`. The center is whatever the drag frame solved to (already in params).
  if (def.kind === 'arc' && (vertexKey === 'start' || vertexKey === 'end')) {
    const dx = to[0] - params[0]
    const dy = to[1] - params[1]
    const ai = vertexKey === 'start' ? 3 : 4
    let ang = (Math.atan2(dy, dx) * 180) / Math.PI
    ang += Math.round((params[ai] - ang) / 360) * 360
    // The endpoint is derived from radius and angle, so a drop on the centre or
    // on the other endpoint would store a zero radius or zero span. Judge the
    // whole candidate first; the old values stay on refusal.
    const candidate = [...params]
    candidate[2] = round(Math.hypot(dx, dy))
    candidate[ai] = round(ang)
    const problem = entitySizeProblem('arc', candidate)
    if (problem !== null) {
      warn(`applyMoveVertex: ${problem}`, { featureId, entityId, vertexKey, to })
      return
    }
    params[2] = candidate[2]
    params[ai] = candidate[ai]
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
  const feature = findSketchFeature(doc, featureId)
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
  const def = feature.entities?.find(e => e.id === entityId)
  if (!def) return
  const coordPairs = entityCoordPairs(def.kind, params.length, def.handles)
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
  const feature = findSketchFeature(doc, featureId)
  if (!feature?.initial) return
  // A non-finite radius is broken pointer math upstream. round(NaN) is still
  // NaN, so letting it through would poison the doc and every later solve
  // seeded from it.
  if (!Number.isFinite(radius)) {
    warn('applyResizeCircle: ignoring non-finite radius', { featureId, entityId, radius })
    return
  }
  // The same size floor as add_entity and the drive rule: zero, a negative
  // radius or one a hair above zero all enclose nothing, and the solve would
  // leave the circle out of every profile. Refuse before adopting the frame so
  // the drag commits no geometry the author cannot use.
  const sizeProblem = entitySizeProblem('circle', [0, 0, radius])
  if (sizeProblem !== null) {
    warn(`applyResizeCircle: ${sizeProblem}`, { featureId, entityId, radius })
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

/** A foreign operand parsed from its feature-qualified selection ref. */
interface ForeignOperand {
  sketchId: string
  entityId: string
  // The entity vertex the ref names, e.g. `start`; null for a whole-entity ref.
  vertexKey: string | null
}

/** Parse `entity:<sk>:<eid>` / `vertex:<sk>:<eid>:<key>` into a foreign operand,
 *  or null when the ref is local to `featureId` (a stored `$` ref, the builtin
 *  origin, a `dock:`/`isect:` handle) or names no feature-qualified sketch ref. */
function _parseForeignOperand(target: string, featureId: string): ForeignOperand | null {
  const parts = target.split(':')
  if (parts[0] !== 'entity' && parts[0] !== 'vertex') return null
  const sketchId = parts[1]
  const entityId = parts[2]
  if (!sketchId || !entityId || sketchId === featureId) return null
  if (parts[0] === 'entity') return { sketchId, entityId, vertexKey: null }
  const vertexKey = parts[3]
  return vertexKey ? { sketchId, entityId, vertexKey } : null
}

/** One projection a foreign operand needs before the constraint can name it. */
interface ForeignProjection {
  index: number
  source: string
  kind: string
  ref: string
}

/** The rewritten targets plus the projections to materialize once the
 *  constraint itself passes the shape checks. Nothing is written until then, so
 *  a refused pick (bad kind, operand count, redundancy, forward reference)
 *  leaves the document byte-identical and no orphan projection behind. */
interface ForeignProjectionPlan {
  targets: string[]
  created: Array<{ entityId: string; kind: string; source: string }>
}

/**
 * Plan the projections every operand naming another sketch's geometry needs, so
 * a cross-sketch snap authors the same visible, deletable held entity the
 * constraint command makes from a B-rep pick instead of a ref the solver can
 * never resolve (a stale reference).
 *
 * `null` drops the whole pick: a ref to a sketch that comes AFTER this one in
 * the tree is a forward reference the solve cannot resolve yet (the pick keeps
 * its position and authors no constraint, like a body snap), and a ref naming a
 * missing sketch or entity must not be persisted dead.
 */
function _planForeignTargets(
  doc: PartDoc,
  featureId: string,
  targets: readonly string[],
): ForeignProjectionPlan | null {
  const parsed = targets.map(target => _parseForeignOperand(target, featureId))
  if (parsed.every(op => op === null)) return { targets: [...targets], created: [] }
  const feature = findSketchFeature(doc, featureId)
  if (!feature) return null
  const features = doc.features ?? []
  const activeAt = features.findIndex(f => f.id === featureId)

  const planned: ForeignProjection[] = []
  const entities = feature.entities ?? []
  const constraints = feature.constraints ?? []
  // One entity per source, so an operand pair naming the same curve projects it
  // once whether the projection was already recorded or minted in this pick.
  const entityIdBySource = new Map<string, string>()
  for (let index = 0; index < parsed.length; index++) {
    const op = parsed[index]
    if (!op) continue
    const sourceAt = features.findIndex(f => f.id === op.sketchId)
    const sourceSketch = findSketchFeature(doc, op.sketchId)
    const sourceDef = sourceSketch?.entities?.find(e => e.id === op.entityId)
    if (sourceAt < 0 || !sourceDef) {
      warn('applyAddConstraint: snapped element does not resolve in its sketch', {
        featureId, sketchId: op.sketchId, entityId: op.entityId,
      })
      return null
    }
    if (activeAt >= 0 && sourceAt > activeAt) {
      warn('applyAddConstraint: ignoring a snap to a later sketch (forward reference)', {
        featureId, sketchId: op.sketchId,
      })
      return null
    }
    // A vertex source resolves through the owning sketch frame as a point; a
    // whole entity keeps its kind so the projection lowers as that curve.
    const source = op.vertexKey
      ? `@${op.sketchId}/${op.entityId}/${op.vertexKey}`
      : `@${op.sketchId}/${op.entityId}`
    let eid = entityIdBySource.get(source)
    if (eid === undefined) {
      const recorded = constraints.find(c => c.kind === 'projection' && c.source === source)
      const recordedId = recorded && typeof recorded.target === 'string' ? recorded.target.replace(/^\$/, '') : null
      eid = recordedId !== null && entities.some(e => e.id === recordedId) ? recordedId : mintEntityId(entities)
      entityIdBySource.set(source, eid)
    }
    planned.push({
      index,
      source,
      kind: op.vertexKey ? 'point' : sourceDef.kind,
      ref: op.vertexKey ? `vertex:${featureId}:${eid}:xy` : `entity:${featureId}:${eid}`,
    })
  }

  const out = [...targets]
  for (const plan of planned) out[plan.index] = plan.ref
  const created = [...entityIdBySource]
    .filter(([, entityId]) => !entities.some(e => e.id === entityId))
    .map(([source, entityId]) => ({
      entityId,
      kind: planned.find(plan => plan.source === source)?.kind ?? 'point',
      source,
    }))
  return { targets: out, created }
}

/** Materialize the planned projections: the held entity and the `projection`
 *  constraint that records where it came from. */
function _materializeForeignProjections(
  doc: PartDoc,
  featureId: string,
  plan: ForeignProjectionPlan,
): void {
  if (plan.created.length === 0) return
  const feature = resolveSketch(doc, featureId, 'entities', 'constraints')
  if (!feature) return
  for (const { entityId, kind, source } of plan.created) {
    feature.entities.push({ id: entityId, kind })
    feature.constraints.push({
      id: uniqueConstraintId(feature.constraints, 'projection'),
      kind: 'projection',
      target: `$${entityId}`,
      source,
    })
  }
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
  // A missing feature is a stale id, not a refusal: nothing can be authored.
  // The containers are deliberately not materialized here, so every refusal
  // below leaves the document byte-identical and the session can classify it as
  // a no-op. The constraint list is created only when the constraint is pushed.
  const feature = findSketchFeature(doc, featureId)
  if (!feature) return
  // Checked before any target is materialized: a refused zero dimension must
  // not leave a promoted point behind.
  const zeroProblem = isConstraintKindName(kind) ? pointDistanceZeroProblem(kind, value) : null
  if (zeroProblem !== null) {
    warn(`applyAddConstraint: ${zeroProblem}`, { featureId, kind, value })
    return
  }
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
  // One refusal source with the drive rule: the checks used to live in the
  // branches below, so the drive copied only the colinear and zero ones and
  // reported every other refusal as an ok that changed nothing.
  //
  // A cross-sketch snap operand is projected into this sketch first (the same
  // visible held entity the constraint command makes from a B-rep pick), so the
  // constraint names something the solver can resolve. The projection is
  // materialized below, after the shape checks, so a refused pick leaves no
  // orphan behind; both land in this one mutation, hence one undo entry. The
  // drive never reaches the projection branch: its value rule refuses a foreign
  // target by name, telling the author to project it explicitly.
  const projectionPlan = _planForeignTargets(doc, featureId, targets)
  if (!projectionPlan) {
    warn('applyAddConstraint: dropping a pick whose foreign operand does not resolve', { featureId, kind, targets })
    return
  }
  targets = projectionPlan.targets
  const problem = addConstraintProblem(feature, kind, targets, value)
  if (problem !== null) {
    warn(`applyAddConstraint: ${problem}`, { featureId, kind, targets })
    return
  }
  // The solver reads `a` as the line for line_distance; a point-first pick was
  // stored inert. Canonicalise here as well as in the editor path, so a drive
  // or MCP mutation cannot author the dropped spelling either, whether it names
  // the operands explicitly or as stored `$` refs.
  const entityIds = new Set((feature.entities ?? []).map(e => e.id))
  const kindById = new Map((feature.entities ?? []).map(e => [e.id, e.kind]))
  targets = canonicalLineDistanceTargets(kind, targets, (t) => {
    if (t.startsWith('vertex:') || t === '@builtin_origin') return 'point'
    if (t.startsWith('entity:')) {
      const ek = kindById.get(t.split(':')[2])
      return ek === 'line' ? 'line' : isPointLikeEntityKind(ek) ? 'point' : undefined
    }
    const ref = resolveVertexRef(entityIds, t)
    if (!ref) return undefined
    const ek = kindById.get(ref.entity)
    if (ref.point !== undefined || isPointLikeEntityKind(ek)) return 'point'
    return ek === 'line' ? 'line' : undefined
  })
  const cid = uniqueConstraintId(feature.constraints ?? [], kind)
  const c: PartConstraint = { id: cid, kind }
  const pt = (t: string) => parseTarget(t, featureId)
  if (kind === 'midpoint') {
    if (!applyMidpointConstraint(c, targets, pt, featureId, entityIds, kindById)) {
      warn(`applyAddConstraint: ${midpointShapeReason(targets)}`, { featureId, targets })
      return
    }
  } else if (kind === 'group') {
    // A group stores its whole and point members in `refs` (the n-ary spelling
    // the lowering reads). The first member is the anchor. addConstraintProblem
    // refused the origin, a projected member, a point key the kind lacks, a
    // whole-plus-point duplicate and a lone point, so every target here is an
    // authored entity or point of this sketch.
    const refs: string[] = []
    const seen = new Set<string>()
    for (const target of targets) {
      let ref: string
      let eid: string | undefined
      let point: string | undefined
      if (target.startsWith('entity:') || target.startsWith('vertex:')) {
        const parts = target.split(':')
        eid = parts[2]
        point = target.startsWith('vertex:') ? parts[3] : undefined
      } else {
        const resolved = resolveVertexRef(entityIds, target)
        eid = resolved?.entity
        point = resolved?.point
      }
      // A point entity's single vertex `xy` IS the entity: store it whole so a
      // point member can never cover a whole member of the same entity.
      const wholePoint = point === 'xy' && eid !== undefined && kindById.get(eid) === 'point'
      if (eid === undefined) ref = pt(target)
      else if (wholePoint || point === undefined) ref = `$${eid}`
      else ref = `$${eid}${point}`
      if (seen.has(ref)) continue
      seen.add(ref)
      refs.push(ref)
    }
    c.refs = refs
  } else if (kind === 'horizontal' || kind === 'vertical') {
    // Overloaded: one line -> `target` (make the line axis-aligned); two points
    // -> `a`/`b` (share a coordinate). addConstraintProblem refused the empty or
    // over-long pick and a whole non-point entity in the a/b slot (a whole point
    // entity is a legal point there), so only the two forms remain.
    if (targets.length >= 2) {
      c.a = pt(targets[0])
      c.b = pt(targets[1])
    } else {
      c.target = pt(targets[0])
    }
  } else if (kind === 'colinear') {
    // A colinear is lowered to the solver's coincident (partDocToSketches): two
    // lines read as the collinear row pair, a point and a line as point-on-line.
    // addConstraintProblem refused every pick with no row.
    c.a = pt(targets[0])
    c.b = pt(targets[1])
  } else {
    // addConstraintProblem guaranteed the operand count: coincident pairs two
    // refs, everything else at least one.
    if (targets.length >= 2) {
      c.a = pt(targets[0])
      c.b = pt(targets[1])
    } else {
      c.target = pt(targets[0])
    }
  }
  // An angle mutation carries the number the dimension label shows, which is
  // the drawn wedge: theta or 180 - theta. Resolve it against the current
  // geometry once here, so the dialog, the drive and a script mean the same
  // number; the document always stores theta. Any other kind stores its value
  // as given.
  let storedValue = value
  let storedPos = pos
  if (kind === 'angle' && value !== undefined && Number.isFinite(value)) {
    const aligned = angleStoredValue({
      constraint: c,
      value,
      sketch: unflattenGeometry(feature.initial, feature.entities),
      pos,
      newLabel: true,
    })
    if (aligned) {
      storedValue = aligned.theta
      if (aligned.pos) storedPos = aligned.pos
    }
  }
  // A dimension value, label position, or sign is persisted into the doc. A
  // non-finite one would poison every later solve, so each is gated here exactly
  // like applySetConstraintValue/Pos. The finiteness gate alone is not enough to
  // match the set path: value and pos are rounded to the same precision there,
  // and sign is normalized to its unit magnitude, or the same constraint would
  // serialize differently depending on the write path. A raw magnitude would
  // also scale the dimension (`d - 5 * value`) or zero it on 0.
  if (storedValue !== undefined && Number.isFinite(storedValue)) c.value = round(storedValue)
  if (storedPos !== undefined && Number.isFinite(storedPos[0]) && Number.isFinite(storedPos[1])) c.pos = [round(storedPos[0]), round(storedPos[1])]
  if (sign !== undefined && Number.isFinite(sign)) c.sign = sign < 0 ? -1 : 1
  if (!feature.constraints) feature.constraints = []
  feature.constraints.push(c)
  // The constraint is accepted, so the held entities it names can land too. A
  // cross-sketch pick never reaches this line without a projection plan.
  _materializeForeignProjections(doc, featureId, projectionPlan)
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
    const feature = findSketchFeature(doc, fid)
    if (!feature?.entities) continue
    for (const def of feature.entities) {
      // A construction point is reference geometry like a construction line:
      // the hole's whole-sketch pick skips it, and a picked one is refused. The
      // toggle is the only way to flag or clear a point's flag, so it applies
      // to every kind.
      if (eids.has(def.id)) {
        if (def.construction) delete def.construction
        else def.construction = true
      }
    }
  }
}

/** Delete sketch elements. Two projection-specific readings:
 *
 *  - A derived face-projection member has no row to remove. Deleting it adds
 *    its construction token to the owning projection's `excluded`, which is the
 *    durable "the user removed this edge" fact; undo removes the token.
 *  - Deleting the face projection itself may carry `materialize`, the member
 *    rows the solve derived. Written with their derived ids and params, they
 *    become ordinary geometry and constraints on them keep working; the
 *    constraint is removed after them. The payload is recorded with the
 *    mutation, so a replay writes the same bytes without solving.
 */
export function applyDeleteElements(
  doc: PartDoc,
  targets: string[],
  materialize?: ReadonlyArray<{ id: string; kind: string; params: readonly number[] }>,
): void {
  const byFeature: Record<string, { entities: Set<string>; constraints: Set<string> }> = {}
  // A `fit<k>` target removes one point of a positional list, so each removal
  // renumbers the list under the remaining targets. Collect them per entity and
  // apply them high-to-low once, which keeps every index naming the point the
  // caller saw.
  const fitPointDeletes: Record<string, Map<string, Set<number>>> = {}
  for (const t of targets) {
    const parts = t.split(':')
    const fid = parts[1]
    if (!byFeature[fid]) byFeature[fid] = { entities: new Set(), constraints: new Set() }
    if (parts[0] === 'entity') byFeature[fid].entities.add(parts[2])
    if (parts[0] === 'constraint') byFeature[fid].constraints.add(parts[2])
    if (parts[0] === 'vertex') {
      const key = parts[3]
      if (key && fitPointIndex(key) !== null) {
        const feature = findSketchFeature(doc, fid)
        const def = feature?.entities?.find(e => e.id === parts[2])
        if (def?.kind === 'fit_spline') {
          const perEntity = fitPointDeletes[fid] ?? (fitPointDeletes[fid] = new Map())
          const indices = perEntity.get(parts[2]) ?? new Set<number>()
          indices.add(fitPointIndex(key) as number)
          perEntity.set(parts[2], indices)
          continue
        }
      }
      byFeature[fid].entities.add(parts[2])
    }
  }
  // A derived member has no row: deleting it records the exclusion on its
  // projection instead. The exclusion is a document fact, so undo restores the
  // member with the same derived id on the next solve.
  for (const [fid, per] of Object.entries(byFeature)) {
    const feature = findSketchFeature(doc, fid)
    if (!feature?.constraints) continue
    const ownerByMember = new Map<string, { constraint: PartConstraint; token: string }>()
    for (const constraint of feature.constraints) {
      if (constraint.kind !== 'projection' || constraint.members === undefined) continue
      for (const [token, id] of Object.entries(constraint.members)) {
        if (!ownerByMember.has(id)) ownerByMember.set(id, { constraint, token })
      }
    }
    for (const id of [...per.entities]) {
      const owner = ownerByMember.get(id)
      if (owner === undefined) continue
      if (!owner.constraint.excluded?.includes(owner.token)) {
        owner.constraint.excluded = [...(owner.constraint.excluded ?? []), owner.token]
      }
      per.entities.delete(id)
    }
  }
  // Freeze: the solve's member bytes become rows under the same ids, so the
  // constraints naming them survive the projection's removal. Only the members
  // this constraint actually owns are written, so a stale payload cannot
  // invent an entity.
  if (materialize !== undefined && materialize.length > 0) {
    for (const [fid, per] of Object.entries(byFeature)) {
      if (per.constraints.size === 0) continue
      const feature = findSketchFeature(doc, fid)
      if (!feature?.constraints) continue
      for (const constraintId of per.constraints) {
        const constraint = feature.constraints.find(candidate => candidate.id === constraintId)
        if (constraint?.kind !== 'projection' || constraint.members === undefined) continue
        // One press can delete a member and the projection together; the
        // exclusion pass above has already recorded that member, so it must not
        // be written back as frozen geometry.
        const excluded = new Set(constraint.excluded ?? [])
        const tokenById = new Map(Object.entries(constraint.members).map(([token, id]) => [id, token]))
        for (const row of materialize) {
          const token = tokenById.get(row.id)
          if (token === undefined || excluded.has(token)) continue
          if (!feature.entities) feature.entities = []
          if (!feature.entities.some(entity => entity.id === row.id)) {
            feature.entities.push({ id: row.id, kind: row.kind })
          }
          if (!feature.initial) feature.initial = {}
          feature.initial[row.id] = row.params.map(round)
        }
      }
    }
  }
  for (const [fid, perEntity] of Object.entries(fitPointDeletes)) {
    for (const [eid, indices] of perEntity) {
      for (const k of [...indices].sort((a, b) => b - a)) applyDeleteFitPoint(doc, fid, eid, k)
    }
  }
  for (const [fid, { entities: entsToDelete, constraints: consToDelete }] of Object.entries(byFeature)) {
    const feature = findSketchFeature(doc, fid)
    if (!feature) continue
    if (entsToDelete.size > 0) {
      if (feature.entities) feature.entities = feature.entities.filter(e => !entsToDelete.has(e.id))
      if (feature.initial) for (const eid of entsToDelete) delete feature.initial[eid]
      // A group survives losing a member: it shrinks, and the first remaining
      // member becomes the anchor (the residual reads the first target). A lone
      // point left behind removes the group: its own pair is the whole
      // translation, so it holds nothing. Only the last member's removal and
      // that point case delete the group, the one place a constraint outlives
      // the usual cascade.
      const remainingIds = new Set((feature.entities ?? []).map(e => e.id))
      if (feature.constraints) {
        for (const c of feature.constraints) {
          if (c.kind === 'group' && Array.isArray(c.refs)) {
            const kept = c.refs.filter(r => !_refMatchesDeleted(r, entsToDelete))
            if (kept.length === 0) consToDelete.add(c.id)
            else if (kept.length !== c.refs.length) {
              const lone = kept.length === 1 ? resolveVertexRef(remainingIds, kept[0]) : null
              if (lone?.point !== undefined) consToDelete.add(c.id)
              else c.refs = kept
            }
            continue
          }
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
  const feature = findSketchFeature(doc, featureId)
  if (!feature?.constraints) return
  // A dimension value is stored on the document grid (1e-6), the same precision
  // as every other stored scalar, through the same -0 folding; a NaN/Inf must
  // be rejected at the boundary rather than rounded into it.
  if (!Number.isFinite(value)) {
    warn('applySetConstraintValue: ignoring non-finite value', { featureId, constraintId, value })
    return
  }
  const c = feature.constraints.find(c => c.id === constraintId)
  if (!c) return
  const zeroProblem = isConstraintKindName(c.kind) ? pointDistanceZeroProblem(c.kind, value) : null
  if (zeroProblem !== null) {
    warn(`applySetConstraintValue: ${zeroProblem}`, { featureId, constraintId, value })
    return
  }
  // A radius or diameter dimension is a size, so zero would drive the curve to
  // a point. The drive boundary refuses the same value through this helper, so
  // a UI edit and an authored step agree on what the sketch can hold.
  const sizeProblem = dimensionSizeProblem(c.kind, value)
  if (sizeProblem !== null) {
    warn(`applySetConstraintValue: ${sizeProblem}`, { featureId, constraintId, value })
    return
  }
  // An angle edit types the number the label shows for the wedge it already
  // sits in: its stored pos, or the renderer's default wedge when it has none.
  // No pos is written here; the existing label keeps deciding the wedge. The
  // value is resolved before the assignment so a second read sees the theta.
  const storedValue = c.kind === 'angle'
    ? angleStoredValue({
        constraint: c,
        value,
        sketch: unflattenGeometry(feature.initial, feature.entities),
        pos: c.pos,
      })?.theta ?? value
    : value
  c.value = round(storedValue)
}

export function applySetConstraintPos(
  doc: PartDoc,
  featureId: string,
  constraintId: string,
  pos: [number, number],
): void {
  const feature = findSketchFeature(doc, featureId)
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
  const feature = findSketchFeature(doc, featureId)
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
  fit?: FitSplineAddOptions,
  dimensions?: boolean,
): void {
  // A fit spline's params are the fit points, not a fixed layout, so its writer
  // lives beside the insert/delete/handle editors that share the ref rules.
  if (kind === 'fit_spline') {
    applyAddFitSpline(doc, featureId, params, entityId, fit)
    return
  }
  // The seed params are stored at the document's number precision. round(NaN)
  // is still NaN, so a non-finite coordinate would survive into the YAML and
  // every later solve seeded from it. Refused before any container is
  // materialized, so the refusal leaves the doc unchanged for the step net.
  if (!allFinite(params)) {
    warn('applyAddEntity: ignoring non-finite seed params', { featureId, kind, params })
    return
  }
  // The drive refuses the same seed through this helper. A draw tool should
  // never produce a zero-length line or a zero-radius circle, but a double
  // click on one spot does, and the stored row would then be left out of every
  // profile. Refuse before any container is materialized.
  const sizeProblem = entitySizeProblem(kind, params)
  if (sizeProblem !== null) {
    warn(`applyAddEntity: ${sizeProblem}`, { featureId, kind, params })
    return
  }
  const feature = resolveSketch(doc, featureId, 'entities', 'initial')
  if (!feature) return
  const eid = mintEntityId(feature.entities, entityId)
  feature.entities.push({ id: eid, kind })
  feature.initial[eid] = params.map(round)
  // The size is the one DOF a single entity author can close here; position and
  // rotation still need an anchor or a neighbour (add_constraint).
  if (dimensions === true) applyEntityDimension(doc, featureId, kind, eid, feature.initial[eid])
}

/** Add the size dimension `dimensions: true` authors for a single entity, when
 *  the kind has one the solver can drive: a line's length, a circle's or arc's
 *  radius. Splines, ellipses and points have no such value. */
function applyEntityDimension(
  doc: PartDoc,
  featureId: string,
  kind: string,
  entityId: string,
  params: readonly number[],
): void {
  const ref = `entity:${featureId}:${entityId}`
  if (kind === 'line') {
    applyAddConstraint(doc, featureId, 'length', [ref], round(Math.hypot(params[2] - params[0], params[3] - params[1])))
  } else if (kind === 'circle' || kind === 'arc') {
    applyAddConstraint(doc, featureId, 'radius', [ref], round(params[2]))
  }
}

/** What a face projection needs besides the doc: the face's boundary this
 *  instant. Injected so the applier stays pure and the drive/UI can answer from
 *  the last solved bodies rather than reaching into a store. `members` lets a
 *  recorded mutation (or a direct caller) carry the map, which is what keeps a
 *  replay independent of a live solve. */
export interface AddProjectionOptions {
  faceBoundary?: FaceBoundaryLookup
  members?: Record<string, string>
  excluded?: string[]
}

/** True when a supplied map is exactly what the loader would derive for this
 *  constraint id: construction tokens only, each id the derived form. */
function derivedMemberMap(constraintId: string, members: Record<string, string>): boolean {
  const tokens = Object.keys(members)
  if (tokens.some(token => !/^u\|[0-9A-Za-z_]+$/.test(token))) return false
  const expected = deriveMemberIds(constraintId, tokens)
  return tokens.every(token => members[token] === expected[token])
}

export interface AddedFaceProjection {
  constraintId: string
  members: Record<string, string>
}

export function applyAddProjectedEntity(
  doc: PartDoc,
  featureId: string,
  kind: string,
  source: string,
  entityId?: string,
  constraintId?: string,
  options: AddProjectionOptions = {},
): AddedFaceProjection | undefined {
  const feature = resolveSketch(doc, featureId, 'entities', 'constraints')
  if (!feature) return undefined
  // A face projects as one live constraint whose members are derived, not as one
  // held entity per boundary edge. No target, no entity row: the ids live in the
  // constraint's `members` map and the geometry in the solve.
  if (isFaceProjectionSource(source)) {
    const baseCid = constraintId ?? faceProjectionConstraintId(source)
    if (baseCid === null) return undefined
    const constraints = feature.constraints ?? []
    // One projection per face (and one per id): a second pick of the same face
    // would derive the same member ids under a different constraint id.
    if (constraints.some((c) => c.id === baseCid)) return undefined
    if (constraints.some((c) => c.kind === 'projection' && c.source === source && c.target === undefined)) return undefined
    let cid = baseCid
    let members = options.members
    // A supplied map (a recorded mutation, a direct caller) must be the form the
    // loader will derive, or the document could not reopen. A boundary lets the
    // applier recompute the right one; without one, a wrong map is refused.
    if (members !== undefined && !derivedMemberMap(baseCid, members)) {
      if (options.faceBoundary === undefined) return undefined
      members = undefined
    }
    if (members === undefined) {
      const boundary = options.faceBoundary?.(source) ?? null
      // Without a solved boundary there is no member set to record. Refusing is
      // the honest answer: a constraint with no ids would resolve only after a
      // solve the caller cannot see.
      if (boundary === null) return undefined
      // A frozen projection leaves its member rows under the same derived ids.
      // A later re-pick of that face must not collide with them, so the
      // constraint id (and with it every member id) draws past the taken ones.
      const taken = new Set((feature.entities ?? []).map((entity) => entity.id))
      for (let suffix = 1; ; suffix++) {
        cid = suffix === 1 ? baseCid : `${baseCid}_${suffix}`
        if (constraints.some((c) => c.id === cid)) continue
        members = reconcileFaceProjection({ id: cid, members: {} }, boundary).members
        if (!Object.values(members).some((id) => taken.has(id))) break
      }
    }
    // A face with no boundary edge at all has nothing to project. Storing a
    // targetless constraint with no members would be a document that can neither
    // freeze nor report, so the add is refused by name.
    if (Object.keys(members).length === 0) {
      warn('applyAddProjectedEntity: the face has no boundary edge to project; refusing it', {
        featureId, source,
      })
      return undefined
    }
    const excluded = [...new Set((options.excluded ?? []).filter(token => token !== ''))]
    constraints.push({
      id: cid,
      kind: 'projection',
      source,
      members,
      ...(excluded.length ? { excluded } : {}),
    })
    feature.constraints = constraints
    return { constraintId: cid, members }
  }
  const eid = mintEntityId(feature.entities, entityId)
  // Refuse a second projection on the same entity.
  if ((feature.constraints ?? []).some((c) => c.kind === 'projection' && c.target === `$${eid}`)) return
  if (!feature.constraints) feature.constraints = []
  // Mint a unique constraint id, honouring an explicit name.
  const existingCids = new Set((feature.constraints ?? []).map((c) => c.id))
  let cid = constraintId ?? `proj_${eid}`
  if (existingCids.has(cid)) {
    let i = 2
    while (existingCids.has(`${cid}_${i}`)) i++
    cid = `${cid}_${i}`
  }
  feature.entities.push({ id: eid, kind })
  feature.constraints.push({ id: cid, kind: 'projection', target: `$${eid}`, source })
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
  fit?: FitSplineAddOptions,
): void {
  if (kind === 'fit_spline') {
    const eid = applyAddFitSpline(doc, featureId, params, entityId, fit)
    if (!eid) return
    let target: string
    if (snapEntityRef) target = snapEntityRef
    else if (snapVertexId && snapVertexId.startsWith('@builtin_')) target = snapVertexId
    else if (snapVertexId) target = snapVertexId
    else return
    applyAddConstraint(doc, featureId, constraintKind, [
      `vertex:${featureId}:${eid}:${vertexKey}`,
      target,
    ])
    return
  }
  // Seed params are stored at the document's number precision (same gate as
  // applyAddEntity); refusing here keeps the snap constraint from being authored
  // against an entity that was never created. Before resolveSketch, so the skip
  // itself adds no empty container to the document.
  if (!allFinite(params)) {
    warn('applyAddEntityWithConstraint: ignoring non-finite seed params', { featureId, kind, params })
    return
  }
  // Same size floor as applyAddEntity: the snap constraint must never be
  // authored against an entity that was not created.
  const sizeProblem = entitySizeProblem(kind, params)
  if (sizeProblem !== null) {
    warn(`applyAddEntityWithConstraint: ${sizeProblem}`, { featureId, kind, params })
    return
  }
  const feature = resolveSketch(doc, featureId, 'entities', 'initial', 'constraints')
  if (!feature) return
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
  // The contact location becomes the point's seed at the document's number
  // precision. A malformed `isect:` handle parses to NaN upstream, so the gate
  // lives here rather than at the one call seam, and before resolveSketch: a
  // refused handle must not leave an empty container behind. Null tells the
  // caller nothing was materialized.
  if (!allFinite(at)) {
    warn('applyAddPointAtIntersection: ignoring non-finite location', { featureId, at })
    return null
  }
  const feature = resolveSketch(doc, featureId, 'entities', 'initial')
  if (!feature) return null

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

  // The contact seed is stored at the document's number precision.
  // dockLocationOf can hand back a non-finite pair for a degenerate host, so
  // gate before the point is minted.
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
  const feature = findSketchFeature(doc, featureId)
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

export function applySetFeaturePlane(doc: PartDoc, featureId: string, plane: string): void {
  const feature = findSketchFeature(doc, featureId)
  if (!feature) return
  const wasBound = !!feature.plane
  feature.plane = plane
  // Empty to non-empty is the sketch becoming usable, which is when the first
  // one hides the planes. A rebind (or an unpick) leaves visibility alone.
  if (!wasBound && plane) hidePlanesIfFirstBoundSketch(doc, featureId)
}
