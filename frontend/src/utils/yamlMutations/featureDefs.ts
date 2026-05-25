import type { PartDoc, PartFeature, BooleanFeatureDef, TransformFeatureDef, MirrorFeatureDef, ExtrudeFeatureDef, RevolveFeatureDef, FilletFeatureDef, ChamferFeatureDef, ArrayFeatureDef, CircularArrayFeatureDef, DeleteBodyFeatureDef, HoleFeatureDef } from '@/types/cad'
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

// ─── Set Feature Field (generic) ───

export function applySetExtrudeField(doc: PartDoc, featureId: string, field: keyof ExtrudeFeatureDef, value: unknown): void {
  const feature = findFeature(doc, featureId)
  if (!feature?.extrude) {
    warn(`applySetExtrudeField: feature ${featureId} has no extrude`)
    return
  }
  setFeatureField(feature.extrude as unknown as Record<string, unknown>, field, value)
}

export function applySetRevolveField(doc: PartDoc, featureId: string, field: keyof RevolveFeatureDef, value: unknown): void {
  const feature = findFeature(doc, featureId)
  if (!feature?.revolve) {
    warn(`applySetRevolveField: feature ${featureId} has no revolve`)
    return
  }
  setFeatureField(feature.revolve as unknown as Record<string, unknown>, field, value)
}

export function applySetFilletField(doc: PartDoc, featureId: string, field: keyof FilletFeatureDef, value: unknown): void {
  const feature = findFeature(doc, featureId)
  if (!feature?.fillet) {
    warn(`applySetFilletField: feature ${featureId} has no fillet`)
    return
  }
  setFeatureField(feature.fillet as unknown as Record<string, unknown>, field, value)
}

export function applySetChamferField(doc: PartDoc, featureId: string, field: keyof ChamferFeatureDef, value: unknown): void {
  const feature = findFeature(doc, featureId)
  if (!feature?.chamfer) {
    warn(`applySetChamferField: feature ${featureId} has no chamfer`)
    return
  }
  setFeatureField(feature.chamfer as unknown as Record<string, unknown>, field, value)
}

export function applySetBooleanField(doc: PartDoc, featureId: string, field: keyof BooleanFeatureDef, value: unknown): void {
  const feature = findFeature(doc, featureId)
  if (!feature?.boolean) {
    warn(`applySetBooleanField: feature ${featureId} has no boolean`)
    return
  }
  setFeatureField(feature.boolean as unknown as Record<string, unknown>, field, value)
}

export function applySetArrayField(doc: PartDoc, featureId: string, field: keyof ArrayFeatureDef, value: unknown): void {
  const feature = findFeature(doc, featureId)
  if (!feature?.array) {
    warn(`applySetArrayField: feature ${featureId} has no array`)
    return
  }
  if (field === 'mode' && typeof value === 'string') {
    applySetArrayMode(doc, featureId, value as 'linear' | 'rectangular')
    return
  }
  setFeatureField(feature.array as unknown as Record<string, unknown>, field, value)
}

export function applySetDeleteBodyField(doc: PartDoc, featureId: string, field: keyof DeleteBodyFeatureDef, value: unknown): void {
  const feat = doc.features?.find(f => f.id === featureId)
  if (!feat?.delete_body) return
  setFeatureField(feat.delete_body as unknown as Record<string, unknown>, field, value)
}

export function applySetHoleField(doc: PartDoc, featureId: string, field: keyof HoleFeatureDef, value: unknown): void {
  const f = doc.features?.find(feat => feat.id === featureId)
  if (!f?.hole) return
  if (field === 'sketch' && typeof value === 'string') {
    applySetHoleSketch(doc, featureId, value)
    return
  }
  setFeatureField(f.hole as unknown as Record<string, unknown>, field, value)
}

function setFeatureField(obj: Record<string, unknown>, field: string, value: unknown): void {
  if (value === undefined || value === null || value === '') {
    delete obj[field]
  } else {
    obj[field] = value
  }
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
  mode: 'linear' | 'rectangular',
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
  } else if (mode === 'rectangular') {
    if (typeof feature.array.count_x !== 'number') feature.array.count_x = 2
    if (typeof feature.array.pitch_x !== 'number') feature.array.pitch_x = 20
    if (typeof feature.array.count_y !== 'number') feature.array.count_y = 2
    if (typeof feature.array.pitch_y !== 'number') feature.array.pitch_y = 20
  }
}

// ─── Circular Array ───

export function applyAddCircularArray(doc: PartDoc, featureId: string, label?: string): void {
  if (!doc.features) doc.features = []
  const feature: PartFeature = {
    id: featureId,
    kind: 'circular_array',
    label: label ?? 'Circular Array',
    circular_array: {
      count: 4,
      operation: 'add',
      include_source: true,
      axis_origin: [0, 0, 0],
      axis_direction: [0, 0, 1],
    },
  }
  doc.features.push(feature)
}

export function applySetCircularArrayField(doc: PartDoc, featureId: string, field: keyof CircularArrayFeatureDef, value: unknown): void {
  const feature = findFeature(doc, featureId)
  if (!feature?.circular_array) {
    warn(`applySetCircularArrayField: feature ${featureId} has no circular_array`)
    return
  }
  setFeatureField(feature.circular_array as unknown as Record<string, unknown>, field, value)
}

// ─── Delete Body ───

export function applySetArraySourceBody(doc: PartDoc, featureId: string, sourceBody: string): void {
  const feature = findFeature(doc, featureId)
  if (!feature?.array) {
    warn(`applySetArraySourceBody: feature ${featureId} has no array`)
    return
  }
  feature.array.source_body = sourceBody
}

export function applySetDeleteBodyTarget(doc: PartDoc, featureId: string, target: string): void {
  const feat = doc.features?.find(f => f.id === featureId)
  if (!feat?.delete_body) return
  feat.delete_body.body = target
}

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
