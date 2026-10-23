// The document boundary. Every stored document is parsed, migrated and checked
// here before an editor, a worker or an export sees it: the read paths
// (IndexedDB load, the assembly solve relay, STEP export, clone/duplicate) all
// call in, and none of them may hand raw YAML to the rest of the app. The
// module is framework-free on purpose: no React, no stores, no workers, so the
// whole load contract is unit-testable without a viewport.
//
// Shape errors name the document and the field they were found at instead of
// surfacing later as an obscure builder exception, and numeric fields are
// checked for finiteness plus size caps, so a hostile file cannot hang a
// worker with a billion-entry array or an array count that never terminates.

import { parse as parseYaml } from 'yaml'
import type { AssemblyDoc, PartDoc } from '@/types/cad'
import { VERTEX_POINT_KEYS } from '@/types/vertexKeys'
import { errorMessage } from '@/utils/core/errorMessage'
import { evalExpr } from '@/kernel/evalExpr'
import { threadEntry } from '@/kernel/threadTable'
import { dropDeadAxisConstraints, migrateFeatureRefsToAbsolute, migrateLegacyBodyPicks, canonicalizeFeatureParams } from '@/utils/yamlMigrations'

// The version the ladder migrates to. A document carrying `version` 3 or newer
// skips every step; anything older (including an unstamped document, reads as 0)
// runs the steps whose target version it is behind. The step at 3 canonicalizes
// the two spellings the format used to tolerate (feature refs `$id` -> `@id`,
// flat params -> nested); the historic heals target 2 deliberately: the version
// stamps predate them, so a document stamped 1 can still carry the stale shapes
// they fix.
export const CURRENT_DOC_VERSION = 3

// Caps. Chosen far above what a real document holds while well below what would
// hang a solve: an entity list of 10k is already far past a hand-authored
// sketch, and an array feature producing 100k solids is past what the kernel
// can build in any reasonable time.
export const MAX_FEATURES = 10_000
export const MAX_FEATURE_LIST = 10_000
export const MAX_INITIAL_PARAMS = 64
export const MAX_ARRAY_COUNT = 1_000
export const MAX_ARRAY_CELLS = 100_000
export const MAX_EXPRESSION_LENGTH = 10_000

/** A lost document: what was being loaded, where it went wrong, and the raw
 *  bytes so the caller can offer a read-only view or a raw export. */
export interface DocLoadError {
  docName: string
  // The offending field, e.g. `features[2].extrude.distance`; `document` for a
  // payload that is not a mapping at all.
  field: string
  // A short phrase completing `<field> ...`, e.g. `must be a finite number`.
  message: string
  rawText?: string
}

/** A raw mapping plus its checked document view: the intersection is what lets
 *  a validated doc flow into the export paths that want a plain spec record
 *  without any cast at the call site. */
export type LoadedPartDoc = PartDoc & Record<string, unknown>
export type LoadedAssemblyDoc = AssemblyDoc & Record<string, unknown>

export type LoadResult<T> =
  | { ok: true; doc: T; migrations: string[] }
  | { ok: false; error: DocLoadError }

export interface LoadOptions {
  // The entry's display name, carried into the error report.
  name?: string
  // The original text, carried into the error report for the raw view. Callers
  // holding only a parsed value (a clone's record, a fixture) omit it.
  rawText?: string
}

type DocRecord = Record<string, unknown>

class DocValidationError extends Error {
  readonly field: string

  constructor(field: string, message: string) {
    super(message)
    this.name = 'DocValidationError'
    this.field = field
  }
}

// ─── the migration ladder ───

interface MigrationStep {
  id: string
  // The version this step brings a document up to. A document already at or
  // past `to` skips it.
  to: number
  apply: (doc: DocRecord) => number
}

// Every step mutates the record in place and returns how many things it
// rewrote, so the caller can report what was healed. Steps run before
// validation, on documents that may be malformed, so each narrows what it
// touches and skips anything that does not have the shape it heals: a garbage
// document just reaches the validator untouched and is rejected there.
const MIGRATION_STEPS: MigrationStep[] = [
  // Canonicalization runs before plural-body-picks: a flat legacy singular
  // `body` has to be folded into the sub-def first, or the plural step (which
  // reads the sub-def only) never sees it.
  { id: 'canonical-feature-params', to: 3, apply: stepCanonicalFeatureParams },
  { id: 'feature-refs-absolute', to: 3, apply: stepFeatureRefsAbsolute },
  { id: 'drop-dead-axis-constraints', to: 2, apply: stepDropDeadAxisConstraints },
  { id: 'plural-body-picks', to: 2, apply: stepPluralBodyPicks },
  { id: 'drop-redundant-inline-step-payload', to: 2, apply: stepDropRedundantInlineStepPayload },
]

// The version a raw document claims. Only a non-negative integer counts; a
// missing or malformed stamp reads as 0 (oldest), so the ladder runs every
// step and validation owns the malformed stamp's rejection.
export function docVersion(doc: DocRecord): number {
  const version = doc.version
  return typeof version === 'number' && Number.isInteger(version) && version >= 0 ? version : 0
}

/** Run the migration ladder over a raw document, in place. Returns the ids of
 *  the steps that changed something. */
