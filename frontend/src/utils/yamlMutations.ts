import type { PartDoc, PartFeature, PartConstraint, PartTarget } from '../types/cad'

// ---------------------------------------------------------------------------
// Architecture contract
// ---------------------------------------------------------------------------
//
// PartDoc is the SOURCE OF TRUTH for the document.
// ...
// See ast.md for example.
//
// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const round = (v: number) => Math.round(v * 1e6) / 1e6

const VERTEX_INDICES: Record<string, Record<string, [number, number]>> = {
  line_segment: { start: [0, 1], end: [2, 3] },
  circle:       { center: [0, 1] },
  arc:          { center: [0, 1] },
  point:        { xy: [0, 1] },
}

const ALL_COORD_INDICES: Record<string, [number, number][]> = {
  line_segment: [[0, 1], [2, 3]],
  circle:       [[0, 1]],
  arc:          [[0, 1]],
  point:        [[0, 1]],
}

const KIND_PREFIX: Record<string, string> = {
  line_segment: 'line',
  circle:       'circle',
  arc:          'arc',
  point:        'point',
}

function findFeature(doc: PartDoc, featureId: string): PartFeature | undefined {
  return doc.features?.find(f => f.id === featureId)
}

const parseTarget = (t: string): PartTarget => {
  const parts = t.split(':')
  if (parts[0] === 'entity') return '$' + parts[2]
  if (parts[0] === 'vertex') return '$' + parts[2] + parts[3]
  return '$' + t
}

function uniqueConstraintId(constraints: PartConstraint[], kind: string): string {
  const existing = new Set(constraints.map(c => c.id))
  let idx = existing.size + 1
  let cid = `c_${kind}_${idx}`
  while (existing.has(cid)) { idx++; cid = `c_${kind}_${idx}` }
  return cid
}

// ---------------------------------------------------------------------------
// Mutations — all modify the doc object in place
// ---------------------------------------------------------------------------

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
  if (targets.length === 1) c.target = parseTarget(targets[0])
  else if (targets.length >= 2) { c.a = parseTarget(targets[0]); c.b = parseTarget(targets[1]) }
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

export function applyAddEntity(
  doc: PartDoc,
  featureId: string,
  kind: string,
  params: number[],
): void {
  const feature = findFeature(doc, featureId)
  if (!feature) return
  if (!feature.entities) feature.entities = []
  if (!feature.initial) feature.initial = {}
  const existing = new Set(feature.entities.map(e => e.id))
  const prefix = KIND_PREFIX[kind] ?? kind
  let idx = 1
  let eid = `${prefix}${idx}`
  while (existing.has(eid)) { idx++; eid = `${prefix}${idx}` }
  feature.entities.push({ id: eid, kind })
  feature.initial[eid] = params.map(round)
}

export function applyAddRect(
  doc: PartDoc,
  featureId: string,
  p0: [number, number],
  p1: [number, number],
): void {
  const feature = findFeature(doc, featureId)
  if (!feature) return
  if (!feature.entities) feature.entities = []
  if (!feature.initial) feature.initial = {}
  if (!feature.constraints) feature.constraints = []

  const existingIds = new Set(feature.entities.map(e => e.id))
  const lineIds: string[] = []
  let idx = 1
  for (let i = 0; i < 4; i++) {
    while (existingIds.has(`line${idx}`)) idx++
    lineIds.push(`line${idx}`)
    existingIds.add(`line${idx}`)
    idx++
  }
  const [lA, lB, lC, lD] = lineIds
  const [x0, y0] = p0
  const [x1, y1] = p1
  const fid = featureId

  const lines: [string, number[]][] = [
    [lA, [x0, y0, x1, y0]],
    [lB, [x1, y0, x1, y1]],
    [lC, [x1, y1, x0, y1]],
    [lD, [x0, y1, x0, y0]],
  ]
  for (const [eid, params] of lines) {
    feature.entities.push({ id: eid, kind: 'line_segment' })
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
}
