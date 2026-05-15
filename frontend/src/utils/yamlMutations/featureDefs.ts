import type { PartDoc, PartFeature, BooleanFeatureDef, TransformFeatureDef, MirrorFeatureDef } from '@/types/cad'
import { ALL_COORD_INDICES } from '@/registry'
import { warn, round, findFeature, randomId, normalizeExtrudeSketch, normalizeRevolveSketch } from './helpers'

// ─── Auto-hide consumed sketches (feature 223) ───

function findSketchFeatureIdFromQuery(doc: PartDoc, query: string): string | null {
  if (query.startsWith('entity:')) {
    const featId = query.split(':')[1]
    const feat = doc.features?.find(f => f.id === featId && f.kind === 'sketch')
    return feat ? featId : null
  }
  if (query.startsWith('@')) {
    const rest = query.slice(1)
    for (const f of doc.features ?? []) {
      if (f.kind === 'sketch' && rest.startsWith(f.id)) {
        return f.id
      }
    }
    return null
  }
  return null
}

function autoHideIfNotOverridden(doc: PartDoc, sketchId: string, consumingFeatureId: string): void {
  const sketch = doc.features?.find(f => f.id === sketchId && f.kind === 'sketch')
  if (!sketch) return
  if (sketch.auto_hidden_by) return  // user overrode — skip auto-hide
  sketch.visible = false
  sketch.auto_hidden_by = consumingFeatureId
}

// ─── Extrude ───

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
      sketch: sketchQuery ? [sketchQuery] : [],
      distance,
      direction: 'normal',
    },
  }
  doc.features.push(feature)
}

export function applyAddExtrudeProfile(doc: PartDoc, featureId: string, sketchQuery: string): void {
  const feature = findFeature(doc, featureId)
  if (!feature?.extrude) {
    warn(`applyAddExtrudeProfile: feature ${featureId} has no extrude`)
    return
  }
  const current = normalizeExtrudeSketch(feature.extrude.sketch)
  const idx = current.indexOf(sketchQuery)
  if (idx >= 0) {
    current.splice(idx, 1)
  } else {
    current.push(sketchQuery)
    // Auto-hide consumed sketch (feature 223)
    const sourceSketchId = findSketchFeatureIdFromQuery(doc, sketchQuery)
    if (sourceSketchId) autoHideIfNotOverridden(doc, sourceSketchId, featureId)
  }
  feature.extrude.sketch = current
}

export function applyRemoveExtrudeProfile(doc: PartDoc, featureId: string, index: number): void {
  const feature = findFeature(doc, featureId)
  if (!feature?.extrude) {
    warn(`applyRemoveExtrudeProfile: feature ${featureId} has no extrude`)
    return
  }
  const current = normalizeExtrudeSketch(feature.extrude.sketch)
  current.splice(index, 1)
  feature.extrude.sketch = current
}

export function applySetExtrudeDistance(doc: PartDoc, featureId: string, distance: number): void {
  const feature = findFeature(doc, featureId)
  if (!feature?.extrude) {
    warn(`applySetExtrudeDistance: feature ${featureId} has no extrude`)
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
    warn(`applySetExtrudeDirection: feature ${featureId} has no extrude`)
    return
  }
  feature.extrude.direction = direction
}

export function applySetExtrudeOperation(
  doc: PartDoc,
  featureId: string,
  operation: 'add' | 'cut' | 'new',
): void {
  const feature = findFeature(doc, featureId)
  if (!feature?.extrude) {
    warn(`applySetExtrudeOperation: feature ${featureId} has no extrude`)
    return
  }
  feature.extrude.operation = operation
}

export function applySetExtrudeMergeTarget(
  doc: PartDoc, featureId: string, mergeTarget?: string,
): void {
  const feature = findFeature(doc, featureId)
  if (!feature?.extrude) {
    warn(`applySetExtrudeMergeTarget: feature ${featureId} has no extrude`)
    return
  }
  if (mergeTarget) {
    feature.extrude.merge_target = mergeTarget
  } else {
    delete feature.extrude.merge_target
  }
}

// ─── Revolve ───