export function migrate(doc: DocRecord, fromVersion: number): string[] {
  const applied: string[] = []
  for (const step of MIGRATION_STEPS) {
    if (fromVersion >= step.to) continue
    try {
      if (step.apply(doc) > 0) applied.push(step.id)
    } catch {
      // A step only throws on a shape the validator is about to reject anyway;
      // the remaining steps still get their chance on the rest of the document.
    }
  }
  return applied
}

// The shape the two historic heals share: a features list of mappings, with
// the two nested lists dropDeadAxisConstraints walks. Anything else is left for
// the validator to reject by field.
function migratablePartDoc(doc: DocRecord): PartDoc | null {
  const features = doc.features
  if (features === undefined) return doc as unknown as PartDoc
  if (!isRecordList(features, MAX_FEATURES)) return null
  for (const feature of features) {
    const row = feature as DocRecord
    if (row.entities !== undefined && !isRecordList(row.entities, MAX_FEATURE_LIST)) return null
    if (row.constraints !== undefined && !isRecordList(row.constraints, MAX_FEATURE_LIST)) return null
    if (row.transform !== undefined && !isRecord(row.transform)) return null
    if (row.delete_body !== undefined && !isRecord(row.delete_body)) return null
  }
  return doc as unknown as PartDoc
}

function stepDropDeadAxisConstraints(doc: DocRecord): number {
  const part = migratablePartDoc(doc)
  return part ? dropDeadAxisConstraints(part) : 0
}

function stepPluralBodyPicks(doc: DocRecord): number {
  const part = migratablePartDoc(doc)
  return part ? migrateLegacyBodyPicks(part) : 0
}

function stepCanonicalFeatureParams(doc: DocRecord): number {
  const part = migratablePartDoc(doc)
  return part ? canonicalizeFeatureParams(part) : 0
}

function stepFeatureRefsAbsolute(doc: DocRecord): number {
  const part = migratablePartDoc(doc)
  return part ? migrateFeatureRefsToAbsolute(part) : 0
}

// The workspace migration lifts an import_step's inline base64 payload into a
// stored file entry before any editor opens (workspace/inlineStepMigration.ts),
// but it writes the file first and the document second: a crash in between
// leaves `file_id` and a stale `file_data` on the same feature. The kernel
// refuses any non-empty `file_data` by name, so the document cannot solve while
// that pair stands; the file half is already stored, which makes dropping the
// payload a safe, lossless load-time heal. A payload with no `file_id` is left
// for the workspace migration, which is the only half that can store its bytes.
function stepDropRedundantInlineStepPayload(doc: DocRecord): number {
  const features = doc.features
  if (!isRecordList(features, MAX_FEATURES)) return 0
  let dropped = 0
  for (const feature of features) {
    const row = feature as DocRecord
    if (row.kind !== 'import_step') continue
    if (typeof row.file_id !== 'string' || row.file_id === '') continue
    if (typeof row.file_data === 'string' && row.file_data.length > 0) {
      delete row.file_data
      dropped++
    }
  }
  return dropped
}

// ─── primitive guards ───

function kindOf(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'a list'
  return `a ${typeof value}`
}

function fail(field: string, message: string): never {
  throw new DocValidationError(field, message)
}

function isRecord(value: unknown): value is DocRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isRecordList(value: unknown, max: number): value is DocRecord[] {
  if (!Array.isArray(value) || value.length > max) return false
  for (let i = 0; i < value.length; i++) {
    if (!isRecord(value[i])) return false
  }
  return true
}

function checkRecord(value: unknown, field: string): DocRecord {
  if (!isRecord(value)) fail(field, `must be a mapping, got ${kindOf(value)}`)
  return value
}

// The one array guard every list goes through: length first, so a sparse
// billion-entry array is refused before anything walks it.
function checkList(value: unknown, field: string, max: number): unknown[] {
  if (!Array.isArray(value)) fail(field, `must be a list, got ${kindOf(value)}`)
  if (value.length > max) fail(field, `has ${value.length} entries, the limit is ${max}`)
  return value
}

// Index walk, never `forEach`: a sparse array's holes are skipped by the
// iterator forms, and a hole is exactly the malformed entry the guards exist to
// catch (a doc with holes reaches the builder as `undefined` features).
function eachEntry(list: unknown[], field: string, check: (value: unknown, field: string) => void): void {
  for (let i = 0; i < list.length; i++) check(list[i], `${field}[${i}]`)
}

function checkString(value: unknown, field: string): void {
  if (typeof value !== 'string') fail(field, `must be a string, got ${kindOf(value)}`)
}

function checkRef(value: unknown, field: string): void {
  if (typeof value !== 'string') fail(field, `must be a reference string, got ${kindOf(value)}`)
}

function checkId(value: unknown, field: string): void {
  if (typeof value !== 'string' || value === '') fail(field, `must be a non-empty id string, got ${kindOf(value)}`)
}

function checkBoolean(value: unknown, field: string): void {
  if (typeof value !== 'boolean') fail(field, `must be a boolean, got ${kindOf(value)}`)
}

function checkFiniteNumber(value: unknown, field: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(field, `must be a finite number, got ${typeof value === 'number' ? String(value) : kindOf(value)}`)
  }
}

function checkInteger(value: unknown, field: string, min = 0): void {
  checkFiniteNumber(value, field)
  const n = value as number
  if (!Number.isInteger(n) || n < min) fail(field, `must be an integer >= ${min}, got ${n}`)
}

