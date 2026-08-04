import type { PartDoc, PartFeature, BooleanFeatureDef, TransformFeatureDef, MirrorFeatureDef, ExtrudeFeatureDef, RevolveFeatureDef, SweepFeatureDef, FilletFeatureDef, ChamferFeatureDef, ArrayFeatureDef, CircularArrayFeatureDef, HoleFeatureDef, VariableFeatureDef } from '@/types/cad'
import { warn, findFeature, normalizeRefList } from './helpers'

/** Append a feature, lazily initializing the features array. */
function pushFeature(doc: PartDoc, feature: PartFeature): void {
  if (!doc.features) doc.features = []
  doc.features.push(feature)
}

// ─── Set Feature Field (generic) ───

// Shared body for the `applySet<Kind>Field` mutators that warn when the
// sub-feature is absent and clear-on-empty via setFeatureField. `kind` is the
// sub-feature key (which also reads as the word in the warning); `fn` keeps the
// public caller name in the diagnostic.
function applySetSubFeatureField(doc: PartDoc, featureId: string, kind: keyof PartFeature, field: string, value: unknown, fn: string): void {
  const sub = findFeature(doc, featureId)?.[kind]
  if (!sub) {
    warn(`${fn}: feature ${featureId} has no ${kind}`)
    return
  }
  setFeatureField(sub as unknown as Record<string, unknown>, field, value)
}

export function applySetExtrudeField(doc: PartDoc, featureId: string, field: keyof ExtrudeFeatureDef, value: unknown): void {
  applySetSubFeatureField(doc, featureId, 'extrude', field, value, 'applySetExtrudeField')
}

export function applySetRevolveField(doc: PartDoc, featureId: string, field: keyof RevolveFeatureDef, value: unknown): void {
  applySetSubFeatureField(doc, featureId, 'revolve', field, value, 'applySetRevolveField')
}

export function applySetFilletField(doc: PartDoc, featureId: string, field: keyof FilletFeatureDef, value: unknown): void {
  applySetSubFeatureField(doc, featureId, 'fillet', field, value, 'applySetFilletField')
}

export function applySetChamferField(doc: PartDoc, featureId: string, field: keyof ChamferFeatureDef, value: unknown): void {
  applySetSubFeatureField(doc, featureId, 'chamfer', field, value, 'applySetChamferField')
}

export function applySetBooleanField(doc: PartDoc, featureId: string, field: keyof BooleanFeatureDef, value: unknown): void {
  applySetSubFeatureField(doc, featureId, 'boolean', field, value, 'applySetBooleanField')
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
  pushFeature(doc, feature)
}

// extrude/revolve/sweep each store their profile (and the sweep its path) as a
// `string | string[]` ref-list. The toggle (add-or-remove-by-value) and the
// remove-by-index logic is identical across all of them; only the sub-feature
// key and the field differ. `fn` keeps the public caller name in the warning so
// it still points at the original entry point.
type RefListKind = 'extrude' | 'revolve' | 'sweep'
type RefListField = 'sketch' | 'path'

function refListSub(doc: PartDoc, featureId: string, kind: RefListKind, fn: string): Record<RefListField, string | string[]> | undefined {
  const sub = findFeature(doc, featureId)?.[kind]
  if (!sub) {
    warn(`${fn}: feature ${featureId} has no ${kind}`)
    return undefined
  }
  return sub as unknown as Record<RefListField, string | string[]>
}

function toggleRef(doc: PartDoc, featureId: string, kind: RefListKind, field: RefListField, query: string, fn: string): void {
  const sub = refListSub(doc, featureId, kind, fn)
  if (!sub) return
  const current = normalizeRefList(sub[field])
  const idx = current.indexOf(query)
  if (idx >= 0) {
    current.splice(idx, 1)
  } else {
    current.push(query)
  }
  sub[field] = current
}