export function applyAddRevolve(
  doc: PartDoc,
  featureId: string,
  label: string | undefined,
  sketchQuery: string,
  angle: number,
): void {
  if (!doc.features) doc.features = []
  const feature: PartFeature = {
    id: featureId,
    kind: 'revolve',
    label: label ?? 'Revolve',
    revolve: {
      sketch: sketchQuery ? [sketchQuery] : [],
      angle,
      axis_origin: [0, 0, 0],
      axis_direction: [0, 0, 1],
    },
  }
  doc.features.push(feature)
}

export function applyAddRevolveProfile(doc: PartDoc, featureId: string, sketchQuery: string): void {
  const feature = findFeature(doc, featureId)
  if (!feature?.revolve) {
    warn(`applyAddRevolveProfile: feature ${featureId} has no revolve`)
    return
  }
  const current = normalizeRevolveSketch(feature.revolve.sketch)
  const idx = current.indexOf(sketchQuery)
  if (idx >= 0) {
    current.splice(idx, 1)
  } else {
    current.push(sketchQuery)
    // Auto-hide consumed sketch (feature 223)
    const sourceSketchId = findSketchFeatureIdFromQuery(doc, sketchQuery)
    if (sourceSketchId) autoHideIfNotOverridden(doc, sourceSketchId, featureId)
  }
  feature.revolve.sketch = current
}

export function applyRemoveRevolveProfile(doc: PartDoc, featureId: string, index: number): void {
  const feature = findFeature(doc, featureId)
  if (!feature?.revolve) {
    warn(`applyRemoveRevolveProfile: feature ${featureId} has no revolve`)
    return
  }
  const current = normalizeRevolveSketch(feature.revolve.sketch)
  current.splice(index, 1)
  feature.revolve.sketch = current
}

export function applySetRevolveAngle(doc: PartDoc, featureId: string, angle: number): void {
  const feature = findFeature(doc, featureId)
  if (!feature?.revolve) {
    warn(`applySetRevolveAngle: feature ${featureId} has no revolve`)
    return
  }
  feature.revolve.angle = angle
}

export function applySetRevolveDirection(
  doc: PartDoc,
  featureId: string,
  direction: 'normal' | 'reverse' | 'symmetric',
): void {
  const feature = findFeature(doc, featureId)
  if (!feature?.revolve) {
    warn(`applySetRevolveDirection: feature ${featureId} has no revolve`)
    return
  }
  feature.revolve.direction = direction
}

export function applySetRevolveAxis(doc: PartDoc, featureId: string, axis: string): void {
  const feature = findFeature(doc, featureId)
  if (!feature?.revolve) {
    warn(`applySetRevolveAxis: feature ${featureId} has no revolve`)
    return
  }
  feature.revolve.axis = axis
}

export function applySetRevolveOperation(
  doc: PartDoc,
  featureId: string,
  operation: 'add' | 'cut' | 'new',
): void {
  const feature = findFeature(doc, featureId)
  if (!feature?.revolve) {
    warn(`applySetRevolveOperation: feature ${featureId} has no revolve`)
    return
  }
  feature.revolve.operation = operation
}

export function applySetRevolveMergeTarget(
  doc: PartDoc, featureId: string, mergeTarget?: string,
): void {
  const feature = findFeature(doc, featureId)
  if (!feature?.revolve) {
    warn(`applySetRevolveMergeTarget: feature ${featureId} has no revolve`)
    return
  }
  if (mergeTarget) {
    feature.revolve.merge_target = mergeTarget
  } else {
    delete feature.revolve.merge_target
  }
}

// ─── Import Step ───

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

// ─── Fillet / Chamfer ───

export function applyAddFillet(
  doc: PartDoc,
  featureId: string,
  label?: string,
): void {
  if (!doc.features) doc.features = []
  const feature: PartFeature = {
    id: featureId,
    kind: 'fillet',
    label: label ?? 'Fillet',
    fillet: { edges: [], radius: 1 },
  }
  doc.features.push(feature)
}

export function applyAddChamfer(
  doc: PartDoc,
  featureId: string,
  label?: string,
): void {
  if (!doc.features) doc.features = []
  const feature: PartFeature = {
    id: featureId,
    kind: 'chamfer',
    label: label ?? 'Chamfer',
    chamfer: { edges: [], distance: 1, kind: 'distance', angle: 45 },
  }
  doc.features.push(feature)
}

export function applySetFilletRadius(doc: PartDoc, featureId: string, radius: number): void {
  const feature = findFeature(doc, featureId)
  if (!feature?.fillet) {
    warn(`applySetFilletRadius: feature ${featureId} has no fillet`)
    return
  }
  feature.fillet.radius = radius
}

