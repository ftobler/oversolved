import type { PartDoc, PartFeature, BooleanFeatureDef, TransformFeatureDef, MirrorFeatureDef, ExtrudeFeatureDef, RevolveFeatureDef, SweepFeatureDef, FilletFeatureDef, ChamferFeatureDef, ArrayFeatureDef, CircularArrayFeatureDef, HoleFeatureDef, VariableFeatureDef } from '@/types/cad'
import { warn, findFeature, normalizeRefList } from './helpers'
import { sketchIdsInQuery } from '@/utils/query/consumedSketches'

/**
 * A solid feature consumes the sketch it is built from: once the body exists,
 * the profile wires inside it are clutter, so picking a profile hides the
 * sketch that owns it and the viewport cleans itself up. The feature list stays
 * linear -- "consumed" is a visibility flag, not a tree edge.
 *
 * The auto-hide is a ONE-SHOT per sketch, stamped by `auto_hidden`. A sketch
 * feeding several features would otherwise be yanked off screen again on every
 * later pick, overruling a user who deliberately turned it back on; after the
 * first hide the visibility flag is the user's setting and nothing but the user
 * writes it. The stamp is sticky (never cleared), so re-showing a consumed
 * sketch is permanent.
 *
 * Hides on the add half of a pick only. Un-picking a profile leaves visibility
 * where it is: a pick that silently un-hides would fight whoever turned it off
 * just as hard. The consumer's own editor forces its profiles back on screen
 * while it is open (Part.tsx), so this never hides geometry the user is still
 * picking from.
 */
function hideConsumedSketches(doc: PartDoc, query: string): void {
  const features = doc.features ?? []
  for (const id of sketchIdsInQuery(query, features)) {
    const sketch = features.find(f => f.id === id)
    if (!sketch || sketch.auto_hidden) continue
    sketch.visible = false
    sketch.auto_hidden = true
  }
}

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
  if (!f?.hole) {
    warn(`applySetHoleField: feature ${featureId} has no hole`)
    return
  }
  if (field === 'sketch' && typeof value === 'string') {
    applySetHoleSketch(doc, featureId, value)
    return
  }
  setFeatureField(f.hole as unknown as Record<string, unknown>, field, value)
}

function setFeatureField(obj: Record<string, unknown>, field: string, value: unknown): void {
  if (value === undefined || value === null || value === '') {
    delete obj[field]
    return
  }
  // Strings, selects and ref lists pass through; only a numeric write is
  // boundary-checked, because a NaN stored in YAML poisons every later solve.
  if (typeof value === 'number' && !Number.isFinite(value)) {
    warn(`setFeatureField: refusing non-finite value for ${field}`)
    return
  }
  obj[field] = value
}

// ─── Extrude ───

export function applyAddExtrude(
  doc: PartDoc,
  featureId: string,
  label: string | undefined,
  sketchQuery: string,
  distance: number,
): void {
  // The distance is persisted verbatim into the doc. round(NaN) is still NaN,
  // so a non-finite distance would seed a broken extrude. Refuse before the
  // feature is pushed (and before the profile sketch is hidden), or a refused
  // feature would still hide the sketch it was meant to consume.
  if (!Number.isFinite(distance)) {
    warn('applyAddExtrude: ignoring non-finite distance', { featureId, distance })
    return
  }
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
  hideConsumedSketches(doc, sketchQuery)
}

// extrude/revolve/sweep each store their profile (and the sweep its path) as a
// `string | string[]` ref-list. The toggle (add-or-remove-by-value) and the
// remove-by-index logic is identical across all of them; only the sub-feature
// key and the field differ. `fn` keeps the public caller name in the warning so
// it still points at the original entry point.
// splice(-1, 1) removes the LAST element, so a stale or out-of-range index
// reaching a remove-by-index mutator would silently delete the wrong ref.
// Every remover below gates on this first: out of range is a silent no-op,
// mirroring applyReorderPickField's explicit bounds check. A non-integer index
// is refused for the same reason -- nothing valid produces one, and truncating
// it would still hit an element the caller did not name.
function removableIndex(arr: unknown[], index: number): boolean {
  return Number.isInteger(index) && index >= 0 && index < arr.length
}

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
    hideConsumedSketches(doc, query)
  }
  sub[field] = current
}

function removeRefAt(doc: PartDoc, featureId: string, kind: RefListKind, field: RefListField, index: number, fn: string): void {
  const sub = refListSub(doc, featureId, kind, fn)
  if (!sub) return
  const current = normalizeRefList(sub[field])
  if (!removableIndex(current, index)) return
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
  // The angle is persisted verbatim into the doc. round(NaN) is still NaN, so a
  // non-finite angle would seed a broken revolve. Refuse before the feature is
  // pushed (and before the profile sketch is hidden), or a refused feature would
  // still hide the sketch it was meant to consume.
  if (!Number.isFinite(angle)) {
    warn('applyAddRevolve: ignoring non-finite angle', { featureId, angle })
    return
  }
  const feature: PartFeature = {
    id: featureId,
    kind: 'revolve',
    label: label ?? 'Revolve',
    // Deliberately NO axis default. Pre-filling [0,0,0]/[0,0,1] made every new
    // revolve solve about world Z, so a user who never picked an axis got a
    // plausible-looking wrong solid instead of a red feature asking for the
    // pick. Same contract as circular_array, which also ships axis-less.
    revolve: {
      sketch: sketchQuery ? [sketchQuery] : [],
      angle,
    },
  }
  pushFeature(doc, feature)
  hideConsumedSketches(doc, sketchQuery)
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
  hideConsumedSketches(doc, sketchQuery)
  hideConsumedSketches(doc, pathQuery)
}

export const applyAddSweepProfile = makeAddRefToggle('sweep', 'sketch', 'applyAddSweepProfile')
export const applyRemoveSweepProfile = makeRemoveRefAt('sweep', 'sketch', 'applyRemoveSweepProfile')
export const applyAddSweepPath = makeAddRefToggle('sweep', 'path', 'applyAddSweepPath')
export const applyRemoveSweepPath = makeRemoveRefAt('sweep', 'path', 'applyRemoveSweepPath')

// ─── Import Step ───

export function applyAddImportStep(
  doc: PartDoc,
  featureId: string,
  fileId: string,
  label?: string,
): void {
  const feature: PartFeature = { id: featureId, kind: 'import_step', file_id: fileId }
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
  if (!removableIndex(sub.edges, index)) return
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
  if (!removableIndex(sub.bodies, index)) return
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
  if (!f?.hole) {
    warn(`applySetHoleSketch: feature ${featureId} has no hole`)
    return
  }
  f.hole.sketch = sketch
  hideConsumedSketches(doc, sketch)
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
  if (!removableIndex(sub.bodies, index)) return
  sub.bodies.splice(index, 1)
}

export function applySetTransformField(
  doc: PartDoc,
  featureId: string,
  field: keyof TransformFeatureDef,
  value: unknown,
): void {
  applySetSubFeatureField(doc, featureId, 'transform', field, value, 'applySetTransformField')
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
  applySetSubFeatureField(doc, featureId, 'mirror', field, value, 'applySetMirrorField')
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
  // sanitizeIdentifier already falls back to 'var' itself, so it never yields
  // an empty string here.
  const name = sanitizeIdentifier(base)
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
