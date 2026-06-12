import type { PartDoc, PartFeature, PartConstraint, PartTarget } from '@/types/cad'
import { VERTEX_INDICES, ALL_COORD_INDICES } from '@/registry'
import { warn, round, findFeature, parseTarget, randomId, uniqueConstraintId } from './helpers'
import { offsetCorners, lineIntersect, lineVertexIndices } from '@/utils/geometry/offsetProfile'

// ─── Internals ───

const _REF_FIELDS: (keyof PartConstraint)[] = ['target', 'a', 'b', 'line', 'arc', 'point', 'point_a', 'point_b']

function _refMatchesDeleted(ref: unknown, deletedIds: Set<string>): boolean {
  if (typeof ref !== 'string' || !ref.startsWith('$')) return false
  const bare = ref.slice(1)
  for (const eid of deletedIds) {
    if (bare === eid) return true
    if (bare.startsWith(eid)) {
      const suffix = bare.slice(eid.length)
      if (['start', 'end', 'center', 'xy', 'major1', 'major2', 'minor1', 'minor2', 'c1', 'c2'].includes(suffix)) return true
    }
  }
  return false
}

function _refsDeletedEntity(c: PartConstraint, deletedIds: Set<string>): boolean {
  for (const field of _REF_FIELDS) {
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
  feature: PartFeature,
  featureId: string,
  doc: PartDoc,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): [string, string, string, string] {
  if (!feature.entities) feature.entities = []
  if (!feature.initial) feature.initial = {}
  if (!feature.constraints) feature.constraints = []

  const existingIds = new Set(feature.entities.map(e => e.id))
  const lineIds: string[] = []
  for (let i = 0; i < 4; i++) {
    let id = randomId(12)
    while (existingIds.has(id)) id = randomId(12)
    lineIds.push(id)
    existingIds.add(id)
  }
  const [lA, lB, lC, lD] = lineIds
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
  // Drag commit: adopt the last WASM drag frame for ALL entities first, so the
  // hard solve seeds from the on-screen state instead of pre-drag geometry +
  // one teleported vertex (which can land in a different solution basin).
  // Only known entity ids with matching param counts are written -- a stale or
  // kind-mismatched entry must not corrupt the doc.
  if (solvedGeometry) {
    for (const [eid, p] of Object.entries(solvedGeometry)) {
      const cur = feature.initial[eid]
      if (!cur || cur.length !== p.length) continue
      feature.initial[eid] = p.map(round)
    }
  }
  const params = feature.initial[entityId]
  if (!params) return
  const kind = feature.entities?.find(e => e.id === entityId)?.kind
  if (!kind) return
  const indices = VERTEX_INDICES[kind]?.[vertexKey]
  if (!indices) return
  params[indices[0]] = round(to[0])
  params[indices[1]] = round(to[1])
}

export function applyMoveEntity(
  doc: PartDoc,
  featureId: string,
  entityId: string,
  delta: [number, number],
): void {
  const [dx, dy] = delta
  if (dx === 0 && dy === 0) return
  const feature = findFeature(doc, featureId)
  if (!feature?.initial) return
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

export function applyAddConstraint(
  doc: PartDoc,
  featureId: string,
  kind: string,
  targets: string[],
  value?: number,
  pos?: [number, number],
): void {
  const feature = findFeature(doc, featureId)
  if (!feature) return
  if (!feature.constraints) feature.constraints = []
  const cid = uniqueConstraintId(feature.constraints, kind)
  const c: PartConstraint = { id: cid, kind }
  const pt = (t: string) => parseTarget(t, featureId)
  if (kind === 'midpoint') {
    if (!applyMidpointConstraint(c, targets, pt)) {
      warn('applyAddConstraint: unrecognized midpoint target combination', targets)
      return
    }
  } else if (kind === 'coincident' || targets.length >= 2) {
    c.a = pt(targets[0])
    c.b = pt(targets[1])
  } else if (targets.length === 1) {
    c.target = pt(targets[0])
  }
  if (value !== undefined) c.value = value
  if (pos !== undefined) c.pos = pos
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
  const c = feature.constraints.find(c => c.id === constraintId)
  if (c) c.pos = [round(pos[0]), round(pos[1])]
}

export function applyAddEntity(
  doc: PartDoc,
  featureId: string,
  kind: string,
  params: number[],
  entityId?: string,
): void {
  const feature = findFeature(doc, featureId)
  if (!feature) return
  if (!feature.entities) feature.entities = []
  if (!feature.initial) feature.initial = {}
  const existing = new Set(feature.entities.map(e => e.id))
  let eid = entityId ?? randomId(12)
  while (!entityId && existing.has(eid)) eid = randomId(12)
  feature.entities.push({ id: eid, kind })
  feature.initial[eid] = params.map(round)
}

export function applyAddProjectedEntity(
  doc: PartDoc,
  featureId: string,
  kind: string,
  source: string,
): void {
  const feature = findFeature(doc, featureId)
  if (!feature) return
  if (!feature.entities) feature.entities = []
  const existing = new Set(feature.entities.map(e => e.id))
  let eid = randomId(12)
  while (existing.has(eid)) eid = randomId(12)
  feature.entities.push({ id: eid, kind, source })
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
  const feature = findFeature(doc, featureId)
  if (!feature) return
  if (!feature.entities) feature.entities = []
  if (!feature.initial) feature.initial = {}
  if (!feature.constraints) feature.constraints = []
  const existing = new Set(feature.entities.map(e => e.id))
  let eid = entityId ?? randomId(12)
  while (!entityId && existing.has(eid)) eid = randomId(12)
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

export function applyAddPointWithConstraint(
  doc: PartDoc,
  featureId: string,
  params: [number, number],
  snapVertexId?: string,
  snapEntityRef?: string,
  constraintKind?: string,
): void {
  const feature = findFeature(doc, featureId)
  if (!feature) return
  if (!feature.entities) feature.entities = []
  if (!feature.initial) feature.initial = {}
  const existing = new Set(feature.entities.map(e => e.id))
  let eid = randomId(12)
  while (existing.has(eid)) eid = randomId(12)
  feature.entities.push({ id: eid, kind: 'point' })
  feature.initial[eid] = [round(params[0]), round(params[1])]

  if (!constraintKind) return
  if (!feature.constraints) feature.constraints = []

  let target: string
  if (snapEntityRef) {
    target = snapEntityRef
  } else if (snapVertexId && snapVertexId.startsWith('@builtin_')) {
    target = snapVertexId
  } else if (snapVertexId) {
    // Use snapVertexId directly -- same reasoning as applyAddEntityWithConstraint.
    target = snapVertexId
  } else {
    return
  }

  applyAddConstraint(doc, featureId, constraintKind, [
    `vertex:${featureId}:${eid}:xy`,
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
): void {
  const feature = findFeature(doc, featureId)
  if (!feature) return
  if (!feature.entities) feature.entities = []
  if (!feature.initial) feature.initial = {}

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

  const existing = new Set(feature.entities.map(e => e.id))
  let eid = randomId(12)
  while (existing.has(eid)) eid = randomId(12)
  feature.entities.push({ id: eid, kind: 'point' })
  feature.initial[eid] = [round(at[0]), round(at[1])]

  if (loci.length < 2) return  // not an intersection; leave a free point
  for (const cid of loci) {
    applyAddConstraint(doc, featureId, 'coincident', [
      `vertex:${featureId}:${eid}:xy`,
      `entity:${featureId}:${cid}`,
    ])
  }
}

export function applyAddRect(
  doc: PartDoc,
  featureId: string,
  p0: [number, number],
  p1: [number, number],
): void {
  const feature = findFeature(doc, featureId)
  if (!feature) return

  const [x0, y0] = p0
  const [x1, y1] = p1
  _applyRectLines(feature, featureId, doc, x0, y0, x1, y1)
}

export function applyAddCenterRect(
  doc: PartDoc,
  featureId: string,
  center: [number, number],
  corner: [number, number],
): void {
  const feature = findFeature(doc, featureId)
  if (!feature) return
  if (!feature.entities) feature.entities = []
  if (!feature.initial) feature.initial = {}
  if (!feature.constraints) feature.constraints = []

  const [cx, cy] = center
  const [x, y] = corner
  const dx = x - cx
  const dy = y - cy

  // 4 corners of the rectangle (symmetric around center)
  const x0 = cx - dx, x1 = cx + dx
  const y0 = cy - dy, y1 = cy + dy

  const [lA, lB, lC, lD] = _applyRectLines(feature, featureId, doc, x0, y0, x1, y1)

  // Create point entity at center
  const existingIds = new Set(feature.entities.map(e => e.id))
  let pointId = randomId(12)
  while (existingIds.has(pointId)) pointId = randomId(12)
  feature.entities.push({ id: pointId, kind: 'point' })
  feature.initial[pointId] = [cx, cy].map(round)

  // Add midpoint constraints: center point is midpoint of each diagonal
  // Diagonal 1: lA:start (top-right) to lC:start (bottom-left)
  applyAddConstraint(doc, featureId, 'midpoint', [
    `vertex:${featureId}:${lA}:start`,
    `vertex:${featureId}:${lC}:start`,
    `vertex:${featureId}:${pointId}:xy`,
  ])
  // Diagonal 2: lB:start (top-left) to lD:start (bottom-right)
  applyAddConstraint(doc, featureId, 'midpoint', [
    `vertex:${featureId}:${lB}:start`,
    `vertex:${featureId}:${lD}:start`,
    `vertex:${featureId}:${pointId}:xy`,
  ])
}

/** N-gon sugar: N line entities forming a closed coincident chain plus a single
 *  `ngon` regularity constraint. The lines store the circumscribed polygon
 *  (vertices on the circumcircle through `corner`); the `ngon` constraint is
 *  expanded to primitive equal-length + angle constraints at solve time. The
 *  solver never sees a real `ngon` kind. */
export function applyAddNgon(
  doc: PartDoc,
  featureId: string,
  center: [number, number],
  corner: [number, number],
  sides: number,
): void {
  const feature = findFeature(doc, featureId)
  if (!feature) return
  if (!feature.entities) feature.entities = []
  if (!feature.initial) feature.initial = {}
  if (!feature.constraints) feature.constraints = []

  const n = Math.max(3, Math.floor(sides))
  const [cx, cy] = center
  const [vx, vy] = corner
  const radius = Math.hypot(vx - cx, vy - cy)
  if (radius <= 0) return
  const angle0 = Math.atan2(vy - cy, vx - cx)

  const existingIds = new Set(feature.entities.map(e => e.id))
  const lineIds: string[] = []
  for (let i = 0; i < n; i++) {
    let id = randomId(12)
    while (existingIds.has(id)) id = randomId(12)
    existingIds.add(id)
    lineIds.push(id)
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

  // The single regularity constraint. Deleting it "breaks" the n-gon, leaving
  // the closed line chain as an editable irregular polygon.
  const cid = uniqueConstraintId(feature.constraints, 'ngon')
  feature.constraints.push({
    id: cid,
    kind: 'ngon',
    refs: lineIds.map(eid => parseTarget(`entity:${featureId}:${eid}`, featureId)),
  })
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
export function offsetSeed(kind: string, p: number[], distance: number): number[] | null {
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
  const feature = findFeature(doc, featureId)
  if (!feature) return
  if (!feature.entities) feature.entities = []
  if (!feature.initial) feature.initial = {}
  if (!feature.constraints) feature.constraints = []

  const cloneOf = new Map<string, string>()  // source id -> clone id
  const kindOf = new Map<string, string>()   // source id -> entity kind
  const existingIds = new Set(feature.entities.map(e => e.id))

  for (const srcId of sourceIds) {
    const src = feature.entities.find(e => e.id === srcId)
    const srcParams = feature.initial[srcId]
    if (!src || !srcParams) continue

    const seed = offsetSeed(src.kind, srcParams, distance)
    if (!seed) continue  // degenerate source: no offset direction

    let dstId = randomId(12)
    while (existingIds.has(dstId)) dstId = randomId(12)
    existingIds.add(dstId)

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
  const seedSnapshot = new Map<string, number[]>()
  for (const cloneId of cloneOf.values()) seedSnapshot.set(cloneId, [...feature.initial[cloneId]])

  for (const corner of offsetCorners([...cloneOf.keys()], feature.constraints)) {
    const cloneA = cloneOf.get(corner.a.entityId)
    const cloneB = cloneOf.get(corner.b.entityId)
    if (!cloneA || !cloneB) continue
    const kindA = kindOf.get(corner.a.entityId)
    const kindB = kindOf.get(corner.b.entityId)

    const curved = (k: string | undefined) => k === 'arc' || k === 'circle'
    if (kindA === 'line' && kindB === 'line') {
      const ix = lineIntersect(seedSnapshot.get(cloneA)!, seedSnapshot.get(cloneB)!)
      if (!ix) continue  // near-parallel: leave the gap, no coincident, no crash
      const ia = lineVertexIndices(corner.a.vertexKey)
      const ib = lineVertexIndices(corner.b.vertexKey)
      if (!ia || !ib) continue
      const pa = feature.initial[cloneA], pb = feature.initial[cloneB]
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

export function applySetFeaturePlane(doc: PartDoc, featureId: string, plane: string): void {
  const feature = findFeature(doc, featureId)
  if (!feature) return
  feature.plane = plane
}