export function applySetChamferDistance(doc: PartDoc, featureId: string, distance: number): void {
  const feature = findFeature(doc, featureId)
  if (!feature?.chamfer) {
    warn(`applySetChamferDistance: feature ${featureId} has no chamfer`)
    return
  }
  feature.chamfer.distance = distance
}

export function applySetChamferAngle(doc: PartDoc, featureId: string, angle: number): void {
  const feature = findFeature(doc, featureId)
  if (!feature?.chamfer) {
    warn(`applySetChamferAngle: feature ${featureId} has no chamfer`)
    return
  }
  feature.chamfer.angle = angle
}

export function applySetChamferKind(
  doc: PartDoc,
  featureId: string,
  kind: 'distance' | 'angle_distance',
): void {
  const feature = findFeature(doc, featureId)
  if (!feature?.chamfer) {
    warn(`applySetChamferKind: feature ${featureId} has no chamfer`)
    return
  }
  feature.chamfer.kind = kind
}

export function applyAddFilletEdge(doc: PartDoc, featureId: string, edgeQuery: string): void {
  const feature = findFeature(doc, featureId)
  if (!feature?.fillet) {
    warn(`applyAddFilletEdge: feature ${featureId} has no fillet`)
    return
  }
  const idx = feature.fillet.edges.indexOf(edgeQuery)
  if (idx >= 0) {
    feature.fillet.edges.splice(idx, 1)
  } else {
    feature.fillet.edges.push(edgeQuery)
  }
}

export function applyRemoveFilletEdge(doc: PartDoc, featureId: string, index: number): void {
  const feature = findFeature(doc, featureId)
  if (!feature?.fillet) {
    warn(`applyRemoveFilletEdge: feature ${featureId} has no fillet`)
    return
  }
  feature.fillet.edges.splice(index, 1)
}

export function applyAddChamferEdge(doc: PartDoc, featureId: string, edgeQuery: string): void {
  const feature = findFeature(doc, featureId)
  if (!feature?.chamfer) {
    warn(`applyAddChamferEdge: feature ${featureId} has no chamfer`)
    return
  }
  const idx = feature.chamfer.edges.indexOf(edgeQuery)
  if (idx >= 0) {
    feature.chamfer.edges.splice(idx, 1)
  } else {
    feature.chamfer.edges.push(edgeQuery)
  }
}

export function applyRemoveChamferEdge(doc: PartDoc, featureId: string, index: number): void {
  const feature = findFeature(doc, featureId)
  if (!feature?.chamfer) {
    warn(`applyRemoveChamferEdge: feature ${featureId} has no chamfer`)
    return
  }
  feature.chamfer.edges.splice(index, 1)
}

// ─── Boolean ───

export function applyAddBoolean(doc: PartDoc, featureId: string, label?: string): void {
  if (!doc.features) doc.features = []
  const feature: PartFeature = {
    id: featureId,
    kind: 'boolean',
    label: label ?? 'Boolean',
    boolean: { operation: 'union', target: '', tools: [] },
  }
  doc.features.push(feature)
}

export function applySetBooleanOperation(
  doc: PartDoc,
  featureId: string,
  operation: BooleanFeatureDef['operation'],
): void {
  const feature = findFeature(doc, featureId)
  if (!feature?.boolean) {
    warn(`applySetBooleanOperation: feature ${featureId} has no boolean`)
    return
  }
  feature.boolean.operation = operation
}

export function applySetBooleanTarget(doc: PartDoc, featureId: string, target: string): void {
  const feature = findFeature(doc, featureId)
  if (!feature?.boolean) {
    warn(`applySetBooleanTarget: feature ${featureId} has no boolean`)
    return
  }
  feature.boolean.target = target
}

export function applyAddBooleanTool(doc: PartDoc, featureId: string, tool: string): void {
  const feature = findFeature(doc, featureId)
  if (!feature?.boolean) {
    warn(`applyAddBooleanTool: feature ${featureId} has no boolean`)
    return
  }
  const idx = feature.boolean.tools.indexOf(tool)
  if (idx >= 0) {
    feature.boolean.tools.splice(idx, 1)
  } else {
    feature.boolean.tools.push(tool)
  }
}

