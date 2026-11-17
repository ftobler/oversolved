import type { PartDoc, PartFeature, NumberOrExpr, BooleanFeatureDef, TransformFeatureDef, MirrorFeatureDef, SplitFeatureDef, SplitKeep, ExtrudeFeatureDef, RevolveFeatureDef, SweepFeatureDef, WrapFeatureDef, FilletFeatureDef, ChamferFeatureDef, ShellFeatureDef, ShellDirection, ShellJoin, MoveFaceFeatureDef, LinearPatternDef, CircularPatternDef, CurvePatternDef, InstancePatternDef, LegacyPatternDef, HoleFeatureDef, VariableFeatureDef, HelixFeatureDef } from '@/types/cad'
import { isPatternKind, patternSubOf } from '@/types/cad'
import { warn, findFeature, normalizeRefList, round, MutationRefusal } from './helpers'
import { arrayCountProblem } from '@/persistence/docSchema'
import { skipValue } from '@/utils/core/patternSkip'
import { splitPatternDef } from '@/utils/core/patternSplit'
import { mirrorSubject } from '@/utils/core/mirrorSubject'

/** Append a feature, lazily initializing the features array. */
function pushFeature(doc: PartDoc, feature: PartFeature): void {
  if (!doc.features) doc.features = []
  doc.features.push(feature)
}

/** A feature's sub-definition as the generic setters write it. The schema owns
 *  which keys are real; the appliers only copy values into it, so the bag type
 *  is an index signature rather than a second copy of every field. Shared with
 *  featureAdmin's plane-definition writer, the same copy-a-scalar job. */
export type FieldBag = { [key: string]: unknown }

/** Copy a bulk add's inline fields onto the freshly built default definition.
 *  The setters' clear rule applies: an empty or null value deletes the key, so
 *  `add_pattern {count: ""}` lands the same document as add + setter. An absent
 *  key writes nothing. Arrays are copied so a journaled step and its replay
 *  cannot share one list. */
function mergeInlineFields<T extends object>(target: T, inline: Partial<T>): void {
  for (const [field, value] of Object.entries(inline)) {
    if (value === undefined) continue
    setFeatureField(target, field, Array.isArray(value) ? [...value] : value)
  }
}

/** The stored spelling of one authored feature number, or null when the write is
 *  not storable: a non-finite number, because a NaN stored in YAML fails to load
 *  and poisons every later solve. A magnitude below the precision quantizes to
 *  zero like any other stored number (a move-face distance of 1e-7 IS a zero
 *  move); the fields whose loader rule refuses zero have their own gate beside
 *  this one. Exported for the plane definition writer in featureAdmin, the same
 *  boundary. */
export function storedNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return round(value)
}

// A numeric tuple (a transform translation, an array direction, a plane's
// origin) is authored component by component, so its components cross the same
// boundary. A component quantizing to zero is legal there: an axis may sit at 0.
// Mapping also detaches the stored list from the payload array a journal may
// replay.
function roundNumericComponents(list: unknown[]): unknown[] {
  return list.map(v => typeof v === 'number' ? round(v) : v)
}

/** Round the numbers of a freshly built def; false when one is not a finite
 *  number, so the add is dropped rather than authoring a document the loader
 *  will not reopen. A def is written either through setFeatureField or, for a
 *  bulk add, straight into its literal, and both must spell an authored number
 *  the way the sketch mutators spell their seeds, or one drag stores 0.351324 in
 *  a profile and 0.351324026 in the feature built from it. Integers are exact
 *  under the round; expression strings and string ref lists are not numbers and
 *  pass through. Exported for the plane definition writer in featureAdmin, the
 *  same copy-a-scalar job. */