function removeRefAt(doc: PartDoc, featureId: string, kind: RefListKind, field: RefListField, index: number, fn: string): void {
  const sub = refListSub(doc, featureId, kind, fn)
  if (!sub) return
  const current = normalizeRefList(sub[field])
  current.splice(index, 1)
  sub[field] = current
}

function makeAddRefToggle(kind: RefListKind, field: RefListField, fn: string) {
  return (doc: PartDoc, featureId: string, query: string) => toggleRef(doc, featureId, kind, field, query, fn)
}

function makeRemoveRefAt(kind: RefListKind, field: RefListField, fn: string) {
  return (doc: PartDoc, featureId: string, index: number) => removeRefAt(doc, featureId, kind, field, index, fn)
}

export const applyAddExtrudeProfile = makeAddRefToggle('extrude', 'sketch', 'applyAddExtrudeProfile')
export const applyRemoveExtrudeProfile = makeRemoveRefAt('extrude', 'sketch', 'applyRemoveExtrudeProfile')

// ─── Revolve ───

export function applyAddRevolve(
  doc: PartDoc,
  featureId: string,
  label: string | undefined,
  sketchQuery: string,
  angle: number,
): void {
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
  pushFeature(doc, feature)
}

export const applyAddRevolveProfile = makeAddRefToggle('revolve', 'sketch', 'applyAddRevolveProfile')
export const applyRemoveRevolveProfile = makeRemoveRefAt('revolve', 'sketch', 'applyRemoveRevolveProfile')

// ─── Sweep ───

export function applySetSweepField(doc: PartDoc, featureId: string, field: keyof SweepFeatureDef, value: unknown): void {
  applySetSubFeatureField(doc, featureId, 'sweep', field, value, 'applySetSweepField')
}

export function applyAddSweep(
  doc: PartDoc,
  featureId: string,
  label: string | undefined,
  sketchQuery: string,
  pathQuery: string,
): void {
  const feature: PartFeature = {
    id: featureId,
    kind: 'sweep',
    label: label ?? 'Sweep',
    sweep: {
      sketch: sketchQuery ? [sketchQuery] : [],
      path: pathQuery ? [pathQuery] : [],
    },
  }
  pushFeature(doc, feature)
}

export const applyAddSweepProfile = makeAddRefToggle('sweep', 'sketch', 'applyAddSweepProfile')
export const applyRemoveSweepProfile = makeRemoveRefAt('sweep', 'sketch', 'applyRemoveSweepProfile')
export const applyAddSweepPath = makeAddRefToggle('sweep', 'path', 'applyAddSweepPath')
export const applyRemoveSweepPath = makeRemoveRefAt('sweep', 'path', 'applyRemoveSweepPath')

// ─── Import Step ───

export function applyAddImportStep(
  doc: PartDoc,
  featureId: string,
  fileId?: string,
  label?: string,
  fileData?: string,
): void {
  const feature: PartFeature = { id: featureId, kind: 'import_step' }
  // file_data (inline base64, browser-read) is the working path the WASM kernel
  // parses; file_id is the legacy upload handle kept for back-compat.
  if (fileData) feature.file_data = fileData
  if (fileId) feature.file_id = fileId
  if (label) feature.label = label
  pushFeature(doc, feature)
}

// ─── Fillet / Chamfer ───

export function applyAddFillet(
  doc: PartDoc,
  featureId: string,
  label?: string,
): void {
  const feature: PartFeature = {
    id: featureId,
    kind: 'fillet',
    label: label ?? 'Fillet',
    fillet: { edges: [], radius: 1 },
  }
  pushFeature(doc, feature)
}

export function applyAddChamfer(
  doc: PartDoc,
  featureId: string,
  label?: string,
): void {
  const feature: PartFeature = {
    id: featureId,
    kind: 'chamfer',
    label: label ?? 'Chamfer',
    chamfer: { edges: [], distance: 1, kind: 'distance', angle: 45 },
  }
  pushFeature(doc, feature)
}