export function applyRemoveBooleanTool(doc: PartDoc, featureId: string, tool: string): void {
  const feature = findFeature(doc, featureId)
  if (!feature?.boolean) {
    warn(`applyRemoveBooleanTool: feature ${featureId} has no boolean`)
    return
  }
  feature.boolean.tools = feature.boolean.tools.filter(t => t !== tool)
}

export function applySetBooleanKeepTools(doc: PartDoc, featureId: string, keepTools: boolean): void {
  const feature = findFeature(doc, featureId)
  if (!feature?.boolean) {
    warn(`applySetBooleanKeepTools: feature ${featureId} has no boolean`)
    return
  }
  feature.boolean.keep_tools = keepTools
}

// ─── Array ───

export function applyAddArray(doc: PartDoc, featureId: string, label?: string): void {
  if (!doc.features) doc.features = []
  const feature: PartFeature = {
    id: featureId,
    kind: 'array',
    label: label ?? 'Array',
    array: {
      mode: 'linear',
      count_x: 2,
      pitch_x: 20,
      direction_x: [1, 0, 0],
      operation: 'add',
      include_source: true,
    },
  }
  doc.features.push(feature)
}

export function applySetArrayMode(
  doc: PartDoc,
  featureId: string,
  mode: 'linear' | 'rectangular' | 'rotational',
): void {
  const feature = findFeature(doc, featureId)
  if (!feature?.array) {
    warn(`applySetArrayMode: feature ${featureId} has no array`)
    return
  }
  feature.array.mode = mode
  if (mode === 'linear') {
    if (typeof feature.array.count_x !== 'number') feature.array.count_x = 2
    if (typeof feature.array.pitch_x !== 'number') feature.array.pitch_x = 20
    delete feature.array.count_y
    delete feature.array.pitch_y
    delete feature.array.count
    delete feature.array.step_angle
    delete feature.array.axis
  } else if (mode === 'rectangular') {
    if (typeof feature.array.count_x !== 'number') feature.array.count_x = 2
    if (typeof feature.array.pitch_x !== 'number') feature.array.pitch_x = 20
    if (typeof feature.array.count_y !== 'number') feature.array.count_y = 2
    if (typeof feature.array.pitch_y !== 'number') feature.array.pitch_y = 20
    delete feature.array.count
    delete feature.array.step_angle
    delete feature.array.axis
  } else {
    if (typeof feature.array.count !== 'number') feature.array.count = 4
    delete feature.array.count_x
    delete feature.array.pitch_x
    delete feature.array.count_y
    delete feature.array.pitch_y
  }
}

export function applySetArraySourceBody(doc: PartDoc, featureId: string, sourceBody: string): void {
  const feature = findFeature(doc, featureId)
  if (!feature?.array) {
    warn(`applySetArraySourceBody: feature ${featureId} has no array`)
    return
  }
  feature.array.source_body = sourceBody
}

export function applySetArrayOperation(doc: PartDoc, featureId: string, operation: 'add' | 'new'): void {
  const feature = findFeature(doc, featureId)
  if (!feature?.array) {
    warn(`applySetArrayOperation: feature ${featureId} has no array`)
    return
  }
  feature.array.operation = operation
}

export function applySetArrayIncludeSource(doc: PartDoc, featureId: string, includeSource: boolean): void {
  const feature = findFeature(doc, featureId)
  if (!feature?.array) {
    warn(`applySetArrayIncludeSource: feature ${featureId} has no array`)
    return
  }
  feature.array.include_source = includeSource
}

export function applySetArrayCountX(doc: PartDoc, featureId: string, count: number): void {
  const feature = findFeature(doc, featureId)
  if (!feature?.array) {
    warn(`applySetArrayCountX: feature ${featureId} has no array`)
    return
  }
  feature.array.count_x = count
}

export function applySetArrayPitchX(doc: PartDoc, featureId: string, pitch: number): void {
  const feature = findFeature(doc, featureId)
  if (!feature?.array) {
    warn(`applySetArrayPitchX: feature ${featureId} has no array`)
    return
  }
  feature.array.pitch_x = pitch
}

export function applySetArrayDirectionXQuery(doc: PartDoc, featureId: string, query: string): void {
  const feature = findFeature(doc, featureId)
  if (!feature?.array) {
    warn(`applySetArrayDirectionXQuery: feature ${featureId} has no array`)
    return
  }
  feature.array.direction_x_query = query
}

