import type { PartDoc, PartFeature, PartConstraint, PartTarget } from '../types/cad'
import { VERTEX_INDICES, ALL_COORD_INDICES } from '../registry'

// ----
// Architecture contract
// ----
//
// PartDoc is the SOURCE OF TRUTH for the document.
// ...
// See ast.md for example.
//
// ----
// Internals
// ----

const round = (v: number) => Math.round(v * 1e6) / 1e6


function findFeature(doc: PartDoc, featureId: string): PartFeature | undefined {
  return doc.features?.find(f => f.id === featureId)
}

/** Convert a selection ID to a query string.
 *  If the target belongs to a different feature than the host, use `@<featId><eleId>`
 *  (absolute ref). Otherwise use `$<eleId>` (local ref).
 *  For `face:` IDs, returns the raw ancestry query verbatim (already globally scoped). */
export const parseTarget = (t: string, hostFeatureId: string): PartTarget => {
  const parts = t.split(':')
  if (parts[0] === 'entity') {
    const [, featId, eleId] = parts
    return featId === hostFeatureId ? '$' + eleId : '@' + featId + eleId
  }
  if (parts[0] === 'vertex') {
    const [, featId, eleId, sub] = parts
    return featId === hostFeatureId ? '$' + eleId + sub : '@' + featId + eleId + sub
  }
  if (parts[0] === 'face') return parts.slice(2).join(':')
  if (t.startsWith('@')) return t  // builtin/absolute query — pass through as-is
  return '$' + t
}

