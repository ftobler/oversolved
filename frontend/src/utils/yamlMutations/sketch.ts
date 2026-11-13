import type { PartDoc, PartConstraint, PartTarget } from '@/types/cad'
import { entityVertexIndices, entityCoordPairs } from '@/registry'
import {
  warn, round, allFinite, findSketchFeature, parseTarget, uniqueConstraintId,
  resolveSketch, mintEntityId, CONSTRAINT_REF_FIELDS, refMatchesEntity,
  canonicalLineDistanceTargets, isPointLikeEntityKind,
  pointDistanceZeroProblem,
} from './helpers'
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
  if (def.kind === 'arc' && (vertexKey === 'start' || vertexKey === 'end')) {
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
  } else if (kind === 'horizontal' || kind === 'vertical') {
    // Overloaded: one line -> `target` (make the line axis-aligned); two points
    // -> `a`/`b` (share a coordinate). addConstraintProblem refused the empty
    // pick and the whole-entity a/b slot, so only the two forms remain.
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

export function applyDeleteElements(doc: PartDoc, targets: string[]): void {
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

export function applyAddProjectedEntity(
  doc: PartDoc,
  featureId: string,
  kind: string,
  source: string,
  entityId?: string,
  constraintId?: string,
): void {
  const feature = resolveSketch(doc, featureId, 'entities', 'constraints')
  if (!feature) return
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
