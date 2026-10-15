import type { PartDoc, PartFeature, BooleanFeatureDef, TransformFeatureDef, MirrorFeatureDef, ExtrudeFeatureDef, RevolveFeatureDef, SweepFeatureDef, FilletFeatureDef, ChamferFeatureDef, ArrayFeatureDef, CircularArrayFeatureDef, HoleFeatureDef, VariableFeatureDef } from '@/types/cad'
import { warn, findFeature, normalizeRefList } from './helpers'

/** Append a feature, lazily initializing the features array. */
function pushFeature(doc: PartDoc, feature: PartFeature): void {
  if (!doc.features) doc.features = []
  doc.features.push(feature)
}

/** Materialize the plural body list a body mutator indexes. A doc that reached
 *  the mutator unmigrated carries only the singular legacy `body`; seed `bodies`
 *  from it so the user's original pick is not silently dropped on the next save.
 *  Mirrors migrateLegacyBodyPicks, which the parse seams run first. */
function _ensureBodies(sub: { bodies?: string[]; body?: string }): string[] {
  if (!sub.bodies) {
    sub.bodies = typeof sub.body === 'string' && sub.body ? [sub.body] : []
    delete sub.body
  }
  return sub.bodies
}

// ─── Set Feature Field (generic) ───

// Shared body for the `applySet<Kind>Field` mutators that warn when the
// sub-feature is absent and clear-on-empty via setFeatureField. `kind` is the
// sub-feature key (which also reads as the word in the warning); `fn` keeps the
// public caller name in the diagnostic.
function setSubFeatureField(featureId: string, kind: string, sub: Record<string, unknown> | undefined, field: string, value: unknown, fn: string): boolean {
  if (sub === undefined) {
    warn(`${fn}: feature ${featureId} has no ${kind}`)
    return false
  }
  setFeatureField(sub, field, value)
  return true
}

export function applySetExtrudeField(doc: PartDoc, featureId: string, field: keyof ExtrudeFeatureDef, value: unknown): void {
  const feature = findFeature(doc, featureId)
  setSubFeatureField(featureId, 'extrude', feature?.kind === 'extrude' ? feature.extrude : undefined, field, value, 'applySetExtrudeField')
}

export function applySetRevolveField(doc: PartDoc, featureId: string, field: keyof RevolveFeatureDef, value: unknown): void {
  const feature = findFeature(doc, featureId)
  setSubFeatureField(featureId, 'revolve', feature?.kind === 'revolve' ? feature.revolve : undefined, field, value, 'applySetRevolveField')
}

export function applySetFilletField(doc: PartDoc, featureId: string, field: keyof FilletFeatureDef, value: unknown): void {
  const feature = findFeature(doc, featureId)
  setSubFeatureField(featureId, 'fillet', feature?.kind === 'fillet' ? feature.fillet : undefined, field, value, 'applySetFilletField')
}

export function applySetChamferField(doc: PartDoc, featureId: string, field: keyof ChamferFeatureDef, value: unknown): void {
  const feature = findFeature(doc, featureId)
  setSubFeatureField(featureId, 'chamfer', feature?.kind === 'chamfer' ? feature.chamfer : undefined, field, value, 'applySetChamferField')
}

export function applySetBooleanField(doc: PartDoc, featureId: string, field: keyof BooleanFeatureDef, value: unknown): void {
  const feature = findFeature(doc, featureId)
  setSubFeatureField(featureId, 'boolean', feature?.kind === 'boolean' ? feature.boolean : undefined, field, value, 'applySetBooleanField')
}

export function applySetArrayField(doc: PartDoc, featureId: string, field: keyof ArrayFeatureDef, value: unknown): void {
  const feature = findFeature(doc, featureId)
  // `sub` doubles as the kind and the payload check: a hand-edited record can
  // name a kind without carrying its def, and that must warn like a wrong kind
  // rather than throw into the undo path.
  const sub = feature?.kind === 'array' ? feature.array : undefined
  if (!sub) {
    warn(`applySetArrayField: feature ${featureId} has no array`)
    return
  }
  if (field === 'mode' && typeof value === 'string') {
    applySetArrayMode(doc, featureId, value as 'linear' | 'rectangular')
    return
  }
  setFeatureField(sub, field, value)
}