export function applySetArrayCountY(doc: PartDoc, featureId: string, count: number): void {
  const feature = findFeature(doc, featureId)
  if (!feature?.array) {
    warn(`applySetArrayCountY: feature ${featureId} has no array`)
    return
  }
  feature.array.count_y = count
}

export function applySetArrayPitchY(doc: PartDoc, featureId: string, pitch: number): void {
  const feature = findFeature(doc, featureId)
  if (!feature?.array) {
    warn(`applySetArrayPitchY: feature ${featureId} has no array`)
    return
  }
  feature.array.pitch_y = pitch
}

export function applySetArrayDirectionYQuery(doc: PartDoc, featureId: string, query: string): void {
  const feature = findFeature(doc, featureId)
  if (!feature?.array) {
    warn(`applySetArrayDirectionYQuery: feature ${featureId} has no array`)
    return
  }
  feature.array.direction_y_query = query
}

export function applySetArrayCount(doc: PartDoc, featureId: string, count: number): void {
  const feature = findFeature(doc, featureId)
  if (!feature?.array) {
    warn(`applySetArrayCount: feature ${featureId} has no array`)
    return
  }
  feature.array.count = count
}

export function applySetArrayStepAngle(doc: PartDoc, featureId: string, stepAngle: number | null): void {
  const feature = findFeature(doc, featureId)
  if (!feature?.array) {
    warn(`applySetArrayStepAngle: feature ${featureId} has no array`)
    return
  }
  feature.array.step_angle = stepAngle
}

export function applySetArrayAxis(doc: PartDoc, featureId: string, axis: string): void {
  const feature = findFeature(doc, featureId)
  if (!feature?.array) {
    warn(`applySetArrayAxis: feature ${featureId} has no array`)
    return
  }
  feature.array.axis = axis
}

export function applySetArrayDirectionX(doc: PartDoc, featureId: string, direction_x: [number, number, number]): void {
  const feature = findFeature(doc, featureId)
  if (!feature?.array) {
    warn(`applySetArrayDirectionX: feature ${featureId} has no array`)
    return
  }
  feature.array.direction_x = direction_x
}

export function applySetArrayDirectionY(doc: PartDoc, featureId: string, direction_y: [number, number, number]): void {
  const feature = findFeature(doc, featureId)
  if (!feature?.array) {
    warn(`applySetArrayDirectionY: feature ${featureId} has no array`)
    return
  }
  feature.array.direction_y = direction_y
}

// ─── Delete Body ───

export function applyAddDeleteBody(
  doc: PartDoc,
  featureId: string,
  body = '',
  label?: string,
): void {
  if (!doc.features) doc.features = []
  doc.features.push({
    id: featureId,
    kind: 'delete_body',
    label: label ?? 'Delete Body',
    delete_body: { body },
  })
}

export function applySetDeleteBodyTarget(
  doc: PartDoc,
  featureId: string,
  body: string,
): void {
  const feat = doc.features?.find(f => f.id === featureId)
  if (!feat?.delete_body) return
  feat.delete_body.body = body
}

// ─── Hole ───

export function applyAddHole(doc: PartDoc, featureId: string, label?: string): void {
  if (!doc.features) doc.features = []
  doc.features.push({
    id: featureId,
    kind: 'hole',
    label: label ?? 'Hole',
    hole: { sketch: '', diameter: 10, depth_mode: 'blind', depth: 20, direction: 'normal' },
  })
}

export function applySetHoleSketch(doc: PartDoc, featureId: string, sketch: string): void {
  const f = doc.features?.find(feat => feat.id === featureId)
  if (!f?.hole) return
  f.hole.sketch = sketch
  // Auto-hide consumed sketch (feature 223)
  const sourceSketchId = findSketchFeatureIdFromQuery(doc, sketch)
  if (sourceSketchId) autoHideIfNotOverridden(doc, sourceSketchId, featureId)
}

export function applySetHoleDiameter(doc: PartDoc, featureId: string, diameter: number): void {
  const f = doc.features?.find(feat => feat.id === featureId)
  if (!f?.hole) return
  f.hole.diameter = diameter
}

export function applySetHoleDepth(doc: PartDoc, featureId: string, depth: number): void {
  const f = doc.features?.find(feat => feat.id === featureId)
  if (!f?.hole) return
  f.hole.depth = depth
}