function checkEnum(value: unknown, field: string, allowed: readonly string[]): void {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    fail(field, `must be one of ${allowed.map(a => `"${a}"`).join(', ')}, got ${JSON.stringify(value)}`)
  }
}

// A NumberOrExpr: a finite number, or an expression string the solve pipeline
// evaluates later. The string is length-capped because it reaches the
// expression evaluator.
function checkExpr(value: unknown, field: string): void {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(field, `must be finite, got ${String(value)}`)
    return
  }
  if (typeof value === 'string') {
    if (value.length > MAX_EXPRESSION_LENGTH) fail(field, `is longer than ${MAX_EXPRESSION_LENGTH} characters`)
    return
  }
  fail(field, `must be a number or an expression string, got ${kindOf(value)}`)
}

function checkOptional(record: DocRecord, key: string, field: string, check: (value: unknown, field: string) => void): void {
  const value = record[key]
  if (value === undefined) return
  check(value, `${field}.${key}`)
}

function checkVec3(value: unknown, field: string): void {
  const list = checkList(value, field, 3)
  if (list.length !== 3) fail(field, `must have 3 components, got ${list.length}`)
  eachEntry(list, field, checkFiniteNumber)
}

function checkRefList(value: unknown, field: string): void {
  const list = checkList(value, field, MAX_FEATURE_LIST)
  eachEntry(list, field, checkRef)
}

function checkRefOrRefList(value: unknown, field: string): void {
  if (Array.isArray(value)) checkRefList(value, field)
  else checkRef(value, field)
}

// A constraint operand names the locus or vertex a constraint points at. The
// app writes the wire spelling (`$entityId[vertexKey]`, `@builtin_origin`)
// from parseTarget, and the readers accept the resolved dict forms too:
// types/vertexRef's `{entity, point?}` and the solver's
// `{external_xy: [x, y]}` projected-origin form. A hand-authored or foreign
// document may carry either, so both are accepted here. Anything else is
// refused by field rather than dropped silently when the sketch lowers.
function checkReferenceOperand(value: unknown, field: string): void {
  if (typeof value === 'string') {
    if (value === '') fail(field, 'must not be an empty reference string')
    return
  }
  const operand = checkRecord(value, field)
  if (operand.external_xy !== undefined) {
    const xy = checkList(operand.external_xy, `${field}.external_xy`, 2)
    if (xy.length !== 2) fail(`${field}.external_xy`, `must have 2 components, got ${xy.length}`)
    eachEntry(xy, `${field}.external_xy`, checkFiniteNumber)
    return
  }
  checkId(operand.entity, `${field}.entity`)
  // The selector vocabulary is vertexKeys' VERTEX_POINT_KEYS, which is what
  // resolveVertexRef matches a dict point against; an unknown name makes the
  // constraint unresolvable, and the lowerer would drop it without a word.
  if (operand.point !== undefined && operand.point !== null) {
    checkEnum(operand.point, `${field}.point`, VERTEX_POINT_KEYS)
  }
}

// The n-ary `refs` on a sugar constraint. The `ngon` sugar writes bare member
// operands (parseTarget strings) into PartConstraint.refs, and the lowering
// reads them as operands; the lowered solver wire carries `{role, ref}`
// records under the same key (lowerSketch builds them, codec.ts encodes
// them), and a foreign writer may persist that form, so both are accepted.
function checkReferenceOperandList(value: unknown, field: string): void {
  const list = checkList(value, field, MAX_FEATURE_LIST)
  for (let i = 0; i < list.length; i++) {
    const entryField = `${field}[${i}]`
    const entry = list[i]
    if (isRecord(entry) && (entry.role !== undefined || entry.ref !== undefined)) {
      if (typeof entry.role !== 'string' && typeof entry.role !== 'number') {
        fail(`${entryField}.role`, `must be a role name or code, got ${kindOf(entry.role)}`)
      }
      if (entry.ref === undefined) fail(`${entryField}.ref`, 'is required')
      checkReferenceOperand(entry.ref, `${entryField}.ref`)
      continue
    }
    checkReferenceOperand(entry, entryField)
  }
}

// A count that expands in the builder: a positive integer within the cap, or an
// expression string. An expression is evaluated here with no variable context
// as a best-effort guard; a string whose value cannot be known yet (it names a
// document variable) passes and is checked again when the solver resolves it.
function checkCount(value: unknown, field: string): number | null {
  if (typeof value === 'number') {
    checkInteger(value, field, 1)
    if (value > MAX_ARRAY_COUNT) fail(field, `must be at most ${MAX_ARRAY_COUNT}, got ${value}`)
    return value
  }
  if (typeof value === 'string') {
    checkExpr(value, field)
    const resolved = evalExpr(value)
    if (Number.isFinite(resolved)) {
      if (!Number.isInteger(resolved) || resolved < 1) fail(field, `evaluates to ${resolved}, expected a positive integer`)
      if (resolved > MAX_ARRAY_COUNT) fail(field, `evaluates to ${resolved}, the limit is ${MAX_ARRAY_COUNT}`)
      return resolved
    }
    return null
  }
  fail(field, `must be a number or an expression string, got ${kindOf(value)}`)
}

// ─── feature validation ───

const DIRECTIONS = ['normal', 'reverse', 'symmetric'] as const
const OPERATIONS = ['add', 'cut', 'new'] as const
const PLANE_MODES = ['offset', 'three_point', 'plane_point', 'line_angle', 'edge_point', 'on_face', 'on_face_edge_angle'] as const
const MATE_KINDS = [
  'fixed', 'sliding', 'rotating', 'sliding_rotating', 'tangential',
  'copy_rotation', 'spherical', 'parallel', 'parallel_plane_distance',
] as const

