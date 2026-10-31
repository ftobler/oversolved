import type { PartDoc, PartFeature, NumberOrExpr, BooleanFeatureDef, TransformFeatureDef, MirrorFeatureDef, SplitFeatureDef, SplitKeep, ExtrudeFeatureDef, RevolveFeatureDef, SweepFeatureDef, FilletFeatureDef, ChamferFeatureDef, ShellFeatureDef, ShellDirection, MoveFaceFeatureDef, ArrayFeatureDef, CircularArrayFeatureDef, HoleFeatureDef, VariableFeatureDef, HelixFeatureDef } from '@/types/cad'
import { warn, findFeature, normalizeRefList } from './helpers'
import { arrayCountProblem } from '@/persistence/docSchema'

/** Append a feature, lazily initializing the features array. */
function pushFeature(doc: PartDoc, feature: PartFeature): void {
  if (!doc.features) doc.features = []
  doc.features.push(feature)
}

/** A feature's sub-definition as the generic setters write it. The schema owns
 *  which keys are real; the appliers only copy values into it, so the bag type
 *  is an index signature rather than a second copy of every field. */
type FieldBag = { [key: string]: unknown }

/** Copy a bulk add's inline fields onto the freshly built default definition.
 *  The setters' clear rule applies: an empty or null value deletes the key, so
 *  `add_array {count_x: ""}` lands the same document as add + setter. An absent
 *  key writes nothing. Arrays are copied so a journaled step and its replay
 *  cannot share one list. */