export function roundNumericFields(def: object, fn: string): boolean {
  const bag = def as FieldBag
  for (const [field, value] of Object.entries(bag)) {
    if (typeof value === 'number') {
      const stored = storedNumber(value)
      if (stored === null) {
        warn(`${fn}: refusing ${field}: ${value} is not a finite number`)
        return false
      }
      bag[field] = stored
    } else if (Array.isArray(value)) {
      bag[field] = roundNumericComponents(value)
    }
  }
  return true
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

/** Materialize the multi-source list a pattern mutation indexes. A legacy row
 *  carries the singular `source_feature`; seed the list from it so a pick edit
 *  does not silently drop the source the pattern still solved with. Shared with
 *  featureAdmin's chip reorder, which needs the same live list. */
export function ensurePatternSources(sub: FieldBag): string[] {
  const current: unknown = sub.source_features
  if (Array.isArray(current)) {
    delete sub.source_feature
    return current as string[]
  }
  const single = typeof current === 'string' ? current : sub.source_feature
  const list: string[] = typeof single === 'string' && single ? [single] : []
  sub.source_features = list
  delete sub.source_feature
  return list
}

// ─── Set Feature Field (generic) ───

// The distance a fresh blind extrude starts with. Shared with the editor schema
// so leaving through_all cannot show one number and store another.
export const DEFAULT_EXTRUDE_DISTANCE = 10

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
  const sub = feature?.kind === 'extrude' ? feature.extrude : undefined
  if (!setSubFeatureField(featureId, 'extrude', sub, field, value, 'applySetExtrudeField')) return
  // The editor hides Taper and Twist once the termination is no longer blind or
  // the direction is symmetric, so the same mutation must clear an angle that
  // would otherwise be invisible and turn the feature red through the kernel's
  // cross-field refusal.
  if (sub === undefined) return
  if (field === 'direction' && value === 'symmetric') {
    delete sub.taper
    delete sub.twist
  }
  if (field === 'termination' && (value === 'up_to' || value === 'up_to_next' || value === 'through_all')) {
    delete sub.taper
    delete sub.twist
  }
  // The emboss toggle is hidden outside the two up-to modes, and the kernel
  // refuses a stored surface mode there; clear it with the termination so a
  // hidden field cannot strand the feature.
  if (field === 'termination' && value !== 'up_to' && value !== 'up_to_next') delete sub.up_to_start
  // A through_all cut stores no distance, so the hidden field is deleted rather
  // than left behind to warn the solve. The loader reads `depth` as the legacy
  // alias of the same field, so both spellings go; leaving the termination
  // settles a legacy `depth` under the current name, then re-seeds the editor
  // default only when neither spelling held a number.
  if (field === 'termination') {
    if (value === 'through_all') {
      delete sub.distance
      delete sub.depth
    } else {
      if (sub.distance === undefined && sub.depth !== undefined) sub.distance = sub.depth
      delete sub.depth
      if (sub.distance === undefined) sub.distance = DEFAULT_EXTRUDE_DISTANCE
    }
  }
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

/** Refuse a count the loader would refuse (the cap, the cells cap), so the
 *  document cannot be saved into a state that fails to reopen. A clear (null or
 *  empty) is not a count and passes to the setter. */
function refusePatternCount(sub: object, field: string, value: unknown, fn: string): boolean {
  if (field !== 'count' && field !== 'count_2') return false
  if (typeof value !== 'number' && typeof value !== 'string') return false
  const bag = sub as FieldBag
  const bagSibling = bag[field === 'count' ? 'count_2' : 'count']
  const sibling = typeof bagSibling === 'number' || typeof bagSibling === 'string' ? bagSibling : null
  const problem = arrayCountProblem(field, value, sibling)
  if (problem !== null) {
    warn(`${fn}: refusing ${field}: ${problem}`)
    return true
  }
  // Raising either side of the pair can cross the cells cap, so the pair is
  // judged whichever field the edit names.
  if (bag.second_direction === true) {
    const x = field === 'count' ? value : bag.count
    const y = field === 'count_2' ? value : bag.count_2
    const pair = typeof x === 'number' || typeof x === 'string'
      ? arrayCountProblem('count_2', y as number | string, x)
      : null
    if (pair !== null) {
      warn(`${fn}: refusing ${field}: ${pair}`)
      return true
    }
  }
  return false
}

/** Refuse a helix angle the loader would refuse. Its parametrisation degenerates
 *  at 0 and 90, so docSchema holds a literal angle to the open interval; a stored
 *  value on either end is a document that cannot reopen. The rounding boundary can
 *  land an authored 89.99999994 exactly on 90, so the angle is judged here the way
 *  a count is judged by refusePatternCount. */
function refuseHelixAngle(field: string, value: unknown, fn: string): boolean {
  if (field !== 'helix_angle' || typeof value !== 'number') return false
  const angle = round(value)
  if (angle > 0 && angle < 90) return false
  warn(`${fn}: refusing ${field}: must be between 0 and 90 degrees, got ${angle}`)
  return true
}

/** Refuse a shell thickness the loader would refuse: its rule is strictly
 *  positive, so a negative value and the zero a sub-micron authored thickness
 *  quantizes to are both a document that cannot reopen. Judged on the rounded
 *  value, unlike a count: the round cannot heal a thickness, it only exposes the
 *  zero the write lands on. */
function refuseShellThickness(field: string, value: unknown, fn: string): boolean {
  if (field !== 'thickness' || typeof value !== 'number') return false
  const thickness = round(value)
  if (thickness > 0) return false
  warn(`${fn}: refusing ${field}: must be positive, got ${thickness}`)
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
  if (typeof value === 'number') {
    // A NaN stored in YAML fails to load, so it is refused here rather than
    // stored; the precision round itself is applied by storedNumber.
    const stored = storedNumber(value)
    if (stored === null) {
      warn(`setFeatureField: refusing ${field}: ${value} is not a finite number`)
      return
    }
    // Every stored feature scalar crosses this one boundary (the setters and the
    // inline adds alike), so it carries the same precision the sketch mutators
    // give their seeds: one authored distance spelled one way in the document.
    bag[field] = stored
    return
  }
  // An expression string is not a number to round and reaches the evaluator
  // untouched; a ref list is a list of strings. A numeric tuple rounds per
  // component.
  bag[field] = Array.isArray(value) && value.some(v => typeof v === 'number')
    ? roundNumericComponents(value)
    : value
}

// ─── Extrude ───

export function applyAddExtrude(
  doc: PartDoc,
  featureId: string,
  label: string | undefined,
  sketchQuery: string,
  distance: number | undefined,
  inline: Pick<ExtrudeFeatureDef, 'direction' | 'operation' | 'merge_target' | 'taper' | 'twist'> & {
    // The setter's applier deletes the key on null or an empty string; the
    // inline add has no key yet, so the same inputs simply write no key.
    termination?: ExtrudeFeatureDef['termination'] | null | ''
    up_to?: string | null
    up_to_offset?: ExtrudeFeatureDef['up_to_offset'] | null
    up_to_start?: ExtrudeFeatureDef['up_to_start'] | null
  } = {},
): void {
  const termination = inline.termination === null || inline.termination === '' ? undefined : inline.termination
  // A through_all cut stores no distance: the caller omits it and no key is
  // written. Every other termination reads the field, so its absence is the
  // boundary's refusal rather than a silent default depth.
  if (distance === undefined) {
    if (termination !== 'through_all') {
      warn('applyAddExtrude: distance is required unless termination is through_all', { featureId })
      return
    }
  } else if (!Number.isFinite(distance)) {
    // The distance crosses the same rounding boundary as every stored feature
    // scalar (setFeatureField's rule; the required field is written straight into
    // the def here). round(NaN) is still NaN, so a non-finite distance would seed
    // a broken extrude. Refuse before the feature is pushed.
    warn('applyAddExtrude: ignoring non-finite distance', { featureId, distance })
    return
  }
  const upTo = inline.up_to === null || inline.up_to === '' ? undefined : inline.up_to
  // A zero offset is the clear, like an empty up_to: the key is only written
  // when the author asked for a moved stop.
  const upToOffset = inline.up_to_offset === null ? undefined : inline.up_to_offset
  const storedUpToOffset = typeof upToOffset === 'number'
    ? (upToOffset === 0 ? undefined : round(upToOffset))
    : (upToOffset === '' ? undefined : upToOffset)
  const upToStart = inline.up_to_start === 'surface' ? 'surface' : undefined
  // An empty taper is the clear, not a zero angle, and a numeric taper crosses
  // the same stored-number rounding boundary as distance.
  const taperRaw = inline.taper as NumberOrExpr | null | undefined
  const taper = taperRaw === null || taperRaw === '' ? undefined : taperRaw
  const storedTaper = typeof taper === 'number' ? round(taper) : taper
  const twistRaw = inline.twist as NumberOrExpr | null | undefined
  const twist = twistRaw === null || twistRaw === '' ? undefined : twistRaw
  const storedTwist = typeof twist === 'number' ? round(twist) : twist
  const feature: PartFeature = {
    id: featureId,
    kind: 'extrude',
    label: label ?? 'Extrude',
    extrude: {
      sketch: sketchQuery ? [sketchQuery] : [],
      ...(distance !== undefined && { distance: round(distance) }),
      direction: inline.direction ?? 'normal',
      // Absent keys stay absent, so a plain add writes the document it always did.
      ...(storedTaper !== undefined && { taper: storedTaper }),
      ...(storedTwist !== undefined && { twist: storedTwist }),
      ...(termination !== undefined && { termination }),
      ...(upTo !== undefined && { up_to: upTo }),
      ...(storedUpToOffset !== undefined && { up_to_offset: storedUpToOffset }),
      ...(upToStart !== undefined && { up_to_start: upToStart }),
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

type RefListKind = 'extrude' | 'revolve' | 'sweep' | 'curve_pattern' | 'instance_pattern'
type RefListField = 'sketch' | 'path' | 'targets'

function refListSub(doc: PartDoc, featureId: string, kind: RefListKind, fn: string): Partial<Record<RefListField, string | string[]>> | undefined {
  const feature = findFeature(doc, featureId)
  if (feature?.kind === kind) {
    switch (feature.kind) {
      case 'extrude': return feature.extrude
      case 'revolve': return feature.revolve
      case 'sweep': return feature.sweep
      case 'curve_pattern': return feature.curve_pattern
      case 'instance_pattern': return feature.instance_pattern
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
  inline: Partial<RevolveFeatureDef> = {},
): void {
  // The angle crosses the same rounding boundary as every stored feature scalar
  // (setFeatureField's rule; the required field is written straight into the def
  // here). round(NaN) is still NaN, so a non-finite angle would seed a broken
  // revolve. Refuse before the feature is pushed.
  if (!Number.isFinite(angle)) {
    warn('applyAddRevolve: ignoring non-finite angle', { featureId, angle })
    return
  }
  // The axis rides along in the add so a script needs one call. It is a
  // stored pick, not a default: an absent axis stays absent and the solver
  // reports the missing pick.
  const revolve: RevolveFeatureDef = {
    sketch: sketchQuery ? [sketchQuery] : [],
    angle: round(angle),
    ...(axis ? { axis } : {}),
  }
  // Direction, operation and merge_target follow the setter's clearing and
  // rounding rules, exactly as add_pattern and add_mirror do.
  mergeInlineFields(revolve, inline)
  pushFeature(doc, { id: featureId, kind: 'revolve', label: label ?? 'Revolve', revolve })
}

export const applyAddRevolveProfile = makeAddRefToggle('revolve', 'sketch', 'applyAddRevolveProfile')
export const applyRemoveRevolveProfile = makeRemoveRefAt('revolve', 'sketch', 'applyRemoveRevolveProfile')

// ─── Wrap ───

/** The height a wrap starts with when the add does not name one. */
export const DEFAULT_WRAP_HEIGHT = 1

/**
 * Add a wrap. The target face rides along in the add so a script needs one
 * call; absent, it stays absent and the solve reports the missing pick instead
 * of guessing a surface.
 */
export function applyAddWrap(
  doc: PartDoc,
  featureId: string,
  label: string | undefined,
  sketchQuery: string,
  inline: Partial<WrapFeatureDef> = {},
): void {
  const wrap: WrapFeatureDef = {
    sketch: sketchQuery ? [sketchQuery] : [],
    height: DEFAULT_WRAP_HEIGHT,
  }
  // Height, target, operation and merge_target follow the setter's clearing and
  // rounding rules, as every other inline add.
  mergeInlineFields(wrap, inline)
  pushFeature(doc, { id: featureId, kind: 'wrap', label: label ?? 'Wrap', wrap })
}

export function applySetWrapField(doc: PartDoc, featureId: string, field: keyof WrapFeatureDef, value: unknown): void {
  const feature = findFeature(doc, featureId)
  setSubFeatureField(featureId, 'wrap', feature?.kind === 'wrap' ? feature.wrap : undefined, field, value, 'applySetWrapField')
}

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
  inline: Partial<SweepFeatureDef> = {},
): void {
  const sweep: SweepFeatureDef = {
    sketch: sketchQuery ? [sketchQuery] : [],
    path: pathQuery ? [pathQuery] : [],
  }
  mergeInlineFields(sweep, inline)
  pushFeature(doc, { id: featureId, kind: 'sweep', label: label ?? 'Sweep', sweep })
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
  scale?: NumberOrExpr,
): void {
  const feature: PartFeature = { id: featureId, kind: 'import_step', file_id: fileId }
  if (label) feature.label = label
  // The import UI stores the document-unit conversion here for an inch document;
  // a script may author any scale it wants.
  if (scale !== undefined) feature.scale = scale
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
  if (!roundNumericFields(feature.fillet, 'applyAddFillet')) return
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
  if (!roundNumericFields(feature.chamfer, 'applyAddChamfer')) return
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
  join?: ShellJoin,
): void {
  const shell: ShellFeatureDef = { faces: [...(faces ?? [])], thickness: thickness ?? 1, direction: direction ?? 'inward' }
  if (join === 'arc') shell.join = 'arc'
  if (!roundNumericFields(shell, 'applyAddShell')) return
  if (refuseShellThickness('thickness', shell.thickness, 'applyAddShell')) return
  pushFeature(doc, {
    id: featureId,
    kind: 'shell',
    label: label ?? 'Shell',
    shell,
  })
}

export function applySetShellField(doc: PartDoc, featureId: string, field: keyof ShellFeatureDef, value: unknown): void {
  const feature = findFeature(doc, featureId)
  const sub = feature?.kind === 'shell' ? feature.shell : undefined
  if (sub !== undefined && refuseShellThickness(field, value, 'applySetShellField')) return
  if (field === 'join' && value === 'sharp' && sub !== undefined) {
    delete sub.join
    return
  }
  setSubFeatureField(featureId, 'shell', sub, field, value, 'applySetShellField')
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
  inline: Partial<BooleanFeatureDef> = {},
): void {
  // The tool list is copied for the same journal reason as the fillet's edges,
  // and clearance crosses the same rounding boundary as every feature scalar.
  const boolean: BooleanFeatureDef = { operation: 'union', target: '', tools: [] }
  mergeInlineFields(boolean, inline)
  pushFeature(doc, { id: featureId, kind: 'boolean', label: label ?? 'Boolean', boolean })
}

export function applyAddBooleanTool(doc: PartDoc, featureId: string, tool: string): void {
  const feature = findFeature(doc, featureId)
  const sub = feature?.kind === 'boolean' ? feature.boolean : undefined
  if (!sub) {
    warn(`applyAddBooleanTool: feature ${featureId} has no boolean`)
    return
  }
  // The union editor shows one "Parts to join" list, so its first pick is the
  // base (target) and every later pick a tool. Subtract and intersect keep the
  // explicit target field and their old tool-only rule.
  const union = sub.operation === undefined || sub.operation === 'union'
  if (union && sub.target === tool) {
    // The join list shows the base as its first chip, so picking it again is the
    // same toggle a listed tool gets: drop it and promote the next body.
    sub.target = sub.tools[0] ?? ''
    sub.tools = sub.tools.slice(1)
    return
  }
  if (union && !sub.target) {
    sub.target = tool
    sub.tools = sub.tools.filter((listed) => listed !== tool)
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
  // Removing the union list's base promotes the next body, so the list keeps its
  // order and the solve keeps a base. The base is not a tool anywhere else.
  const union = sub.operation === undefined || sub.operation === 'union'
  if (union && sub.target === tool) {
    sub.target = sub.tools[0] ?? ''
    sub.tools = sub.tools.slice(1)
  }
}

// ─── Patterns ───

/** Judge a bulk add's inline counts on the AUTHORED value, before the merge
 *  rounds them: a float-noise 4.0000004 judged after the round reads as the
 *  legal 4 the user did not author. A non-finite count is left to setFeatureField's
 *  finiteness gate, which drops the key and lets the seeded default stand. The
 *  setter path judges the raw value through refusePatternCount; an add must not
 *  hand out a different verdict for one input. A count key the kind does not
 *  carry is judged too: the drive refuses an unknown field by name and the def
 *  type has no such key, so this is the backstop that keeps a replayed payload
 *  from landing a count no rule reads. */
function inlineCountProblem(inline: object): { field: 'count' | 'count_2'; reason: string } | null {
  const bag = inline as FieldBag
  // A string is an expression; arrayCountProblem evaluates what it can and
  // lets a variable that is still unknown pass to the solver, like the loader.
  const count = (key: string): number | string | null => {
    const raw = bag[key]
    if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null
    return typeof raw === 'string' ? raw : null
  }
  const countValue = count('count')
  const count2 = count('count_2')
  // A count_2 on a one-direction row is a hidden field the applier drops, so it
  // is judged only when the second direction is actually on.
  if (count2 !== null && (bag.second_direction === true)) {
    const reason = arrayCountProblem('count_2', count2, countValue)
    if (reason !== null) return { field: 'count_2', reason }
  }
  if (countValue !== null) {
    const reason = arrayCountProblem('count', countValue, count2)
    if (reason !== null) return { field: 'count', reason }
  }
  return null
}

/** The retired alias's inline counts: `count`, or the rectangular `count_x` /
 *  `count_y` pair, each judged on the authored value like the old add did. */
function legacyInlineCountProblem(inline: object): { field: 'count' | 'count_x' | 'count_y'; reason: string } | null {
  const bag = inline as FieldBag
  const count = (key: string): number | string | null => {
    const raw = bag[key]
    if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null
    return typeof raw === 'string' ? raw : null
  }
  for (const field of ['count', 'count_x', 'count_y'] as const) {
    const value = count(field)
    if (value === null) continue
    const reason = arrayCountProblem('count', value)
    if (reason !== null) return { field, reason }
  }
  const x = count('count_x')
  const y = count('count_y')
  if (x !== null && y !== null) {
    const reason = arrayCountProblem('count_2', y, x)
    if (reason !== null) return { field: 'count_y', reason }
  }
  return null
}

/** The retired single-kind field list, still needed for the one-release
 *  `add_pattern` alias so a replayed payload cannot land a key nothing reads. */
const LEGACY_PATTERN_FIELDS: readonly string[] = [
  'subject', 'source_body', 'operation', 'source_features', 'source_feature', 'target_body',
  'mode', 'count', 'centered', 'skip', 'pitch', 'direction', 'direction_query', 'invert',
  'count_x', 'count_y', 'centered_x', 'centered_y', 'pitch_x', 'pitch_y',
  'direction_x', 'direction_x_query', 'invert_x', 'direction_y', 'direction_y_query', 'invert_y',
  'step_angle', 'axis', 'axis_origin', 'axis_direction', 'invert_axis',
]

const PATTERN_SOURCE_FIELDS: readonly string[] = [
  'subject', 'source_body', 'operation', 'source_features', 'source_feature', 'target_body',
]

const LINEAR_PATTERN_FIELDS: readonly string[] = [
  ...PATTERN_SOURCE_FIELDS,
  'count', 'centered', 'skip', 'pitch', 'direction', 'direction_query', 'invert', 'direction_mode',
  'second_direction', 'count_2', 'centered_2', 'pitch_2',
  'direction_2', 'direction_2_query', 'invert_2', 'direction_2_mode',
]

const CIRCULAR_PATTERN_FIELDS: readonly string[] = [
  ...PATTERN_SOURCE_FIELDS,
  'count', 'centered', 'skip', 'angle', 'equal_spacing',
  'axis', 'axis_origin', 'axis_direction', 'invert_axis',
]

const CURVE_PATTERN_FIELDS: readonly string[] = [
  ...PATTERN_SOURCE_FIELDS,
  'count', 'skip', 'path', 'spacing', 'distance', 'reverse', 'orientation', 'normal_ref',
]

const INSTANCE_PATTERN_FIELDS: readonly string[] = [
  ...PATTERN_SOURCE_FIELDS,
  'sketch', 'targets', 'reference', 'orientation', 'reverse_normal', 'skip',
]

/** The stored skip list from either accepted spelling, or null when the value
 *  is not one. The drive parses text before it gets here; a replayed journal
 *  payload may still carry the text the user typed. */
function patternSkip(value: unknown): (number | [number, number])[] | null {
  const parsed = skipValue(value)
  return 'error' in parsed ? null : parsed.skip.map((entry) => (
    typeof entry === 'number' ? entry : [entry[0], entry[1]]
  ))
}

/** A circular pattern has no grid, so a `i:j` cell names nothing there. */
function circularSkip(value: unknown): number[] | null {
  const parsed = patternSkip(value)
  if (parsed === null || parsed.some((entry) => Array.isArray(entry))) return null
  return parsed as number[]
}

/** Like the circular kind, a curve pattern has one dimension: a grid cell names
 *  nothing along a path. */
const curveSkip = circularSkip

/** The materialized source list a setter writes, from either accepted spelling
 *  (a list, or the legacy one-element scalar). */
function sourceList(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((ref): ref is string => typeof ref === 'string')
  return typeof raw === 'string' && raw !== '' ? [raw] : []
}

/** Seed the values a linear add reads so a bare add is already a solvable
 *  feature. Only an ABSENT value is seeded: an authored expression or a count
 *  the user already set is a real value, and count 1 is a legal quiet no-op now,
 *  not a value to raise. */
function seedLinearPattern(sub: FieldBag, cleared: ReadonlySet<string> = new Set()): void {
  const seed = (key: string, value: number): void => {
    if (!cleared.has(key) && sub[key] === undefined) sub[key] = value
  }
  seed('count', 2)
  seed('pitch', 20)
  if (sub.second_direction === true) {
    seed('count_2', 2)
    seed('pitch_2', 20)
    return
  }
  // With the second direction off, the grid fields are values the solver never
  // reads; the checkbox hides them, so they go rather than linger invisibly.
  for (const key of ['count_2', 'centered_2', 'pitch_2', 'direction_2', 'direction_2_query', 'invert_2']) {
    delete sub[key]
  }
}

/** Seed the values a circular add reads. The angle and equal spacing keep the
 *  kernel's own defaults (a full, evenly spaced turn), so a bare add stores no
 *  field whose absence already means the same thing. */
function seedCircularPattern(sub: FieldBag, cleared: ReadonlySet<string> = new Set()): void {
  if (!cleared.has('count') && sub.count === undefined) sub.count = 4
}

/** Seed the values a curve add reads. Equal spacing and the tangent orientation
 *  keep the kernel's defaults, so only the count and (in distance mode) the
 *  distance are stored; a distance the mode does not read would be a value the
 *  solve ignores. */
function seedCurvePattern(sub: FieldBag, cleared: ReadonlySet<string> = new Set()): void {
  if (!cleared.has('count') && sub.count === undefined) sub.count = 3
  if (sub.spacing === 'distance' && !cleared.has('distance') && sub.distance === undefined) sub.distance = 20
}

/** The legacy fields an `add_pattern` alias call may carry, with the usual clear
 *  rule and the skip text parsed. Null means the payload was refused (a skip
 *  list that is not a list of instance numbers). */
function legacyPatternPayload(inline: object): FieldBag | null {
  const accepted = Object.fromEntries(
    Object.entries(inline).filter(([field]) => LEGACY_PATTERN_FIELDS.includes(field)),
  ) as FieldBag
  // The legacy single source lands in the multi-source list the kernel reads.
  // When both are sent the list wins, so an old alias cannot silently override
  // the authored set. A string list is the same legacy spelling a replay may
  // carry.
  if (typeof accepted.source_features === 'string') {
    accepted.source_features = accepted.source_features === '' ? [] : [accepted.source_features]
  }
  if (!Array.isArray(accepted.source_features) && typeof accepted.source_feature === 'string') {
    accepted.source_features = accepted.source_feature === '' ? [] : [accepted.source_feature]
  }
  delete accepted.source_feature
  if (accepted.skip !== undefined && accepted.skip !== null && (accepted.skip as unknown) !== '') {
    const skip = patternSkip(accepted.skip)
    if (skip === null) {
      warn('applyAddPattern: refusing skip: the list is not a set of whole instance numbers')
      return null
    }
    accepted.skip = skip
  }
  return accepted
}

export function applyAddLinearPattern(
  doc: PartDoc,
  featureId: string,
  label?: string,
  inline: Partial<LinearPatternDef> = {},
): void {
  const pattern: FieldBag = { subject: 'body', operation: 'add' }
  const accepted = Object.fromEntries(
    Object.entries(inline).filter(([field]) => LINEAR_PATTERN_FIELDS.includes(field)),
  ) as FieldBag
  if (typeof accepted.source_features === 'string') {
    accepted.source_features = accepted.source_features === '' ? [] : [accepted.source_features]
  }
  if (!Array.isArray(accepted.source_features) && typeof accepted.source_feature === 'string') {
    accepted.source_features = accepted.source_feature === '' ? [] : [accepted.source_feature]
  }
  delete accepted.source_feature
  if (accepted.skip !== undefined && accepted.skip !== null && (accepted.skip as unknown) !== '') {
    const skip = patternSkip(accepted.skip)
    if (skip === null) {
      warn('applyAddLinearPattern: refusing skip: the list is not a set of whole instance numbers')
      return
    }
    accepted.skip = skip
  }
  const problem = inlineCountProblem(accepted)
  if (problem !== null) {
    warn(`applyAddLinearPattern: refusing ${problem.field}: ${problem.reason}`)
    return
  }
  mergeInlineFields(pattern, accepted as Partial<FieldBag>)
  // A feature subject inherits the source's own operation; keeping a body
  // operation on it would advertise a field the kernel ignores.
  if (pattern.subject === 'feature') delete pattern.operation
  else if (pattern.operation === undefined) pattern.operation = 'add'
  // An explicit empty value cleared the key on purpose; seeding it back would
  // silently override the author's clear with the default.
  const cleared = new Set(
    Object.entries(accepted)
      .filter(([, value]) => value === undefined || value === null || value === '')
      .map(([key]) => key),
  )
  seedLinearPattern(pattern, cleared)
  pushFeature(doc, {
    id: featureId,
    kind: 'linear_pattern',
    label: label ?? 'Linear Pattern',
    linear_pattern: pattern as LinearPatternDef,
  })
}

export function applyAddCircularPattern(
  doc: PartDoc,
  featureId: string,
  label?: string,
  inline: Partial<CircularPatternDef> = {},
): void {
  const pattern: FieldBag = { subject: 'body', operation: 'add' }
  const accepted = Object.fromEntries(
    Object.entries(inline).filter(([field]) => CIRCULAR_PATTERN_FIELDS.includes(field)),
  ) as FieldBag
  if (typeof accepted.source_features === 'string') {
    accepted.source_features = accepted.source_features === '' ? [] : [accepted.source_features]
  }
  if (!Array.isArray(accepted.source_features) && typeof accepted.source_feature === 'string') {
    accepted.source_features = accepted.source_feature === '' ? [] : [accepted.source_feature]
  }
  delete accepted.source_feature
  if (accepted.skip !== undefined && accepted.skip !== null && (accepted.skip as unknown) !== '') {
    const skip = circularSkip(accepted.skip)
    if (skip === null) {
      warn('applyAddCircularPattern: refusing skip: a circular pattern skips whole instance numbers only')
      return
    }
    accepted.skip = skip
  }
  const problem = inlineCountProblem(accepted)
  if (problem !== null) {
    warn(`applyAddCircularPattern: refusing ${problem.field}: ${problem.reason}`)
    return
  }
  mergeInlineFields(pattern, accepted as Partial<FieldBag>)
  if (pattern.subject === 'feature') delete pattern.operation
  else if (pattern.operation === undefined) pattern.operation = 'add'
  const cleared = new Set(
    Object.entries(accepted)
      .filter(([, value]) => value === undefined || value === null || value === '')
      .map(([key]) => key),
  )
  seedCircularPattern(pattern, cleared)
  pushFeature(doc, {
    id: featureId,
    kind: 'circular_pattern',
    label: label ?? 'Circular Pattern',
    circular_pattern: pattern as CircularPatternDef,
  })
}

export function applyAddCurvePattern(
  doc: PartDoc,
  featureId: string,
  label?: string,
  pathQuery = '',
  inline: Partial<CurvePatternDef> = {},
): void {
  const pattern: FieldBag = { subject: 'body', operation: 'add' }
  const accepted = Object.fromEntries(
    Object.entries(inline).filter(([field]) => CURVE_PATTERN_FIELDS.includes(field)),
  ) as FieldBag
  if (typeof accepted.source_features === 'string') {
    accepted.source_features = accepted.source_features === '' ? [] : [accepted.source_features]
  }
  if (!Array.isArray(accepted.source_features) && typeof accepted.source_feature === 'string') {
    accepted.source_features = accepted.source_feature === '' ? [] : [accepted.source_feature]
  }
  delete accepted.source_feature
  if (accepted.skip !== undefined && accepted.skip !== null && (accepted.skip as unknown) !== '') {
    const skip = curveSkip(accepted.skip)
    if (skip === null) {
      warn('applyAddCurvePattern: refusing skip: a curve pattern skips whole instance numbers only')
      return
    }
    accepted.skip = skip
  }
  const problem = inlineCountProblem(accepted)
  if (problem !== null) {
    warn(`applyAddCurvePattern: refusing ${problem.field}: ${problem.reason}`)
    return
  }
  mergeInlineFields(pattern, accepted as Partial<FieldBag>)
  // The path rides in the add the way the sweep's does, and an authored `path`
  // inline lands after it so a caller can send either spelling.
  const path = pathQuery ? [pathQuery] : []
  if (Array.isArray(pattern.path)) {
    for (const ref of pattern.path) if (typeof ref === 'string' && ref !== '' && !path.includes(ref)) path.push(ref)
  }
  pattern.path = path
  if (pattern.subject === 'feature') delete pattern.operation
  else if (pattern.operation === undefined) pattern.operation = 'add'
  const cleared = new Set(
    Object.entries(accepted)
      .filter(([, value]) => value === undefined || value === null || value === '')
      .map(([key]) => key),
  )
  seedCurvePattern(pattern, cleared)
  pushFeature(doc, {
    id: featureId,
    kind: 'curve_pattern',
    label: label ?? 'Curve Pattern',
    curve_pattern: pattern as CurvePatternDef,
  })
}

export function applySetCurvePatternField(doc: PartDoc, featureId: string, field: keyof CurvePatternDef, value: unknown): void {
  const feature = findFeature(doc, featureId)
  setSubFeatureField(featureId, 'curve_pattern', feature?.kind === 'curve_pattern' ? feature.curve_pattern : undefined, field, value, 'applySetCurvePatternField')
}

export const applyAddCurvePatternPath = makeAddRefToggle('curve_pattern', 'path', 'applyAddCurvePatternPath')
export const applyRemoveCurvePatternPath = makeRemoveRefAt('curve_pattern', 'path', 'applyRemoveCurvePatternPath')

/** Both target forms at once is never a document the app writes; a replay
 *  carrying it is refused rather than solved as one arbitrary form. */
function instanceTargetFormProblem(sub: Record<string, unknown>): string | null {
  const sketch = typeof sub.sketch === 'string' && sub.sketch !== ''
  const targets = Array.isArray(sub.targets) && sub.targets.length > 0
  return sketch && targets ? 'sketch and targets cannot both be set; keep one target form' : null
}

export function applyAddInstancePattern(
  doc: PartDoc,
  featureId: string,
  label?: string,
  inline: Partial<InstancePatternDef> = {},
): void {
  const pattern: FieldBag = { subject: 'body', operation: 'add' }
  const accepted = Object.fromEntries(
    Object.entries(inline).filter(([field]) => INSTANCE_PATTERN_FIELDS.includes(field)),
  ) as FieldBag
  if (typeof accepted.source_features === 'string') {
    accepted.source_features = accepted.source_features === '' ? [] : [accepted.source_features]
  }
  if (!Array.isArray(accepted.source_features) && typeof accepted.source_feature === 'string') {
    accepted.source_features = accepted.source_feature === '' ? [] : [accepted.source_feature]
  }
  delete accepted.source_feature
  if (accepted.skip !== undefined && accepted.skip !== null && (accepted.skip as unknown) !== '') {
    const skip = circularSkip(accepted.skip)
    if (skip === null) {
      warn('applyAddInstancePattern: refusing skip: an instance pattern skips whole instance numbers only')
      return
    }
    accepted.skip = skip
  }
  mergeInlineFields(pattern, accepted as Partial<FieldBag>)
  const form = instanceTargetFormProblem(pattern)
  if (form !== null) {
    warn(`applyAddInstancePattern: refusing ${form}`)
    return
  }
  if (pattern.subject === 'feature') delete pattern.operation
  else if (pattern.operation === undefined) pattern.operation = 'add'
  pushFeature(doc, {
    id: featureId,
    kind: 'instance_pattern',
    label: label ?? 'Instance Pattern',
    instance_pattern: pattern as InstancePatternDef,
  })
}

export function applySetInstancePatternField(
  doc: PartDoc,
  featureId: string,
  field: keyof InstancePatternDef,
  value: unknown,
): void {
  const feature = findFeature(doc, featureId)
  const sub = feature?.kind === 'instance_pattern' ? feature.instance_pattern as FieldBag : undefined
  if (sub === undefined) {
    warn(`applySetInstancePatternField: feature ${featureId} has no instance_pattern`)
    return
  }
  // Switching forms is two writes in the UI; a single write that would leave
  // both set is refused rather than stored as a document the kernel refuses.
  const next: FieldBag = { ...sub, [field]: value }
  const form = instanceTargetFormProblem(next)
  if (form !== null) {
    warn(`applySetInstancePatternField: refusing ${form}`)
    return
  }
  setSubFeatureField(featureId, 'instance_pattern', sub, field, value, 'applySetInstancePatternField', INSTANCE_PATTERN_FIELDS)
}

export const applyAddInstancePatternTarget = makeAddRefToggle(
  'instance_pattern', 'targets', 'applyAddInstancePatternTarget',
)
export const applyRemoveInstancePatternTarget = makeRemoveRefAt(
  'instance_pattern', 'targets', 'applyRemoveInstancePatternTarget',
)

/** The one-release `add_pattern` alias: build the legacy payload the old add
 *  built, then run it through the loader's own split, so the aliased document
 *  is byte-for-byte the row a migrated file loads as. */
export function applyAddPattern(
  doc: PartDoc,
  featureId: string,
  label?: string,
  inline: Partial<LegacyPatternDef> = {},
): void {
  const accepted = legacyPatternPayload(inline)
  if (accepted === null) return
  const problem = legacyInlineCountProblem(accepted)
  if (problem !== null) {
    warn(`applyAddPattern: refusing ${problem.field}: ${problem.reason}`)
    return
  }
  const legacy: FieldBag = { subject: 'body', mode: 'linear', operation: 'add' }
  // The setters' clear and finiteness rules apply here too: an empty value
  // deletes the key, a non-finite number is dropped, a stored number is rounded.
  mergeInlineFields(legacy, accepted as Partial<FieldBag>)
  // The old add seeded the mode's required values; seed before the split so the
  // alias cannot land a linear row with no pitch.
  const cleared = new Set(
    Object.entries(accepted)
      .filter(([, value]) => value === undefined || value === null || value === '')
      .map(([key]) => key),
  )
  if (legacy.mode === 'circular') {
    if (!cleared.has('count') && legacy.count === undefined) legacy.count = 4
  } else if (legacy.mode === 'rectangular') {
    if (!cleared.has('count_x') && legacy.count_x === undefined) legacy.count_x = 2
    if (!cleared.has('pitch_x') && legacy.pitch_x === undefined) legacy.pitch_x = 20
    if (!cleared.has('count_y') && legacy.count_y === undefined) legacy.count_y = 2
    if (!cleared.has('pitch_y') && legacy.pitch_y === undefined) legacy.pitch_y = 20
  } else {
    if (!cleared.has('count') && legacy.count === undefined) legacy.count = 2
    if (!cleared.has('pitch') && legacy.pitch === undefined) legacy.pitch = 20
  }
  const { kind, def } = splitPatternDef(legacy)
  if (def.subject === 'feature') delete (def as FieldBag).operation
  else if (def.operation === undefined) def.operation = 'add'
  if (kind === 'linear_pattern') {
    pushFeature(doc, { id: featureId, kind, label: label ?? 'Pattern', linear_pattern: def as LinearPatternDef })
  } else {
    pushFeature(doc, { id: featureId, kind, label: label ?? 'Pattern', circular_pattern: def as CircularPatternDef })
  }
}

export function applySetLinearPatternField(
  doc: PartDoc,
  featureId: string,
  field: keyof LinearPatternDef,
  value: unknown,
): void {
  const feature = findFeature(doc, featureId)
  const sub = feature?.kind === 'linear_pattern' ? (feature.linear_pattern as FieldBag) : undefined
  if (!sub) {
    warn(`applySetLinearPatternField: feature ${featureId} has no linear_pattern`)
    return
  }
  if (refusePatternCount(sub, field, value, 'applySetLinearPatternField')) return
  const targetField = field === 'source_feature' ? 'source_features' : field
  const targetValue = targetField === 'source_features' ? sourceList(value) : value
  let toStore: unknown = targetValue
  if (targetField === 'skip' && value !== null && value !== undefined && value !== '') {
    const skip = patternSkip(value)
    if (skip === null) {
      warn(`applySetLinearPatternField: refusing skip ${JSON.stringify(value)}: the list is not a set of whole instance numbers`)
      return
    }
    toStore = skip
  }
  if (!setSubFeatureField(featureId, 'linear_pattern', sub, targetField, toStore, 'applySetLinearPatternField', LINEAR_PATTERN_FIELDS)) return
  delete sub.source_feature
  delete sub.include_source
  if (field === 'second_direction') seedLinearPattern(sub)
  if (field === 'subject' && value === 'feature') delete sub.operation
}

export function applySetCircularPatternField(
  doc: PartDoc,
  featureId: string,
  field: keyof CircularPatternDef,
  value: unknown,
): void {
  const feature = findFeature(doc, featureId)
  const sub = feature?.kind === 'circular_pattern' ? (feature.circular_pattern as FieldBag) : undefined
  if (!sub) {
    warn(`applySetCircularPatternField: feature ${featureId} has no circular_pattern`)
    return
  }
  if (refusePatternCount(sub, field, value, 'applySetCircularPatternField')) return
  const targetField = field === 'source_feature' ? 'source_features' : field
  const targetValue = targetField === 'source_features' ? sourceList(value) : value
  let toStore: unknown = targetValue
  if (targetField === 'skip' && value !== null && value !== undefined && value !== '') {
    const skip = circularSkip(value)
    if (skip === null) {
      warn(`applySetCircularPatternField: refusing skip ${JSON.stringify(value)}: a circular pattern skips whole instance numbers only`)
      return
    }
    toStore = skip
  }
  if (!setSubFeatureField(featureId, 'circular_pattern', sub, targetField, toStore, 'applySetCircularPatternField', CIRCULAR_PATTERN_FIELDS)) return
  delete sub.source_feature
  if (field === 'subject' && value === 'feature') delete sub.operation
}

/** The sub-definition a source chip edits, or the refusal that tells the user
 *  why the click cannot land. A chip on a row the document cannot resolve used
 *  to warn and return, which reads as a dead control in the editor and as an ok
 *  no-op in a drive reply; a named refusal is the project's answer to both. */
function patternSourceSub(featureId: string, feature: PartFeature | undefined, fn: string): FieldBag {
  const sub = patternSubOf(feature)
  if (sub !== null) return sub
  const what = feature === undefined
    ? `no feature '${featureId}'`
    : isPatternKind(feature.kind)
      ? `feature '${featureId}' has no ${feature.kind} definition`
      : `feature '${featureId}' is not a pattern (its kind is ${feature.kind})`
  throw new MutationRefusal(`${fn}: ${what}, so there is no source list to edit`)
}

/** Add a feature to a pattern's sources, toggling like every other multi pick:
 *  re-picking a source already in the list drops it again. */
export function applyAddPatternSource(doc: PartDoc, featureId: string, sourceFeature: string): void {
  const sub = patternSourceSub(featureId, findFeature(doc, featureId), 'add_pattern_source')
  const sources = ensurePatternSources(sub)
  const index = sources.indexOf(sourceFeature)
  if (index >= 0) sources.splice(index, 1)
  else sources.push(sourceFeature)
}

export function applyRemovePatternSource(doc: PartDoc, featureId: string, index: number): void {
  const sub = patternSourceSub(featureId, findFeature(doc, featureId), 'remove_pattern_source')
  const sources = ensurePatternSources(sub)
  if (!removableIndex(sources, index)) return
  sources.splice(index, 1)
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
    label: label ?? 'Delete Part',
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
  // The inline fields land straight on the def and skip setFeatureField, so the
  // same rounding boundary applies here.
  if (!roundNumericFields(hole, 'applyAddHole')) return
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

export function applyAddTransform(
  doc: PartDoc,
  featureId: string,
  label?: string,
  inline: Partial<TransformFeatureDef> = {},
): void {
  const transform: TransformFeatureDef = {
    bodies: [],
    operation: 'new',
    translation: [0, 0, 0],
    rotation_angle: 0,
    scale: 1,
  }
  // Every setter field is accepted inline, so one call replaces the add plus
  // one setter per field; bodies is copied like any other inline array.
  mergeInlineFields(transform, inline)
  // The default axis spelling seeds rotation_angle: 0, which the kernel refuses
  // beside an Euler triple. When the caller chose Euler inline and gave no
  // angle, that seeded zero is not authored intent, so it must not make the
  // freshly added feature ambiguous.
  const eulerSupplied = inline.rotation_euler !== undefined && inline.rotation_euler !== null
  const angleSupplied = inline.rotation_angle !== undefined && inline.rotation_angle !== null
  if (eulerSupplied && !angleSupplied) delete transform.rotation_angle
  pushFeature(doc, { id: featureId, kind: 'transform', label: label ?? 'Transform', transform })
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

/** The mirror's authored fields. `operation` is the source's, so a mirror has
 *  none; the shared pattern source keys do not all apply. */
const MIRROR_FIELDS: readonly string[] = [
  'subject', 'body', 'source_features', 'target_body', 'plane', 'keep_original', 'merge',
]

export function applyAddMirror(
  doc: PartDoc,
  featureId: string,
  label?: string,
  inline: Partial<MirrorFeatureDef> = {},
): void {
  const accepted = Object.fromEntries(
    Object.entries(inline).filter(([field]) => MIRROR_FIELDS.includes(field)),
  ) as FieldBag
  if (typeof accepted.source_features === 'string') {
    accepted.source_features = accepted.source_features === '' ? [] : [accepted.source_features]
  }
  const featureMirror = mirrorSubject(accepted) === 'feature'
  if (featureMirror) {
    // The whole-body flags have no meaning here; a direct replay may still
    // carry them, so they are dropped rather than stored for the kernel to
    // refuse. A body pick is kept so switching back restores it.
    delete accepted.keep_original
    delete accepted.merge
  }
  const mirror: FieldBag = featureMirror
    ? { subject: 'feature', plane: '' }
    : { subject: 'body', body: '', plane: '', keep_original: true, merge: true }
  mergeInlineFields(mirror, accepted)
  pushFeature(doc, { id: featureId, kind: 'mirror', label: label ?? 'Mirror', mirror: mirror as MirrorFeatureDef })
}

export function applySetMirrorField(
  doc: PartDoc,
  featureId: string,
  field: keyof MirrorFeatureDef,
  value: unknown,
): void {
  const feature = findFeature(doc, featureId)
  const sub = feature?.kind === 'mirror' ? (feature.mirror as FieldBag) : undefined
  if (sub === undefined) {
    warn(`applySetMirrorField: feature ${featureId} has no mirror`)
    return
  }
  // A feature mirror reapplies the source's own add or cut inside the same
  // body. The whole-body flags would be invisible in the editor and refused by
  // the kernel, so they are refused here by name instead of stored.
  if ((field === 'keep_original' || field === 'merge') && mirrorSubject(sub) === 'feature') {
    warn(
      `applySetMirrorField: refusing ${field} on feature mirror ${featureId}; ` +
        "a feature mirror reapplies the source's own add or cut, so the original always stays",
    )
    return
  }
  const toStore = field === 'source_features' ? sourceList(value) : value
  if (!setSubFeatureField(featureId, 'mirror', sub, field, toStore, 'applySetMirrorField', MIRROR_FIELDS)) return
  // Switching the subject owns the fields that only one subject reads: the
  // body flags go, the body pick stays (switching back restores it) and a
  // legacy singular source folds into the list.
  if (field === 'subject' && value === 'feature') {
    delete sub.keep_original
    delete sub.merge
  }
  if (field === 'source_features') delete sub.source_feature
}

/** The mirror's own sub-definition, or null. Probed at runtime because a loaded
 *  row can name the kind without carrying its payload. */
function mirrorSubOf(feature: PartFeature | undefined): FieldBag | null {
  if (feature?.kind !== 'mirror') return null
  const sub: unknown = feature.mirror
  return typeof sub === 'object' && sub !== null && !Array.isArray(sub) ? sub as FieldBag : null
}

/** The sub-definition that stores a `source_features` list: a pattern's own bag
 *  or the mirror's. The two source chips are the only writers of that field, and
 *  both reorder it through this one lookup. */
export function sourceListSubOf(feature: PartFeature | undefined): FieldBag | null {
  return patternSubOf(feature) ?? mirrorSubOf(feature)
}

/** The mirror's own sub-definition, or the refusal: a mirror chip names its row
 *  exactly like a pattern chip, so the same dead-control rule applies. */
function mirrorSubOrRefuse(featureId: string, feature: PartFeature | undefined, fn: string): FieldBag {
  const sub = mirrorSubOf(feature)
  if (sub !== null) return sub
  const what = feature?.kind === 'mirror'
    ? `feature '${featureId}' has no mirror definition`
    : `feature '${featureId}' is not a feature mirror`
  throw new MutationRefusal(`${fn}: ${what}, so there is no source list to edit`)
}

/** Add a feature to a feature-subject mirror's sources, toggling like every
 *  other multi pick: re-picking a source already in the list drops it again. */
export function applyAddMirrorSource(doc: PartDoc, featureId: string, sourceFeature: string): void {
  const sub = mirrorSubOrRefuse(featureId, findFeature(doc, featureId), 'add_mirror_source')
  const sources = ensurePatternSources(sub)
  const index = sources.indexOf(sourceFeature)
  if (index >= 0) sources.splice(index, 1)
  else sources.push(sourceFeature)
}

export function applyRemoveMirrorSource(doc: PartDoc, featureId: string, index: number): void {
  const sub = mirrorSubOrRefuse(featureId, findFeature(doc, featureId), 'remove_mirror_source')
  const sources = ensurePatternSources(sub)
  if (!removableIndex(sources, index)) return
  sources.splice(index, 1)
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
  const sub = feature?.kind === 'helix' ? feature.helix : undefined
  if (sub !== undefined && refuseHelixAngle(field, value, 'applySetHelixField')) return
  setSubFeatureField(featureId, 'helix', sub, field, value, 'applySetHelixField')
}