function checkPlaneDef(value: unknown, field: string): void {
  const def = checkRecord(value, field)
  checkOptional(def, 'mode', field, (v, f) => checkEnum(v, f, PLANE_MODES))
  for (const key of ['plane', 'p1', 'p2', 'p3', 'point', 'line', 'edge', 'face']) {
    checkOptional(def, key, field, checkRef)
  }
  for (const key of ['offset', 'angle', 'rotation']) {
    checkOptional(def, key, field, checkExpr)
  }
}

function checkEntity(value: unknown, field: string): void {
  const entity = checkRecord(value, field)
  checkId(entity.id, `${field}.id`)
  checkString(entity.kind, `${field}.kind`)
  checkOptional(entity, 'construction', field, checkBoolean)
  checkOptional(entity, 'source', field, checkString)
}

// A sketch addresses its entities by id (constraint operands, the solve result
// keyed by entity id, delete targets), so two entries under one id make every
// one of those lookups ambiguous. A document can only reach this state through
// a hand edit or a broken writer: an add through the mutation path refuses a
// supplied id the sketch already holds.
function checkUniqueEntityIds(entities: unknown[], field: string): void {
  const seen = new Set<string>()
  for (let i = 0; i < entities.length; i++) {
    const entity = entities[i]
    if (!isRecord(entity) || typeof entity.id !== 'string') continue
    if (seen.has(entity.id)) {
      fail(`${field}[${i}].id`, `duplicates entity id ${JSON.stringify(entity.id)}; a sketch cannot hold two entities with the same id`)
    }
    seen.add(entity.id)
  }
}

// The keys a constraint carries an operand under: the eight lowerSketch's
// REF_KEYS resolve, plus `circle`, the `ngon` sugar's construction circle
// (PartConstraint.circle, read by the ngon lowering and the renderer).
const CONSTRAINT_OPERAND_KEYS = [
  'target', 'a', 'b', 'line', 'arc', 'point', 'point_a', 'point_b', 'circle',
] as const

function checkConstraint(value: unknown, field: string): void {
  const constraint = checkRecord(value, field)
  checkId(constraint.id, `${field}.id`)
  checkString(constraint.kind, `${field}.kind`)
  for (const key of ['value', 'x', 'y', 'sign']) {
    checkOptional(constraint, key, field, checkFiniteNumber)
  }
  for (const key of CONSTRAINT_OPERAND_KEYS) {
    checkOptional(constraint, key, field, checkReferenceOperand)
  }
  // `host` names another constraint by id (PartConstraint.host), not an entity
  // ref: the dock lowering looks it up among the feature's constraints.
  checkOptional(constraint, 'host', field, checkId)
  // An axis selector name, not a ref: lowerSketch maps it through its own
  // AxisCode table and refuses an unknown one there by name.
  checkOptional(constraint, 'axis', field, checkString)
  checkOptional(constraint, 'refs', field, checkReferenceOperandList)
  checkOptional(constraint, 'pos', field, (v, f) => {
    const list = checkList(v, f, 2)
    if (list.length !== 2) fail(f, `must have 2 components, got ${list.length}`)
    eachEntry(list, f, checkFiniteNumber)
  })
}

function checkInitial(value: unknown, field: string): void {
  const initial = checkRecord(value, field)
  const keys = Object.keys(initial)
  if (keys.length > MAX_FEATURE_LIST) fail(field, `has ${keys.length} entries, the limit is ${MAX_FEATURE_LIST}`)
  for (const key of keys) {
    const params = checkList(initial[key], `${field}.${key}`, MAX_INITIAL_PARAMS)
    eachEntry(params, `${field}.${key}`, checkFiniteNumber)
  }
}

function checkExtrude(sub: DocRecord, field: string): void {
  checkOptional(sub, 'sketch', field, checkRefOrRefList)
  checkOptional(sub, 'distance', field, checkExpr)
  checkOptional(sub, 'direction', field, (v, f) => checkEnum(v, f, DIRECTIONS))
  checkOptional(sub, 'termination', field, (v, f) => checkEnum(v, f, ['blind', 'up_to']))
  checkOptional(sub, 'up_to', field, checkRef)
  checkOptional(sub, 'operation', field, (v, f) => checkEnum(v, f, OPERATIONS))
  checkOptional(sub, 'merge_target', field, checkRef)
}

function checkRevolve(sub: DocRecord, field: string): void {
  checkOptional(sub, 'sketch', field, checkRefOrRefList)
  checkOptional(sub, 'angle', field, checkExpr)
  checkOptional(sub, 'direction', field, (v, f) => checkEnum(v, f, DIRECTIONS))
  checkOptional(sub, 'axis', field, checkRef)
  checkOptional(sub, 'operation', field, (v, f) => checkEnum(v, f, OPERATIONS))
  checkOptional(sub, 'merge_target', field, checkRef)
}

function checkSweep(sub: DocRecord, field: string): void {
  checkOptional(sub, 'sketch', field, checkRefOrRefList)
  checkOptional(sub, 'path', field, checkRefOrRefList)
  checkOptional(sub, 'operation', field, (v, f) => checkEnum(v, f, OPERATIONS))
  checkOptional(sub, 'merge_target', field, checkRef)
}