export function applySetHoleField(doc: PartDoc, featureId: string, field: keyof HoleFeatureDef, value: unknown): void {
  const f = findFeature(doc, featureId)
  const sub = f?.kind === 'hole' ? f.hole : undefined
  if (!sub) {
    warn(`applySetHoleField: feature ${featureId} has no hole`)
    return
  }
  if (field === 'sketch' && typeof value === 'string') {
    applySetHoleSketch(doc, featureId, value)
    return
  }
  setFeatureField(sub, field, value)
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
  // feature is pushed.
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

function refListSub(doc: PartDoc, featureId: string, kind: RefListKind, fn: string): Partial<Record<RefListField, string | string[]>> | undefined {
  const feature = findFeature(doc, featureId)
  if (feature?.kind === kind) {
    switch (feature.kind) {
      case 'extrude': return feature.extrude
      case 'revolve': return feature.revolve
      case 'sweep': return feature.sweep
    }
  }
  warn(`${fn}: feature ${featureId} has no ${kind}`)
  return undefined
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
  // pushed.
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
}

export const applyAddRevolveProfile = makeAddRefToggle('revolve', 'sketch', 'applyAddRevolveProfile')
export const applyRemoveRevolveProfile = makeRemoveRefAt('revolve', 'sketch', 'applyRemoveRevolveProfile')

// ─── Sweep ───

export function applySetSweepField(doc: PartDoc, featureId: string, field: keyof SweepFeatureDef, value: unknown): void {
  const feature = findFeature(doc, featureId)
  setSubFeatureField(featureId, 'sweep', feature?.kind === 'sweep' ? feature.sweep : undefined, field, value, 'applySetSweepField')
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
  const sub = edgeSub(doc, featureId, kind, fn)
  if (!sub) return
  const idx = sub.edges.indexOf(edgeQuery)
  if (idx >= 0) {
    sub.edges.splice(idx, 1)
  } else {
    sub.edges.push(edgeQuery)
  }
}

function removeEdgeAt(doc: PartDoc, featureId: string, index: number, kind: 'fillet' | 'chamfer', fn: string): void {
  const sub = edgeSub(doc, featureId, kind, fn)
  if (!sub) return
  if (!removableIndex(sub.edges, index)) return
  sub.edges.splice(index, 1)
}

/** The `edges: string[]` list fillet and chamfer share, or undefined with the
 *  usual warning when the id names a missing or other-kind feature. */
function edgeSub(doc: PartDoc, featureId: string, kind: 'fillet' | 'chamfer', fn: string): { edges: string[] } | undefined {
  const feature = findFeature(doc, featureId)
  if (feature?.kind === 'fillet' && kind === 'fillet') return feature.fillet
  if (feature?.kind === 'chamfer' && kind === 'chamfer') return feature.chamfer
  warn(`${fn}: feature ${featureId} has no ${kind}`)
  return undefined
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
  const sub = feature?.kind === 'boolean' ? feature.boolean : undefined
  if (!sub) {
    warn(`applyAddBooleanTool: feature ${featureId} has no boolean`)
    return
  }
  const idx = sub.tools.indexOf(tool)
  if (idx >= 0) {
    sub.tools.splice(idx, 1)
  } else {
    sub.tools.push(tool)
  }
}

export function applyRemoveBooleanTool(doc: PartDoc, featureId: string, tool: string): void {
  const feature = findFeature(doc, featureId)
  const sub = feature?.kind === 'boolean' ? feature.boolean : undefined
  if (!sub) {
    warn(`applyRemoveBooleanTool: feature ${featureId} has no boolean`)
    return
  }
  sub.tools = sub.tools.filter(t => t !== tool)
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
  const sub = feature?.kind === 'array' ? feature.array : undefined
  if (!sub) {
    warn(`applySetArrayMode: feature ${featureId} has no array`)
    return
  }
  sub.mode = mode
  if (mode === 'linear') {
    if (typeof sub.count_x !== 'number') sub.count_x = 2
    if (typeof sub.pitch_x !== 'number') sub.pitch_x = 20
    delete sub.count_y
    delete sub.pitch_y
  } else if (mode === 'rectangular') {
    if (typeof sub.count_x !== 'number') sub.count_x = 2
    if (typeof sub.pitch_x !== 'number') sub.pitch_x = 20
    if (typeof sub.count_y !== 'number') sub.count_y = 2
    if (typeof sub.pitch_y !== 'number') sub.pitch_y = 20
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
  const feature = findFeature(doc, featureId)
  setSubFeatureField(featureId, 'circular_array', feature?.kind === 'circular_array' ? feature.circular_array : undefined, field, value, 'applySetCircularArrayField')
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
  const feature = findFeature(doc, featureId)
  const sub = feature?.kind === 'delete_body' ? feature.delete_body : undefined
  if (!sub) {
    warn(`applyAddDeleteBodyRef: feature ${featureId} has no delete_body`)
    return
  }
  // A legacy doc reaching a mutation path unmigrated has no `bodies`; seed it
  // from the singular pick so the user's choice survives, and so indexOf/splice
  // cannot throw and take the UI down with them.
  const bodies = _ensureBodies(sub)
  const idx = bodies.indexOf(bodyQuery)
  if (idx >= 0) {
    bodies.splice(idx, 1)
  } else {
    bodies.push(bodyQuery)
  }
}

export function applyRemoveDeleteBodyRef(doc: PartDoc, featureId: string, index: number): void {
  const feature = findFeature(doc, featureId)
  const sub = feature?.kind === 'delete_body' ? feature.delete_body : undefined
  if (!sub) {
    warn(`applyRemoveDeleteBodyRef: feature ${featureId} has no delete_body`)
    return
  }
  // Same legacy-doc healing as applyAddDeleteBodyRef.
  const bodies = _ensureBodies(sub)
  if (!removableIndex(bodies, index)) return
  bodies.splice(index, 1)
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
  const f = findFeature(doc, featureId)
  const sub = f?.kind === 'hole' ? f.hole : undefined
  if (!sub) {
    warn(`applySetHoleSketch: feature ${featureId} has no hole`)
    return
  }
  sub.sketch = sketch
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
  const feature = findFeature(doc, featureId)
  const sub = feature?.kind === 'transform' ? feature.transform : undefined
  if (!sub) {
    warn(`applyAddTransformBody: feature ${featureId} has no transform`)
    return
  }
  // A legacy doc reaching a mutation path unmigrated has no `bodies`; seed it
  // from the singular pick so the user's choice survives, and so indexOf/splice
  // cannot throw and take the UI down with them.
  const bodies = _ensureBodies(sub)
  const idx = bodies.indexOf(bodyQuery)
  if (idx >= 0) {
    bodies.splice(idx, 1)
  } else {
    bodies.push(bodyQuery)
  }
}

export function applyRemoveTransformBody(doc: PartDoc, featureId: string, index: number): void {
  const feature = findFeature(doc, featureId)
  const sub = feature?.kind === 'transform' ? feature.transform : undefined
  if (!sub) {
    warn(`applyRemoveTransformBody: feature ${featureId} has no transform`)
    return
  }
  // Same legacy-doc healing as applyAddTransformBody.
  const bodies = _ensureBodies(sub)
  if (!removableIndex(bodies, index)) return
  bodies.splice(index, 1)
}

export function applySetTransformField(
  doc: PartDoc,
  featureId: string,
  field: keyof TransformFeatureDef,
  value: unknown,
): void {
  const feature = findFeature(doc, featureId)
  setSubFeatureField(featureId, 'transform', feature?.kind === 'transform' ? feature.transform : undefined, field, value, 'applySetTransformField')
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
  const feature = findFeature(doc, featureId)
  setSubFeatureField(featureId, 'mirror', feature?.kind === 'mirror' ? feature.mirror : undefined, field, value, 'applySetMirrorField')
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
  const feature = findFeature(doc, featureId)
  setSubFeatureField(featureId, 'variable', feature?.kind === 'variable' ? feature.variable : undefined, field, value, 'applySetVariableField')
}