// fillet and chamfer both carry an identical `edges: string[]` list, so the
// add/remove edge logic is shared across both kinds. `fn` keeps the original
// caller name in the diagnostic so the warning still points at the public entry.
function toggleEdge(doc: PartDoc, featureId: string, edgeQuery: string, kind: 'fillet' | 'chamfer', fn: string): void {
  const sub = findFeature(doc, featureId)?.[kind]
  if (!sub) {
    warn(`${fn}: feature ${featureId} has no ${kind}`)
    return
  }
  const idx = sub.edges.indexOf(edgeQuery)
  if (idx >= 0) {
    sub.edges.splice(idx, 1)
  } else {
    sub.edges.push(edgeQuery)
  }
}

function removeEdgeAt(doc: PartDoc, featureId: string, index: number, kind: 'fillet' | 'chamfer', fn: string): void {
  const sub = findFeature(doc, featureId)?.[kind]
  if (!sub) {
    warn(`${fn}: feature ${featureId} has no ${kind}`)
    return
  }
  sub.edges.splice(index, 1)
}

export function applyAddFilletEdge(doc: PartDoc, featureId: string, edgeQuery: string): void {
  toggleEdge(doc, featureId, edgeQuery, 'fillet', 'applyAddFilletEdge')
}

export function applyRemoveFilletEdge(doc: PartDoc, featureId: string, index: number): void {
  removeEdgeAt(doc, featureId, index, 'fillet', 'applyRemoveFilletEdge')
}

export function applyAddChamferEdge(doc: PartDoc, featureId: string, edgeQuery: string): void {
  toggleEdge(doc, featureId, edgeQuery, 'chamfer', 'applyAddChamferEdge')
}

export function applyRemoveChamferEdge(doc: PartDoc, featureId: string, index: number): void {
  removeEdgeAt(doc, featureId, index, 'chamfer', 'applyRemoveChamferEdge')
}

// ─── Boolean ───

export function applyAddBoolean(doc: PartDoc, featureId: string, label?: string): void {
  const feature: PartFeature = {
    id: featureId,
    kind: 'boolean',
    label: label ?? 'Boolean',
    boolean: { operation: 'union', target: '', tools: [] },
  }
  pushFeature(doc, feature)
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
  const feature: PartFeature = {
    id: featureId,
    kind: 'array',
    label: label ?? 'Array',
    array: {
      mode: 'linear',
      count_x: 2,
      pitch_x: 20,
      operation: 'add',
      include_source: true,
    },
  }
  pushFeature(doc, feature)
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
  const feature: PartFeature = {
    id: featureId,
    kind: 'circular_array',
    label: label ?? 'Circular Array',
    circular_array: {
      count: 4,
      operation: 'add',
      include_source: true,
    },
  }
  pushFeature(doc, feature)
}

export function applySetCircularArrayField(doc: PartDoc, featureId: string, field: keyof CircularArrayFeatureDef, value: unknown): void {
  applySetSubFeatureField(doc, featureId, 'circular_array', field, value, 'applySetCircularArrayField')
}

// ─── Delete Body ───

export function applyAddDeleteBody(
  doc: PartDoc,
  featureId: string,
  bodies: string[] = [],
  label?: string,
): void {
  pushFeature(doc, {
    id: featureId,
    kind: 'delete_body',
    label: label ?? 'Delete Body',
    delete_body: { bodies: [...bodies] },
  })
}

// Picking is a toggle, like the fillet/chamfer edge lists: re-picking a body
// that is already listed drops it again.
export function applyAddDeleteBodyRef(doc: PartDoc, featureId: string, bodyQuery: string): void {
  const sub = findFeature(doc, featureId)?.delete_body
  if (!sub) {
    warn(`applyAddDeleteBodyRef: feature ${featureId} has no delete_body`)
    return
  }
  // A legacy doc reaching a mutation path unmigrated has no `bodies`; heal it
  // so indexOf/splice cannot throw and take the UI down with them.
  sub.bodies ??= []
  const idx = sub.bodies.indexOf(bodyQuery)
  if (idx >= 0) {
    sub.bodies.splice(idx, 1)
  } else {
    sub.bodies.push(bodyQuery)
  }
}