function checkFillet(sub: DocRecord, field: string): void {
  checkOptional(sub, 'edges', field, checkRefList)
  checkOptional(sub, 'radius', field, checkExpr)
}

function checkChamfer(sub: DocRecord, field: string): void {
  checkOptional(sub, 'edges', field, checkRefList)
  checkOptional(sub, 'distance', field, checkExpr)
  checkOptional(sub, 'kind', field, (v, f) => checkEnum(v, f, ['distance', 'angle_distance']))
  checkOptional(sub, 'angle', field, checkExpr)
}

// A positive NumberOrExpr: a positive finite number, or a string that is either
// unresolvable now (it names a document variable) or evaluates positive. A
// thickness of 0 or less builds nothing or an inverted solid, so it is refused
// at the boundary rather than at solve time.
function checkPositiveExpr(value: unknown, field: string): void {
  checkExpr(value, field)
  if (typeof value === 'number') {
    if (!(value > 0)) fail(field, `must be positive, got ${value}`)
    return
  }
  const resolved = evalExpr(value as string)
  if (Number.isFinite(resolved) && resolved <= 0) {
    fail(field, `evaluates to ${resolved}, expected a positive number`)
  }
}

function checkShell(sub: DocRecord, field: string): void {
  checkOptional(sub, 'faces', field, checkRefList)
  checkOptional(sub, 'thickness', field, checkPositiveExpr)
  checkOptional(sub, 'direction', field, (v, f) => checkEnum(v, f, ['inward', 'outward']))
  checkOptional(sub, 'source_body', field, checkRef)
}

function checkMoveFace(sub: DocRecord, field: string): void {
  checkOptional(sub, 'faces', field, checkRefList)
  // Signed: 0 is the identity, negative removes material, so no positivity gate.
  checkOptional(sub, 'distance', field, checkExpr)
}

function checkBooleanDef(sub: DocRecord, field: string): void {
  checkOptional(sub, 'operation', field, (v, f) => checkEnum(v, f, ['union', 'subtract', 'intersect']))
  checkOptional(sub, 'target', field, checkRef)
  checkOptional(sub, 'tools', field, checkRefList)
  checkOptional(sub, 'keep_tools', field, checkBoolean)
  // Optional and absent means 0, so there is no migration rung.
  checkOptional(sub, 'clearance', field, checkExpr)
}

function checkCountPair(sub: DocRecord, field: string): void {
  const x = sub.count_x === undefined ? null : checkCount(sub.count_x, `${field}.count_x`)
  const y = sub.count_y === undefined ? null : checkCount(sub.count_y, `${field}.count_y`)
  if (x !== null && y !== null && x * y > MAX_ARRAY_CELLS) {
    fail(`${field}.count_x`, `count_x x count_y is ${x * y}, the limit is ${MAX_ARRAY_CELLS}`)
  }
}

function checkArray(sub: DocRecord, field: string): void {
  checkOptional(sub, 'source_body', field, checkRef)
  checkOptional(sub, 'mode', field, (v, f) => checkEnum(v, f, ['linear', 'rectangular']))
  checkOptional(sub, 'operation', field, (v, f) => checkEnum(v, f, ['add', 'new']))
  checkOptional(sub, 'include_source', field, checkBoolean)
  checkCountPair(sub, field)
  for (const key of ['pitch_x', 'pitch_y']) checkOptional(sub, key, field, checkExpr)
  for (const key of ['direction_x', 'direction_y']) checkOptional(sub, key, field, checkVec3)
  for (const key of ['direction_x_query', 'direction_y_query']) checkOptional(sub, key, field, checkRef)
  for (const key of ['invert_x', 'invert_y']) checkOptional(sub, key, field, checkBoolean)
}

function checkCircularArray(sub: DocRecord, field: string): void {
  checkOptional(sub, 'source_body', field, checkRef)
  checkOptional(sub, 'operation', field, (v, f) => checkEnum(v, f, ['add', 'new']))
  checkOptional(sub, 'include_source', field, checkBoolean)
  if (sub.count !== undefined) checkCount(sub.count, `${field}.count`)
  if (sub.step_angle !== undefined && sub.step_angle !== null) checkExpr(sub.step_angle, `${field}.step_angle`)
  checkOptional(sub, 'axis', field, checkRef)
  for (const key of ['axis_origin', 'axis_direction']) checkOptional(sub, key, field, checkVec3)
  checkOptional(sub, 'invert_axis', field, checkBoolean)
}

function checkDeleteBody(sub: DocRecord, field: string): void {
  checkOptional(sub, 'bodies', field, checkRefList)
}

// No scalar params: `faces` is the whole spec. A non-array `faces` is refused.
function checkDeleteFace(sub: DocRecord, field: string): void {
  checkOptional(sub, 'faces', field, checkRefList)
}