// Generate a random base64url ID.  bytes=12 for elements, bytes=18 for features.
export function randomId(bytes: number): string {
  const arr = new Uint8Array(bytes)
  crypto.getRandomValues(arr)
  return btoa(String.fromCharCode(...arr)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

function uniqueConstraintId(constraints: PartConstraint[], kind: string): string {
  const existing = new Set(constraints.map(c => c.id))
  let id = `c_${kind}_${randomId(6)}`
  while (existing.has(id)) id = `c_${kind}_${randomId(6)}`
  return id
}

// ----
// Mutations — all modify the doc object in place
// ----

export function applyMoveVertex(
  doc: PartDoc,
  featureId: string,
  entityId: string,
  vertexKey: string,
  to: [number, number],
): void {
  const feature = findFeature(doc, featureId)
  if (!feature?.initial) return
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
): void {
  const feature = findFeature(doc, featureId)
  if (!feature) return
  if (!feature.constraints) feature.constraints = []
  const cid = uniqueConstraintId(feature.constraints, kind)
  const c: PartConstraint = { id: cid, kind }
  const pt = (t: string) => parseTarget(t, featureId)
  if (kind === 'midpoint') {
    // midpoint needs specific keys depending on selection:
    //   entity + vertex  → line: $entity,  point: $vertex
    //   3 vertices       → point_a: $v1, point_b: $v2, point: $v3
    const entityTargets = targets.filter(t => t.startsWith('entity:'))
    const vertexTargets = targets.filter(t => t.startsWith('vertex:'))
    if (entityTargets.length === 1 && vertexTargets.length === 1) {
      c.line = pt(entityTargets[0])
      c.point = pt(vertexTargets[0])
    } else if (vertexTargets.length === 3) {
      c.point_a = pt(vertexTargets[0])
      c.point_b = pt(vertexTargets[1])
      c.point   = pt(vertexTargets[2])
    } else {
      // Not enough / wrong selection — skip adding
      return
    }
  } else if (targets.length === 1) {
    c.target = pt(targets[0])
  } else if (targets.length >= 2) {
    c.a = pt(targets[0])
    c.b = pt(targets[1])
  }
  if (value !== undefined) c.value = value
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
  } else if (snapVertexId) {
    // Vertex snap: parse vertex ID to get existing entity reference
    // snapVertexId format: "vertex:featId:entityId:vertexKey"
    const snapParts = snapVertexId.split(':')
    const snapEntityId = snapParts[2]
    target = `vertex:${featureId}:${snapEntityId}:${snapParts[3] || 'start'}`
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
  } else if (snapVertexId) {
    const snapParts = snapVertexId.split(':')
    const snapEntityId = snapParts[2]
    target = `vertex:${featureId}:${snapEntityId}:${snapParts[3] || 'xy'}`
  } else {
    return
  }

  applyAddConstraint(doc, featureId, constraintKind, [
    `vertex:${featureId}:${eid}:xy`,
    target,
  ])
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

export function applySetFeaturePlane(doc: PartDoc, featureId: string, plane: string): void {
  const feature = findFeature(doc, featureId)
  if (!feature) return
  feature.plane = plane
}

export function applyAddSketch(doc: PartDoc, featureId: string, label?: string): void {
  if (!doc.features) doc.features = []
  const feature: PartFeature = { id: featureId, kind: 'sketch' }
  if (label) feature.label = label
  doc.features.push(feature)
}

export function applyDeleteFeature(doc: PartDoc, featureId: string): void {
  if (!doc.features) return
  doc.features = doc.features.filter(f => f.id !== featureId)
}

export function applySetFeatureVisibility(doc: PartDoc, featureId: string, visible: boolean): void {
  const feature = findFeature(doc, featureId)
  if (!feature) return
  if (visible) {
    delete feature.visible
  } else {
    feature.visible = false
  }
}

export function applyRenameFeature(doc: PartDoc, featureId: string, label: string): void {
  const feature = findFeature(doc, featureId)
  if (!feature) return
  if (label.trim()) {
    feature.label = label.trim()
  } else {
    delete feature.label
  }
}

export function applyToggleSketchPlaneVisibility(doc: PartDoc): void {
  const targets = (doc.features ?? []).filter(
    f => (f.kind === 'sketch' || f.kind === 'plane')
  )
  const anyVisible = targets.some(f => f.visible !== false)
  for (const f of targets) {
    if (anyVisible) {
      f.visible = false
    } else {
      delete f.visible
    }
  }
}

export function applyAddPlane(doc: PartDoc, featureId: string, label?: string): void {
  if (!doc.features) doc.features = []
  const feature: PartFeature = { id: featureId, kind: 'plane', definition: { mode: 'offset' } }
  if (label) feature.label = label
  doc.features.push(feature)
}

export function applySetPlaneDefinitionField(
  doc: PartDoc,
  featureId: string,
  field: string,
  value: string | number,
): void {
  const feature = findFeature(doc, featureId)
  if (!feature) return
  if (!feature.definition) feature.definition = {}
  ;(feature.definition as Record<string, string | number>)[field] = value
}

export function applyAddExtrude(
  doc: PartDoc,
  featureId: string,
  label: string | undefined,
  sketchQuery: string,
  distance: number,
): void {
  if (!doc.features) doc.features = []
  const feature: PartFeature = {
    id: featureId,
    kind: 'extrude',
    label: label ?? 'Extrude',
    extrude: {
      sketch: sketchQuery,
      distance,
      direction: 'normal',
    },
  }
  doc.features.push(feature)
}

export function applySetExtrudeDistance(doc: PartDoc, featureId: string, distance: number): void {
  const feature = findFeature(doc, featureId)
  if (!feature?.extrude) {
    console.warn(`applySetExtrudeDistance: feature ${featureId} has no extrude`)
    return
  }
  feature.extrude.distance = distance
}

export function applySetExtrudeDirection(
  doc: PartDoc,
  featureId: string,
  direction: 'normal' | 'reverse' | 'symmetric',
): void {
  const feature = findFeature(doc, featureId)
  if (!feature?.extrude) {
    console.warn(`applySetExtrudeDirection: feature ${featureId} has no extrude`)
    return
  }
  feature.extrude.direction = direction
}

export function applySetExtrudeSketch(doc: PartDoc, featureId: string, sketchQuery: string): void {
  const feature = findFeature(doc, featureId)
  if (!feature?.extrude) {
    console.warn(`applySetExtrudeSketch: feature ${featureId} has no extrude`)
    return
  }
  feature.extrude.sketch = sketchQuery
}

export function applyAddImportStep(
  doc: PartDoc,
  featureId: string,
  fileId: string,
  label?: string,
): void {
  if (!doc.features) doc.features = []
  const feature: PartFeature = { id: featureId, kind: 'import_step', file_id: fileId }
  if (label) feature.label = label
  doc.features.push(feature)
}