export function applyRemoveDeleteBodyRef(doc: PartDoc, featureId: string, index: number): void {
  const sub = findFeature(doc, featureId)?.delete_body
  if (!sub) {
    warn(`applyRemoveDeleteBodyRef: feature ${featureId} has no delete_body`)
    return
  }
  // Same legacy-doc healing as applyAddDeleteBodyRef.
  sub.bodies ??= []
  sub.bodies.splice(index, 1)
}

export function applyAddHole(doc: PartDoc, featureId: string, label?: string): void {
  pushFeature(doc, {
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
}

// ─── Transform ───

export function applyAddTransform(doc: PartDoc, featureId: string, label?: string): void {
  pushFeature(doc, {
    id: featureId,
    kind: 'transform',
    label: label ?? 'Transform',
    transform: {
      bodies: [],
      operation: 'new',
      translation: [0, 0, 0],
      rotation_angle: 0,
      scale: 1,
    },
  })
}

/** Toggle a body ref in/out of the transform's pick list (re-picking removes). */
export function applyAddTransformBody(doc: PartDoc, featureId: string, bodyQuery: string): void {
  const sub = findFeature(doc, featureId)?.transform
  if (!sub) {
    warn(`applyAddTransformBody: feature ${featureId} has no transform`)
    return
  }
  // A legacy doc reaching a mutation path unmigrated has no `bodies`; heal it
  // so indexOf/splice cannot throw and take the UI down with them.
  sub.bodies ??= []
  const idx = sub.bodies.indexOf(bodyQuery)
  if (idx >= 0) {
    sub.bodies.splice(idx, 1)
  } else {
    sub.bodies.push(bodyQuery)
  }
}

export function applyRemoveTransformBody(doc: PartDoc, featureId: string, index: number): void {
  const sub = findFeature(doc, featureId)?.transform
  if (!sub) {
    warn(`applyRemoveTransformBody: feature ${featureId} has no transform`)
    return
  }
  // Same legacy-doc healing as applyAddTransformBody.
  sub.bodies ??= []
  sub.bodies.splice(index, 1)
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

export function applyAddMirror(doc: PartDoc, featureId: string, label?: string): void {
  pushFeature(doc, {
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

// ─── Variable ───

/** Replace invalid identifier chars with `_`, prefix leading digits, fallback to `var`. */
function sanitizeIdentifier(s: string): string {
  const cleaned = s.replace(/[^A-Za-z0-9_$]/g, '_')
  // All-underscore (or empty) carries no meaningful name: fall back to `var`.
  if (!/[A-Za-z0-9$]/.test(cleaned)) return 'var'
  if (/^[0-9]/.test(cleaned)) return 'var_' + cleaned
  return cleaned
}

/** Return `base` sanitized if unused, else append `_2`, `_3`, ... so variable
 *  labels stay unique (the label IS the downstream reference name). */
function uniqueVariableName(base: string, existingVars: PartFeature[]): string {
  const name = sanitizeIdentifier(base) || 'var'
  const used = new Set(existingVars.map(f => f.label))
  if (!used.has(name)) return name
  let counter = 2
  while (used.has(`${name}_${counter}`)) counter++
  return `${name}_${counter}`
}

export function applyAddVariable(doc: PartDoc, featureId: string, label?: string): void {
  if (!doc.features) doc.features = []
  const existing = doc.features.filter(f => f.kind === 'variable')
  const name = uniqueVariableName(label ?? 'var', existing)
  doc.features.push({
    id: featureId,
    kind: 'variable',
    label: name,
    variable: { expression: '0' },
  })
}

export function applySetVariableField(
  doc: PartDoc, featureId: string, field: keyof VariableFeatureDef, value: unknown,
): void {
  applySetSubFeatureField(doc, featureId, 'variable', field, value, 'applySetVariableField')
}