// The hole's cosmetic thread spec: a designation whose nominal and pitch must
// agree with the table when the table knows it. A doc that carries an unknown
// designation still loads (the thread is metadata and changes no geometry), but
// its pair is checked against the entry when there is one, so a hand-typed M6
// with M8's numbers cannot pass as a valid thread.
function checkThread(value: unknown, field: string): void {
  const thread = checkRecord(value, field)
  if (typeof thread.designation !== 'string' || thread.designation === '') {
    fail(`${field}.designation`, 'must be a non-empty thread designation')
  }
  checkFiniteNumber(thread.nominal, `${field}.nominal`)
  checkFiniteNumber(thread.pitch, `${field}.pitch`)
  if ((thread.nominal as number) <= 0) fail(`${field}.nominal`, 'must be positive')
  if ((thread.pitch as number) <= 0) fail(`${field}.pitch`, 'must be positive')
  const entry = threadEntry(thread.designation as string)
  if (entry !== null) {
    if (Math.abs((thread.nominal as number) - entry.nominal) > 1e-9) {
      fail(`${field}.nominal`, `${thread.designation} names ${entry.nominal} mm, got ${thread.nominal}`)
    }
    if (Math.abs((thread.pitch as number) - entry.pitch) > 1e-9) {
      fail(`${field}.pitch`, `${thread.designation} has a ${entry.pitch} mm pitch, got ${thread.pitch}`)
    }
  }
}

function checkHole(sub: DocRecord, field: string): void {
  checkOptional(sub, 'sketch', field, checkRef)
  checkOptional(sub, 'diameter', field, checkExpr)
  checkOptional(sub, 'depth_mode', field, (v, f) => checkEnum(v, f, ['blind', 'through_all']))
  checkOptional(sub, 'depth', field, checkExpr)
  checkOptional(sub, 'direction', field, (v, f) => checkEnum(v, f, ['normal', 'reverse']))
  checkOptional(sub, 'target', field, checkRef)
  checkOptional(sub, 'thread', field, checkThread)
}

function checkTransform(sub: DocRecord, field: string): void {
  checkOptional(sub, 'bodies', field, checkRefList)
  checkOptional(sub, 'operation', field, (v, f) => checkEnum(v, f, ['new', 'replace']))
  checkOptional(sub, 'translation', field, checkVec3)
  for (const key of ['translation_from', 'translation_to', 'rotation_axis', 'scale_center_from']) {
    checkOptional(sub, key, field, checkRef)
  }
  checkOptional(sub, 'rotation_angle', field, checkExpr)
  for (const key of ['rotation_axis_origin', 'rotation_axis_direction', 'scale_center']) {
    checkOptional(sub, key, field, checkVec3)
  }
  checkOptional(sub, 'scale', field, checkExpr)
}

function checkMirror(sub: DocRecord, field: string): void {
  checkOptional(sub, 'body', field, checkRef)
  checkOptional(sub, 'plane', field, checkRef)
  checkOptional(sub, 'keep_original', field, checkBoolean)
  checkOptional(sub, 'merge', field, checkBoolean)
}

function checkVariable(sub: DocRecord, field: string): void {
  checkOptional(sub, 'expression', field, checkExpr)
  checkOptional(sub, 'value', field, checkFiniteNumber)
  checkOptional(sub, 'unit', field, checkString)
}

const HELIX_MODES = ['pitch_turns', 'pitch_height', 'turns_height', 'angle_turns', 'angle_height'] as const
const HELIX_HANDS = ['right', 'left'] as const
const HELIX_RADIUS_MODES = ['derived', 'entered'] as const

function checkHelix(sub: DocRecord, field: string): void {
  checkOptional(sub, 'reference', field, checkRef)
  checkOptional(sub, 'radius_mode', field, (v, f) => checkEnum(v, f, HELIX_RADIUS_MODES))
  checkOptional(sub, 'mode', field, (v, f) => checkEnum(v, f, HELIX_MODES))
  checkOptional(sub, 'hand', field, (v, f) => checkEnum(v, f, HELIX_HANDS))
  checkOptional(sub, 'direction', field, (v, f) => checkEnum(v, f, ['normal', 'reverse']))
  checkOptional(sub, 'height_from_reference', field, checkBoolean)
  for (const key of ['radius', 'pitch', 'turns', 'height', 'helix_angle', 'offset', 'start_angle']) {
    checkOptional(sub, key, field, checkExpr)
  }
  // The one range the parametrisation cannot cross: 0 and 90 are degenerate, so
  // a literal angle outside (0, 90) is refused here. An expression is checked
  // when the solver resolves it.
  const angle = sub.helix_angle
  if (typeof angle === 'number' && (angle <= 0 || angle >= 90)) {
    fail(`${field}.helix_angle`, `must be between 0 and 90 degrees, got ${angle}`)
  }
}

function checkImportStep(sub: DocRecord, field: string): void {
  checkOptional(sub, 'file_id', field, checkString)
  checkOptional(sub, 'file_data', field, checkString)
  checkOptional(sub, 'scale', field, checkExpr)
}

// One entry per feature kind that carries a sub-definition. An unknown kind is
// accepted: the solver refuses it by name, and a forward-compatible reader must
// not reject a document a newer version wrote. A Map, not a record, so a hostile
// `kind: __proto__` cannot reach Object.prototype's members.
const FEATURE_DEF_CHECKS = new Map<string, (sub: DocRecord, field: string) => void>([
  ['extrude', checkExtrude],
  ['revolve', checkRevolve],
  ['sweep', checkSweep],
  ['fillet', checkFillet],
  ['chamfer', checkChamfer],
  ['shell', checkShell],
  ['move_face', checkMoveFace],
  ['delete_face', checkDeleteFace],
  ['boolean', checkBooleanDef],
  ['array', checkArray],
  ['circular_array', checkCircularArray],
  ['delete_body', checkDeleteBody],
  ['hole', checkHole],
  ['transform', checkTransform],
  ['mirror', checkMirror],
  ['variable', checkVariable],
  ['helix', checkHelix],
  ['import_step', checkImportStep],
])