export function applySetHoleDepthMode(
  doc: PartDoc,
  featureId: string,
  depthMode: 'blind' | 'through_all',
): void {
  const f = doc.features?.find(feat => feat.id === featureId)
  if (!f?.hole) return
  f.hole.depth_mode = depthMode
}

export function applySetHoleDirection(
  doc: PartDoc,
  featureId: string,
  direction: 'normal' | 'reverse',
): void {
  const f = doc.features?.find(feat => feat.id === featureId)
  if (!f?.hole) return
  f.hole.direction = direction
}

export function applySetHoleTarget(doc: PartDoc, featureId: string, target: string): void {
  const f = doc.features?.find(feat => feat.id === featureId)
  if (!f?.hole) return
  f.hole.target = target
}

// ─── Transform ───

export function applyAddTransform(doc: PartDoc, featureId: string, label?: string): void {
  if (!doc.features) doc.features = []
  doc.features.push({
    id: featureId,
    kind: 'transform',
    label: label ?? 'Transform',
    transform: {
      body: '',
      operation: 'new',
      translation: [0, 0, 0],
      rotation_angle: 0,
      scale: 1,
    },
  })
}

export function applySetTransformField(
  doc: PartDoc,
  featureId: string,
  field: keyof TransformFeatureDef,
  value: unknown,
): void {
  const feat = doc.features?.find(f => f.id === featureId)
  if (!feat?.transform) return
  ;(feat.transform as unknown as Record<string, unknown>)[field] = value
}

// ─── Mirror ───

export function applyMirrorEntities(
  doc: PartDoc,
  featureId: string,
  entityIds: string[],
  mirrorLineId: string,
): void {
  const feature = findFeature(doc, featureId)
  if (!feature?.initial || !feature.entities) return

  const lineParams = feature.initial[mirrorLineId]
  if (!lineParams || lineParams.length < 4) return

  const [ax, ay, bx, by] = lineParams
  const dx = bx - ax
  const dy = by - ay
  const len2 = dx * dx + dy * dy
  if (len2 < 1e-12) return

  const reflectPoint = (px: number, py: number): [number, number] => {
    const t = ((px - ax) * dx + (py - ay) * dy) / len2
    const rx = 2 * (ax + t * dx) - px
    const ry = 2 * (ay + t * dy) - py
    return [rx, ry]
  }

  const lineAngle = Math.atan2(dy, dx) * 180 / Math.PI

  for (const eid of entityIds) {
    const entDef = feature.entities.find(e => e.id === eid)
    if (!entDef) continue
    const params = feature.initial[eid]
    if (!params) continue

    const kind = entDef.kind
    let newParams: number[]

    if (kind === 'arc') {
      const [cx, cy, r, a1, a2] = params
      const [rcx, rcy] = reflectPoint(cx, cy)
      const newA1 = ((2 * lineAngle - a2) % 360 + 360) % 360
      const newA2 = ((2 * lineAngle - a1) % 360 + 360) % 360
      newParams = [rcx, rcy, r, newA1, newA2]
    } else {
      const coordPairs = ALL_COORD_INDICES[kind]
      if (!coordPairs) continue
      newParams = [...params]
      for (const [xi, yi] of coordPairs) {
        const [rx, ry] = reflectPoint(params[xi], params[yi])
        newParams[xi] = rx
        newParams[yi] = ry
      }
    }

    const newId = randomId(12)
    feature.entities.push({ id: newId, kind })
    feature.initial[newId] = newParams.map(round)
  }
}

export function applyAddMirror(doc: PartDoc, featureId: string, label?: string): void {
  if (!doc.features) doc.features = []
  doc.features.push({
    id: featureId,
    kind: 'mirror',
    label: label ?? 'Mirror',
    mirror: { body: '', plane: '', keep_original: true, merge: true },
  })
}

export function applySetMirrorField(
  doc: PartDoc,
  featureId: string,
  field: keyof MirrorFeatureDef,
  value: unknown,
): void {
  const feat = doc.features?.find(f => f.id === featureId)
  if (!feat?.mirror) {
    warn(`applySetMirrorField: feature ${featureId} has no mirror`)
    return
  }
  ;(feat.mirror as unknown as Record<string, unknown>)[field] = value
}