function mergeInlineFields<T extends object>(target: T, inline: Partial<T>): void {
  for (const [field, value] of Object.entries(inline)) {
    if (value === undefined) continue
    setFeatureField(target, field, Array.isArray(value) ? [...value] : value)
  }
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
// public caller name in the diagnostic. `allowed` is for the kinds whose fields
// are a closed set: a field outside it is refused by name instead of stored as
// a key no reader ever looks at (every other kind's setter is typed only).
function setSubFeatureField(featureId: string, kind: string, sub: Record<string, unknown> | undefined, field: string, value: unknown, fn: string, allowed?: readonly string[]): boolean {
  if (sub === undefined) {
    warn(`${fn}: feature ${featureId} has no ${kind}`)
    return false
  }
  if (allowed !== undefined && !allowed.includes(field)) {
    warn(`${fn}: unknown ${kind} field ${JSON.stringify(field)}`)
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
  if (refuseArrayCount(sub, field, value, 'applySetArrayField')) return
  setFeatureField(sub, field, value)
}

/** Refuse a count the loader would refuse (the cap, the cells cap), so the
 *  document cannot be saved into a state that fails to reopen. A clear (null or
 *  empty) is not a count and passes to the setter. */
function refuseArrayCount(sub: object, field: string, value: unknown, fn: string): boolean {
  if (field !== 'count' && field !== 'count_x' && field !== 'count_y') return false
  if (typeof value !== 'number') return false
  const bag = sub as FieldBag
  const siblingKey = field === 'count_x' ? 'count_y' : field === 'count_y' ? 'count_x' : null
  const sibling = siblingKey !== null && typeof bag[siblingKey] === 'number' ? bag[siblingKey] as number : null
  const problem = arrayCountProblem(field, value, sibling)
  if (problem === null) return false
  warn(`${fn}: refusing ${field}: ${problem}`)
  return true
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

function setFeatureField(obj: object, field: string, value: unknown): void {
  const bag = obj as FieldBag
  if (value === undefined || value === null || value === '') {
    delete bag[field]
    return
  }
  // Strings, selects and ref lists pass through; only a numeric write is
  // boundary-checked, because a NaN stored in YAML poisons every later solve.
  if (typeof value === 'number' && !Number.isFinite(value)) {
    warn(`setFeatureField: refusing non-finite value for ${field}`)
    return
  }
  bag[field] = value
}

// ─── Extrude ───

export function applyAddExtrude(
  doc: PartDoc,
  featureId: string,
  label: string | undefined,
  sketchQuery: string,
  distance: number,
  inline: Pick<ExtrudeFeatureDef, 'direction' | 'operation' | 'merge_target'> & {
    // The setter's applier deletes the key on null or an empty string; the
    // inline add has no key yet, so the same inputs simply write no key.
    termination?: ExtrudeFeatureDef['termination'] | null | ''
    up_to?: string | null
  } = {},
): void {
  // The distance is persisted verbatim into the doc. round(NaN) is still NaN,
  // so a non-finite distance would seed a broken extrude. Refuse before the
  // feature is pushed.
  if (!Number.isFinite(distance)) {
    warn('applyAddExtrude: ignoring non-finite distance', { featureId, distance })
    return
  }
  const termination = inline.termination === null || inline.termination === '' ? undefined : inline.termination
  const upTo = inline.up_to === null || inline.up_to === '' ? undefined : inline.up_to
  const feature: PartFeature = {
    id: featureId,
    kind: 'extrude',
    label: label ?? 'Extrude',
    extrude: {
      sketch: sketchQuery ? [sketchQuery] : [],
      distance,
      direction: inline.direction ?? 'normal',
      // Absent keys stay absent, so a plain add writes the document it always did.
      ...(termination !== undefined && { termination }),
      ...(upTo !== undefined && { up_to: upTo }),
      ...(inline.operation !== undefined && { operation: inline.operation }),
      ...(inline.merge_target !== undefined && { merge_target: inline.merge_target }),
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
  axis?: string,
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
    // The axis rides along in the add so a script needs one call. It is a
    // stored pick, not a default: an absent axis stays absent and the solver
    // reports the missing pick.
    revolve: {
      sketch: sketchQuery ? [sketchQuery] : [],
      angle,
      ...(axis ? { axis } : {}),
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
  edges?: string[],
  radius?: NumberOrExpr,
): void {
  const feature: PartFeature = {
    id: featureId,
    kind: 'fillet',
    label: label ?? 'Fillet',
    // The pick list is copied: the mutation payload may be journaled and replayed
    // from the same array, and a later toggle must not edit that record.
    fillet: { edges: [...(edges ?? [])], radius: radius ?? 1 },
  }
  pushFeature(doc, feature)
}

export function applyAddChamfer(
  doc: PartDoc,
  featureId: string,
  label?: string,
  edges?: string[],
  distance?: NumberOrExpr,
): void {
  const feature: PartFeature = {
    id: featureId,
    kind: 'chamfer',
    label: label ?? 'Chamfer',
    // The pick list is copied for the same journal reason as the fillet's.
    chamfer: { edges: [...(edges ?? [])], distance: distance ?? 1, kind: 'distance', angle: 45 },
  }
  pushFeature(doc, feature)
}

// fillet, chamfer and shell each carry a `string[]` pick list (edges or
// faces), so the add/remove-toggle logic is shared across them by list key.
// `fn` keeps the original caller name in the diagnostic so the warning still
// points at the public entry point.
function listSub(
  doc: PartDoc,
  featureId: string,
  kind: string,
  field: string,
  fn: string,
): string[] | undefined {
  const feature = findFeature(doc, featureId)
  if (feature?.kind === kind) {
    const sub = (feature as unknown as Record<string, Record<string, unknown> | undefined>)[kind]
    const list = sub?.[field]
    if (Array.isArray(list)) return list as string[]
  }
  warn(`${fn}: feature ${featureId} has no ${kind}.${field}`)
  return undefined
}

function toggleListValue(doc: PartDoc, featureId: string, kind: string, field: string, value: string, fn: string): void {
  const list = listSub(doc, featureId, kind, field, fn)
  if (!list) return
  const idx = list.indexOf(value)
  if (idx >= 0) list.splice(idx, 1)
  else list.push(value)
}

function removeListAt(doc: PartDoc, featureId: string, kind: string, field: string, index: number, fn: string): void {
  const list = listSub(doc, featureId, kind, field, fn)
  if (!list) return
  if (!removableIndex(list, index)) return
  list.splice(index, 1)
}

export function applyAddFilletEdge(doc: PartDoc, featureId: string, edgeQuery: string): void {
  toggleListValue(doc, featureId, 'fillet', 'edges', edgeQuery, 'applyAddFilletEdge')
}

export function applyRemoveFilletEdge(doc: PartDoc, featureId: string, index: number): void {
  removeListAt(doc, featureId, 'fillet', 'edges', index, 'applyRemoveFilletEdge')
}

export function applyAddChamferEdge(doc: PartDoc, featureId: string, edgeQuery: string): void {
  toggleListValue(doc, featureId, 'chamfer', 'edges', edgeQuery, 'applyAddChamferEdge')
}

export function applyRemoveChamferEdge(doc: PartDoc, featureId: string, index: number): void {
  removeListAt(doc, featureId, 'chamfer', 'edges', index, 'applyRemoveChamferEdge')
}

// ─── Shell ───

export function applyAddShell(
  doc: PartDoc,
  featureId: string,
  label?: string,
  faces?: string[],
  thickness?: NumberOrExpr,
  direction?: ShellDirection,
): void {
  pushFeature(doc, {
    id: featureId,
    kind: 'shell',
    label: label ?? 'Shell',
    shell: { faces: [...(faces ?? [])], thickness: thickness ?? 1, direction: direction ?? 'inward' },
  })
}

export function applySetShellField(doc: PartDoc, featureId: string, field: keyof ShellFeatureDef, value: unknown): void {
  const feature = findFeature(doc, featureId)
  setSubFeatureField(featureId, 'shell', feature?.kind === 'shell' ? feature.shell : undefined, field, value, 'applySetShellField')
}

export function applyAddShellFace(doc: PartDoc, featureId: string, faceQuery: string): void {
  toggleListValue(doc, featureId, 'shell', 'faces', faceQuery, 'applyAddShellFace')
}

export function applyRemoveShellFace(doc: PartDoc, featureId: string, index: number): void {
  removeListAt(doc, featureId, 'shell', 'faces', index, 'applyRemoveShellFace')
}

// ─── Move face ───

export function applyAddMoveFace(doc: PartDoc, featureId: string, label?: string): void {
  pushFeature(doc, {
    id: featureId,
    kind: 'move_face',
    label: label ?? 'Move Face',
    move_face: { faces: [], distance: 5 },
  })
}

export function applySetMoveFaceField(doc: PartDoc, featureId: string, field: keyof MoveFaceFeatureDef, value: unknown): void {
  const feature = findFeature(doc, featureId)
  setSubFeatureField(featureId, 'move_face', feature?.kind === 'move_face' ? feature.move_face : undefined, field, value, 'applySetMoveFaceField')
}

export function applyAddMoveFaceRef(doc: PartDoc, featureId: string, faceQuery: string): void {
  toggleListValue(doc, featureId, 'move_face', 'faces', faceQuery, 'applyAddMoveFaceRef')
}

export function applyRemoveMoveFaceRef(doc: PartDoc, featureId: string, index: number): void {
  removeListAt(doc, featureId, 'move_face', 'faces', index, 'applyRemoveMoveFaceRef')
}

// ─── Delete Face ───

// `faces` seeds from the selection, as `add_delete_body` takes `bodies`: the
// Delete key folds a whole face selection into one feature.
export function applyAddDeleteFace(
  doc: PartDoc,
  featureId: string,
  label?: string,
  faces: string[] = [],
): void {
  pushFeature(doc, {
    id: featureId,
    kind: 'delete_face',
    label: label ?? 'Delete Face',
    delete_face: { faces: [...faces] },
  })
}

// Picking is a toggle, like the shell's face list: re-picking a listed face
// drops it again.
export function applyAddDeleteFaceRef(doc: PartDoc, featureId: string, faceQuery: string): void {
  toggleListValue(doc, featureId, 'delete_face', 'faces', faceQuery, 'applyAddDeleteFaceRef')
}

export function applyRemoveDeleteFaceRef(doc: PartDoc, featureId: string, index: number): void {
  removeListAt(doc, featureId, 'delete_face', 'faces', index, 'applyRemoveDeleteFaceRef')
}

// ─── Boolean ───

export function applyAddBoolean(
  doc: PartDoc,
  featureId: string,
  label?: string,
  inline: Partial<Pick<BooleanFeatureDef, 'operation' | 'target' | 'tools'>> = {},
): void {
  const feature: PartFeature = {
    id: featureId,
    kind: 'boolean',
    label: label ?? 'Boolean',
    // The tool list is copied for the same journal reason as the fillet's edges.
    boolean: {
      operation: inline.operation ?? 'union',
      target: inline.target ?? '',
      tools: [...(inline.tools ?? [])],
    },
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

export function applyAddArray(
  doc: PartDoc,
  featureId: string,
  label?: string,
  inline: Partial<ArrayFeatureDef> = {},
): void {
  const array: ArrayFeatureDef = {
    mode: 'linear',
    count_x: 2,
    pitch_x: 20,
    operation: 'add',
    include_source: true,
  }
  mergeInlineFields(array, inline)
  // A rectangular mode reads a second direction; the setter seeds it when it
  // switches modes, so an inline switch gets the same defaults. Only an ABSENT
  // value is seeded: a count_y or pitch_y expression is a real authored value.
  if (array.mode === 'rectangular') {
    if (array.count_y === undefined) array.count_y = 2
    if (array.pitch_y === undefined) array.pitch_y = 20
  }
  // The inline counts cross the same limits the setters and the loader hold.
  // A pair is judged together, so each is checked against the other.
  for (const field of ['count_x', 'count_y'] as const) {
    const other = array[field === 'count_x' ? 'count_y' : 'count_x']
    const value = array[field]
    // An expression count is the solver's to resolve; only numbers are known.
    if (typeof value !== 'number') continue
    const problem = arrayCountProblem(field, value, typeof other === 'number' ? other : null)
    if (problem !== null) {
      warn(`applyAddArray: refusing ${field}: ${problem}`)
      return
    }
  }
  pushFeature(doc, { id: featureId, kind: 'array', label: label ?? 'Array', array })
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
    if (sub.count_x === undefined) sub.count_x = 2
    if (sub.pitch_x === undefined) sub.pitch_x = 20
    delete sub.count_y
    delete sub.pitch_y
  } else if (mode === 'rectangular') {
    if (sub.count_x === undefined) sub.count_x = 2
    if (sub.pitch_x === undefined) sub.pitch_x = 20
    if (sub.count_y === undefined) sub.count_y = 2
    if (sub.pitch_y === undefined) sub.pitch_y = 20
  }
}

// ─── Circular Array ───

export function applyAddCircularArray(
  doc: PartDoc,
  featureId: string,
  label?: string,
  inline: Partial<CircularArrayFeatureDef> = {},
): void {
  const circularArray: CircularArrayFeatureDef = {
    count: 4,
    operation: 'add',
    include_source: true,
  }
  mergeInlineFields(circularArray, inline)
  if (typeof circularArray.count === 'number') {
    const problem = arrayCountProblem('count', circularArray.count)
    if (problem !== null) {
      warn(`applyAddCircularArray: refusing count: ${problem}`)
      return
    }
  }
  pushFeature(doc, {
    id: featureId,
    kind: 'circular_array',
    label: label ?? 'Circular Array',
    circular_array: circularArray,
  })
}

export function applySetCircularArrayField(doc: PartDoc, featureId: string, field: keyof CircularArrayFeatureDef, value: unknown): void {
  const feature = findFeature(doc, featureId)
  const sub = feature?.kind === 'circular_array' ? feature.circular_array : undefined
  if (sub !== undefined && refuseArrayCount(sub, field, value, 'applySetCircularArrayField')) return
  setSubFeatureField(featureId, 'circular_array', sub, field, value, 'applySetCircularArrayField')
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

/** Add a hole, optionally already configured. Only defined fields override the
 *  editor's defaults, so a bare add keeps the stored document it always had and
 *  a one-call add can carry the whole spec. */
export function applyAddHole(
  doc: PartDoc,
  featureId: string,
  label?: string,
  fields: Partial<HoleFeatureDef> = {},
): void {
  const hole: HoleFeatureDef = { sketch: '', diameter: 10, depth_mode: 'blind', depth: 20, direction: 'normal' }
  const defined = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined))
  Object.assign(hole, defined)
  // An inline `target: ""` is the boundary's clear for that pick (the same empty
  // string the setter deletes), and an add has no key to delete yet: store no
  // target so the solve drills the body its drill sites sit on.
  if (hole.target === undefined || hole.target === '') delete hole.target
  // A through_all bore is sized by the body it cuts, so the blind default is
  // not part of its contract. Drop it when the caller supplied none instead of
  // persisting a depth the solve then ignores.
  if (hole.depth_mode === 'through_all' && defined.depth === undefined) delete hole.depth
  pushFeature(doc, {
    id: featureId,
    kind: 'hole',
    label: label ?? 'Hole',
    hole,
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

export function applyAddMirror(
  doc: PartDoc,
  featureId: string,
  label?: string,
  inline: Partial<MirrorFeatureDef> = {},
): void {
  const mirror: MirrorFeatureDef = { body: '', plane: '', keep_original: true, merge: true }
  mergeInlineFields(mirror, inline)
  pushFeature(doc, { id: featureId, kind: 'mirror', label: label ?? 'Mirror', mirror })
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

// ─── Split ───

// The side enum the schema and the kernel both accept; an unknown spelling is
// refused by name rather than stored and read back as the above default.
const SPLIT_KEEPS: readonly SplitKeep[] = ['above', 'below', 'both']
const SPLIT_FIELDS: readonly string[] = ['bodies', 'plane', 'keep']

export function applyAddSplit(
  doc: PartDoc,
  featureId: string,
  label?: string,
  bodies?: string[],
  plane?: string,
  keep?: SplitKeep,
): void {
  if (keep !== undefined && !(SPLIT_KEEPS as readonly string[]).includes(keep)) {
    warn(`applyAddSplit: unknown keep value ${JSON.stringify(keep)}; use one of ${SPLIT_KEEPS.map((v) => `"${v}"`).join(', ')}`)
    return
  }
  pushFeature(doc, {
    id: featureId,
    kind: 'split',
    label: label ?? 'Split',
    split: {
      // The pick list is copied: the mutation payload may be journaled and
      // replayed from the same array, and a later toggle must not edit it.
      bodies: [...(bodies ?? [])],
      plane: plane ?? '',
      keep: keep ?? 'above',
    },
  })
}

export function applySetSplitField(
  doc: PartDoc,
  featureId: string,
  field: keyof SplitFeatureDef,
  value: unknown,
): void {
  const feature = findFeature(doc, featureId)
  setSubFeatureField(featureId, 'split', feature?.kind === 'split' ? feature.split : undefined, field, value, 'applySetSplitField', SPLIT_FIELDS)
}

/** Toggle a body ref in/out of the split's pick list (re-picking removes). */
export function applyAddSplitBody(doc: PartDoc, featureId: string, bodyQuery: string): void {
  toggleListValue(doc, featureId, 'split', 'bodies', bodyQuery, 'applyAddSplitBody')
}

export function applyRemoveSplitBody(doc: PartDoc, featureId: string, index: number): void {
  removeListAt(doc, featureId, 'split', 'bodies', index, 'applyRemoveSplitBody')
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

// ─── Helix ───

export function applyAddHelix(
  doc: PartDoc,
  featureId: string,
  label?: string,
  reference?: string,
): void {
  // Every field is seeded with its default so a mode switch never blanks one;
  // `reference` rides in when the caller created the helix from a pick.
  const helix: HelixFeatureDef = {
    radius_mode: 'derived',
    mode: 'pitch_turns',
    pitch: 1,
    turns: 5,
    height: 5,
    helix_angle: 5,
    offset: 0,
    start_angle: 0,
    hand: 'right',
    direction: 'normal',
  }
  if (reference) helix.reference = reference
  pushFeature(doc, { id: featureId, kind: 'helix', label: label ?? 'Helix', helix })
}

export function applySetHelixField(
  doc: PartDoc, featureId: string, field: keyof HelixFeatureDef, value: unknown,
): void {
  const feature = findFeature(doc, featureId)
  setSubFeatureField(featureId, 'helix', feature?.kind === 'helix' ? feature.helix : undefined, field, value, 'applySetHelixField')
}