function checkFeatureDefs(feature: DocRecord, field: string): void {
  const kind = feature.kind as string
  const check = FEATURE_DEF_CHECKS.get(kind)
  if (check && feature[kind] !== undefined) {
    const sub = checkRecord(feature[kind], `${field}.${kind}`)
    check(sub, `${field}.${kind}`)
  }
  if (feature.definition !== undefined) checkPlaneDef(feature.definition, `${field}.definition`)
}

function checkFeature(value: unknown, field: string): void {
  const feature = checkRecord(value, field)
  checkId(feature.id, `${field}.id`)
  checkString(feature.kind, `${field}.kind`)
  for (const key of ['label', 'file_id', 'file_data']) checkOptional(feature, key, field, checkString)
  for (const key of ['plane', 'drag_anchor']) checkOptional(feature, key, field, checkRef)
  for (const key of ['visible', 'suppressed', 'auto_hidden']) checkOptional(feature, key, field, checkBoolean)
  if (feature.entities !== undefined) {
    const entities = checkList(feature.entities, `${field}.entities`, MAX_FEATURE_LIST)
    eachEntry(entities, `${field}.entities`, checkEntity)
    checkUniqueEntityIds(entities, `${field}.entities`)
  }
  if (feature.constraints !== undefined) {
    const constraints = checkList(feature.constraints, `${field}.constraints`, MAX_FEATURE_LIST)
    eachEntry(constraints, `${field}.constraints`, checkConstraint)
  }
  if (feature.initial !== undefined) checkInitial(feature.initial, `${field}.initial`)
  checkFeatureDefs(feature, field)
}

// ─── document validation ───

function checkVersionFields(doc: DocRecord): void {
  if (doc.version !== undefined) checkInteger(doc.version, 'version')
  if (doc.oversolved !== undefined) checkInteger(doc.oversolved, 'oversolved')
}

function checkPartStyle(value: unknown, field: string): void {
  const style = checkRecord(value, field)
  for (const key of Object.keys(style)) {
    const entry = checkRecord(style[key], `${field}.${key}`)
    for (const name of ['name', 'color', 'created_by']) checkOptional(entry, name, `${field}.${key}`, checkString)
    checkOptional(entry, 'visible', `${field}.${key}`, checkBoolean)
    for (const num of ['transparency', 'metalness', 'roughness', 'transmission']) {
      checkOptional(entry, num, `${field}.${key}`, checkFiniteNumber)
    }
  }
}

function checkFeatures(doc: DocRecord, field: string, check: (value: unknown, field: string) => void): void {
  if (doc.features === undefined) return
  const features = checkList(doc.features, field, MAX_FEATURES)
  eachEntry(features, field, check)
}

function validatePart(doc: DocRecord): void {
  checkVersionFields(doc)
  if (doc.kind !== undefined) {
    if (doc.kind === 'assembly') fail('kind', `must be "part" for a part document, got ${JSON.stringify(doc.kind)}`)
    if (doc.kind !== 'part') fail('kind', `must be "part", got ${JSON.stringify(doc.kind)}`)
  }
  if (doc.rollback !== undefined) checkInteger(doc.rollback, 'rollback')
  checkFeatures(doc, 'features', checkFeature)
  if (doc.part_style !== undefined) checkPartStyle(doc.part_style, 'part_style')
}

function checkTransform3D(value: unknown, field: string): void {
  const transform = checkRecord(value, field)
  for (const key of ['tx', 'ty', 'tz', 'qx', 'qy', 'qz', 'qw']) {
    if (transform[key] === undefined) fail(`${field}.${key}`, 'is required')
    checkFiniteNumber(transform[key], `${field}.${key}`)
  }
}

function checkPartInstance(value: unknown, field: string): void {
  const instance = checkRecord(value, field)
  checkId(instance.handle, `${field}.handle`)
  checkId(instance.doc_id, `${field}.doc_id`)
  checkInteger(instance.doc_rev, `${field}.doc_rev`)
  checkTransform3D(instance.transform, `${field}.transform`)
  for (const key of ['visible', 'fixed']) checkOptional(instance, key, field, checkBoolean)
}

function checkAnchorDescriptor(value: unknown, field: string): void {
  const descriptor = checkRecord(value, field)
  checkId(descriptor.geom_hash, `${field}.geom_hash`)
  checkString(descriptor.kind, `${field}.kind`)
  checkId(descriptor.created_by, `${field}.created_by`)
  checkVec3(descriptor.point, `${field}.point`)
}

function checkMateRef(value: unknown, field: string): void {
  const ref = checkRecord(value, field)
  checkRef(ref.part, `${field}.part`)
  checkRef(ref.anchor, `${field}.anchor`)
  if (ref.anchor_descriptor !== undefined) checkAnchorDescriptor(ref.anchor_descriptor, `${field}.anchor_descriptor`)
}

function checkMateOffset(value: unknown, field: string): void {
  if (isRecord(value)) {
    for (const key of ['x', 'y', 'z']) checkOptional(value, key, field, checkExpr)
    return
  }
  checkExpr(value, field)
}

function checkMateDef(value: unknown, field: string): void {
  const mate = checkRecord(value, field)
  if (mate.kind === undefined) fail(`${field}.kind`, 'is required')
  checkEnum(mate.kind, `${field}.kind`, MATE_KINDS)
  checkOptional(mate, 'label', field, checkString)
  if (mate.ref_a === undefined) fail(`${field}.ref_a`, 'is required')
  if (mate.ref_b === undefined) fail(`${field}.ref_b`, 'is required')
  checkMateRef(mate.ref_a, `${field}.ref_a`)
  checkMateRef(mate.ref_b, `${field}.ref_b`)
  checkOptional(mate, 'flip', field, checkBoolean)
  checkOptional(mate, 'ratio', field, checkFiniteNumber)
  checkOptional(mate, 'offset', field, checkMateOffset)
  for (const key of ['angle', 'radius']) checkOptional(mate, key, field, checkExpr)
}

const ASSEMBLY_FEATURE_KINDS = ['part_instance', 'mate', 'origin', 'plane'] as const

function checkAssemblyFeature(value: unknown, field: string): void {
  const feature = checkRecord(value, field)
  checkId(feature.id, `${field}.id`)
  checkEnum(feature.kind, `${field}.kind`, ASSEMBLY_FEATURE_KINDS)
  checkOptional(feature, 'visible', field, checkBoolean)
  if (feature.definition !== undefined) checkPlaneDef(feature.definition, `${field}.definition`)
  if (feature.instance !== undefined) checkPartInstance(feature.instance, `${field}.instance`)
  if (feature.mate !== undefined) checkMateDef(feature.mate, `${field}.mate`)
}

function validateAssembly(doc: DocRecord): void {
  checkVersionFields(doc)
  if (doc.kind !== undefined && doc.kind !== 'assembly') {
    fail('kind', `must be "assembly" for an assembly document, got ${JSON.stringify(doc.kind)}`)
  }
  checkFeatures(doc, 'features', checkAssemblyFeature)
  if (doc.part_style !== undefined) checkPartStyle(doc.part_style, 'part_style')
}

// ─── entry points ───

function loadRecord<T>(
  raw: unknown,
  opts: LoadOptions,
  validate: (doc: DocRecord) => void,
): LoadResult<T> {
  const docName = opts.name ?? ''
  try {
    // `parseYaml` answers null for empty text, and an empty part or assembly is
    // the document an editor creates before the first edit, so null reads as an
    // empty mapping. Anything else that is not a mapping is a boundary error.
    const record: DocRecord = raw === null || raw === undefined ? {} : checkRecord(raw, 'document')
    const applied = migrate(record, docVersion(record))
    validate(record)
    return { ok: true, doc: record as T, migrations: applied }
  } catch (e) {
    if (e instanceof DocValidationError) {
      return { ok: false, error: { docName, field: e.field, message: e.message, rawText: opts.rawText } }
    }
    // A guard bug must not take the page down with it: report the document as
    // unreadable and keep its raw text reachable.
    return {
      ok: false,
      error: { docName, field: 'document', message: errorMessage(e, 'could not be read'), rawText: opts.rawText },
    }
  }
}

function loadText<T>(
  text: string,
  opts: LoadOptions,
  load: (raw: unknown, opts: LoadOptions) => LoadResult<T>,
): LoadResult<T> {
  let raw: unknown
  try {
    raw = parseYaml(text)
  } catch (e) {
    return {
      ok: false,
      error: {
        docName: opts.name ?? '',
        field: 'document',
        message: `is not valid YAML: ${errorMessage(e, 'unparseable')}`,
        rawText: opts.rawText ?? text,
      },
    }
  }
  return load(raw, { ...opts, rawText: opts.rawText ?? text })
}

/** Validate and migrate a parsed part document. */
export function loadPartDoc(raw: unknown, opts: LoadOptions = {}): LoadResult<LoadedPartDoc> {
  return loadRecord<LoadedPartDoc>(raw, opts, validatePart)
}

/** Validate and migrate part document text. */
export function loadPartDocText(text: string, opts: LoadOptions = {}): LoadResult<LoadedPartDoc> {
  return loadText(text, opts, loadPartDoc)
}

/** Validate and migrate a parsed assembly document. */
export function loadAssemblyDoc(raw: unknown, opts: LoadOptions = {}): LoadResult<LoadedAssemblyDoc> {
  return loadRecord<LoadedAssemblyDoc>(raw, opts, validateAssembly)
}

/** Validate and migrate assembly document text. */
export function loadAssemblyDocText(text: string, opts: LoadOptions = {}): LoadResult<LoadedAssemblyDoc> {
  return loadText(text, opts, loadAssemblyDoc)
}

/**
 * Load document text by the entry's open kind. An entry classified as an
 * assembly goes through the assembly checks; everything else through the part
 * checks, which also refuse a stamped kind that does not match. Used where the
 * caller only holds an entry record (the workspace clone/duplicate seam).
 */
export function loadDocText(
  text: string,
  docKind: string | undefined,
  opts: LoadOptions = {},
): LoadResult<LoadedPartDoc | LoadedAssemblyDoc> {
  return docKind === 'assembly' ? loadAssemblyDocText(text, opts) : loadPartDocText(text, opts)
}

/** The one phrasing of a load failure a banner or an error dialog shows. */
export function docLoadErrorMessage(error: DocLoadError): string {
  const who = error.docName ? `"${error.docName}"` : 'document'
  return `Could not open ${who} at ${error.field}: ${error.message}`
}
