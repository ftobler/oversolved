// The value side of the drive boundary. mutationCatalog refuses a mutation
// whose field names and JSON types are wrong; this module refuses one whose
// values are wrong for the field they land in. The rules are one table keyed by
// mutation type (a total Record, so a new mutation type cannot skip the
// decision): either a check, or the literal 'none' saying the applier owns
// every value it can receive.
//
// The field-value checks read the part-document schema instead of restating
// every enum, ref and number-or-expression union: a setter's value is validated
// against the schema definition of the field it names, which is the contract the
// saved document is held to. The doc-aware checks (duplicate ids, delete
// targets) only run when the caller supplies the live document; shape checks
// always run, so the headless and browser surfaces agree on what a value may
// look like.
//
// Internal plumbing (journal replay) skips the whole table: replay reappplies
// mutations the app itself produced, and refusing a historical value would make
// an old journal unreplayable.

import type { EntityKind, FeatureKind, Mutation, PartDoc } from '@/types/cad'
import { ENTITY_BY_KIND } from '@/registry/entityRegistry'
import { CONSTRAINT_BY_KIND } from '@/registry/constraintRegistry'
import { BUILTIN_PLANES, resolveBarePlaneId } from '@/kernel/solverConstants'
import { mirrorAxisFromLineParams } from '@/utils/geometry/mirrorSketch'
import { featureFieldNames, planeDefinitionSchema, type JsonSchema } from '@/persistence/partDocSchema'

export type ValueViolationCode = 'invalid-mutation' | 'unknown-target'

export interface ValueViolation {
  code: ValueViolationCode
  message: string
}

// The untyped JSON object a script step carries. The catalog has already
// refused an unknown key and a wrong JSON type, so this alias exists to keep
// the rules readable, not to loosen the feature union's own typing.
type RawStep = { [key: string]: unknown }

export interface ValueContext {
  // The document the step is about to be applied to. Absent means the caller
  // can only judge the value's shape, not whether it names anything.
  doc: PartDoc | null
  // The schema definition of a `set_*_field` value, resolved by the catalog
  // from FIELD_SETTER_KIND. Null for a type that is not a field setter.
  fieldSchema: (type: Mutation['type'], field: string) => JsonSchema | null
}

export type ValueRule = 'none' | ((raw: RawStep, ctx: ValueContext) => ValueViolation | null)

function invalid(message: string): ValueViolation {
  return { code: 'invalid-mutation', message }
}

function unknownTarget(message: string): ValueViolation {
  return { code: 'unknown-target', message }
}

function json(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (typeof value === 'number' && !Number.isFinite(value)) return String(value)
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

function isRecord(value: unknown): value is RawStep {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

// ─── entity kinds and their flat param arrays ───

// The parameter names per entity kind, printed in a refusal so a caller learns
// the accepted shape. The COUNT is not restated: it is read from
// ENTITY_BY_KIND[kind].paramCount, the registry the solver and the draw tools
// share, and mutationValueRules.test.ts holds the two in step.
const ENTITY_PARAM_NAMES: Record<EntityKind, readonly string[]> = {
  line: ['start_x', 'start_y', 'end_x', 'end_y'],
  circle: ['cx', 'cy', 'radius'],
  arc: ['cx', 'cy', 'radius', 'angle_start_deg', 'angle_end_deg'],
  ellipse: ['cx', 'cy', 'a', 'b', 'theta_deg'],
  spline: ['start_x', 'start_y', 'c1_x', 'c1_y', 'c2_x', 'c2_y', 'end_x', 'end_y'],
  // Variable: `x0, y0, ..., xN-1, yN-1` then the optional handles. The names
  // shown are the two-point minimum; `entityParamsProblem` special-cases the
  // real count below.
  fit_spline: ['x0', 'y0', 'x1', 'y1'],
  point: ['x', 'y'],
}

const ENTITY_KINDS = Object.keys(ENTITY_PARAM_NAMES).join(', ')

// Below this a degree span describes the same point twice; the arc bounds no
// region and only reaches the builder as a sliver. Legitimate small arcs (a
// chamfer relief, a degree-scale fillet) are far above it.
const DEGENERATE_ARC_SPAN_DEG = 1e-6

function entityKindProblem(kind: string, where: string): string | null {
  if (!Object.hasOwn(ENTITY_PARAM_NAMES, kind)) {
    return `${where} kind ${json(kind)} is not an entity kind; use one of ${ENTITY_KINDS}`
  }
  return null
}

function entityParamsProblem(kind: string, params: unknown[], where: string): string | null {
  const kindProblem = entityKindProblem(kind, where)
  if (kindProblem !== null) return kindProblem
  const names = ENTITY_PARAM_NAMES[kind as EntityKind]
  if (kind === 'fit_spline') {
    // Variable: `2N` fit points, `2 <= N <= 64`, no zero span. The handles are
    // not in `params`; the authoring `tangents` field carries them.
    if (params.length % 2 !== 0) {
      return `${where} fit_spline params are flat x/y fit points, so the count must be even, got ${params.length}`
    }
    const n = params.length / 2
    if (n < 2 || n > 64) {
      return `${where} fit_spline takes 2..64 fit points (2N params), got ${n} points`
    }
    for (let i = 0; i < params.length; i++) {
      if (!isFiniteNumber(params[i])) return `${where} fit_spline param ${i} must be a finite number, got ${json(params[i])}`
    }
    for (let i = 1; i < n; i++) {
      if (params[2 * i] === params[2 * i - 2] && params[2 * i + 1] === params[2 * i - 1]) {
        return `${where} fit_spline has coincident consecutive fit points ${i - 1},${i}`
      }
    }
    return null
  }
  const expected = ENTITY_BY_KIND.get(kind)?.paramCount ?? names.length
  const shape = `${where} ${kind} takes ${expected} params [${names.join(', ')}]`
  if (params.length !== expected) {
    return `${shape}, got ${params.length} (${json(params)})`
  }
  for (let i = 0; i < params.length; i++) {
    if (!isFiniteNumber(params[i])) {
      return `${where} ${kind} param ${i} (${names[i]}) must be a finite number, got ${json(params[i])}`
    }
  }
  if (kind === 'arc') {
    const [start, end] = [params[3] as number, params[4] as number]
    const span = Math.abs(end - start)
    if (span <= DEGENERATE_ARC_SPAN_DEG) {
      // No unit guessing: a degree value is simply taken as degrees. The hint
      // only fires when the pair is inside one turn in radians, the exact shape
      // of a radian value stored in a degree slot.
      const looksRadian = Math.abs(start) <= 2 * Math.PI && Math.abs(end) <= 2 * Math.PI
      const hint = looksRadian
        ? '; the pair looks like radians, but arc angles are degrees (a quarter turn is 90, a full turn 360)'
        : ''
      return `${where} ${kind} angles are degrees, and ${start} to ${end} spans ${span} degrees, so the arc has no extent${hint}`
    }
  }
  return null
}

function sketchOf(doc: PartDoc | null, featureId: string) {
  const feature = doc?.features?.find(f => f.id === featureId)
  return feature?.kind === 'sketch' ? feature : undefined
}

function entityIdProblem(raw: RawStep, ctx: ValueContext): string | null {
  const featureId = raw.featureId
  if (typeof featureId !== 'string') return null
  const entityId = raw.entityId
  if (entityId === undefined) return null
  if (typeof entityId !== 'string' || entityId.length === 0) {
    return `entityId must be a non-empty id string, got ${json(entityId)}`
  }
  const sketch = sketchOf(ctx.doc, featureId)
  if (sketch?.entities?.some(entity => entity.id === entityId)) {
    // mintEntityId takes a supplied id verbatim, so a duplicate would leave two
    // entities under one id and the document-boundary lookup would conflate them.
    return `entity id ${json(entityId)} already exists in sketch ${featureId}; a sketch cannot hold two entities with the same id, so pick a new id or delete the existing one first`
  }
  return null
}

// ─── ref values ───

// The schema's REF pattern only bans the sketch-local `$` sigil, because a ref
// may be a bare body id. The boundary can be a little stricter about what a
// reference looks like: empty, whitespace-carrying and single-axis-letter
// values are never refs, and refusing them here names the mistake instead of
// letting the solve report an unresolved pick later.
function refValueProblem(ref: string, label: string): string | null {
  if (ref.trim().length === 0) return `${label} must be a non-empty reference, got ${json(ref)}`
  if (/\s/.test(ref)) {
    return `${label} must be a reference without spaces, got ${json(ref)}`
  }
  if (ref.startsWith('$')) {
    return `${label} is a feature-level reference and never starts with "$"; use "@<featureId>/<elementId>" (for example "@sk1/<lineId>"), got ${json(ref)}`
  }
  if (/^[xyz]$/i.test(ref)) {
    return `${label} must be a query such as "@sk1/<lineId>", not the axis name ${json(ref)}; for a world axis use the direction vector field`
  }
  return null
}

function isRefSchema(schema: JsonSchema): boolean {
  return schema.type === 'string' && typeof schema.pattern === 'string'
}

function schemaAccepts(schema: JsonSchema, value: unknown): boolean {
  if (Array.isArray(schema.enum)) return (schema.enum as unknown[]).includes(value)
  if ('const' in schema) return value === schema.const
  if (typeof schema.type === 'string') {
    switch (schema.type) {
      case 'string': return typeof value === 'string'
      case 'number': return isFiniteNumber(value)
      case 'integer': return isFiniteNumber(value) && Number.isInteger(value)
      case 'boolean': return typeof value === 'boolean'
      case 'array': return Array.isArray(value)
      case 'object': return isRecord(value)
      default: return false
    }
  }
  return true
}

// A field value the schema could only hold as a plain string (a
// number-or-expression union) must carry something: an empty expression names
// nothing. Only a ref field reads "" as the documented clear, and only where
// EMPTY_REF_CLEARS admits it, so a blank never silently deletes a key or
// reverts a field to its default.
function blankStringProblem(value: unknown, schema: JsonSchema, label: string): string | null {
  if (value !== '' || isRefSchema(schema)) return null
  const acceptsPlainString = (candidate: JsonSchema): boolean => {
    if (candidate.type === 'string') return typeof candidate.pattern !== 'string'
    if (Array.isArray(candidate.enum) || 'const' in candidate) return false
    return Array.isArray(candidate.anyOf)
      && (candidate.anyOf as JsonSchema[]).some(acceptsPlainString)
  }
  if (!acceptsPlainString(schema)) return null
  return `${label} must be a value, not an empty string`
}

/** The schema check one authored field's value is held to. */
function fieldValueProblem(value: unknown, schema: JsonSchema, label: string): string | null {
  return blankStringProblem(value, schema, label) ?? schemaValueProblem(value, schema, label)
}

// Walk the schema for every ref it declares and apply the shape rule to each.
// Arrays recurse through items, REF_OR_LIST picks the branch the value's JSON
// type already selects, and object fields are walked by property name.
function refsInSchemaProblem(value: unknown, schema: JsonSchema, label: string): string | null {
  if (isRefSchema(schema)) {
    return typeof value === 'string' ? refValueProblem(value, label) : null
  }
  if (Array.isArray(schema.anyOf)) {
    const branches = schema.anyOf as JsonSchema[]
    const branch = branches.find(candidate => schemaAccepts(candidate, value)) ?? branches[0]
    if (branch === undefined) return null
    return refsInSchemaProblem(value, branch, label)
  }
  if (Array.isArray(value) && isRecord(schema.items)) {
    for (let i = 0; i < value.length; i++) {
      const problem = refsInSchemaProblem(value[i], schema.items, `${label}[${i}]`)
      if (problem !== null) return problem
    }
    return null
  }
  if (isRecord(value) && isRecord(schema.properties)) {
    for (const [key, property] of Object.entries(schema.properties)) {
      if (!(key in value) || !isRecord(property)) continue
      const problem = refsInSchemaProblem(value[key], property, `${label}.${key}`)
      if (problem !== null) return problem
    }
  }
  return null
}

// ─── schema subset validation ───

function describeSchema(schema: JsonSchema): string {
  if (Array.isArray(schema.enum)) {
    return `one of ${(schema.enum as unknown[]).map(entry => json(entry)).join(', ')}`
  }
  if ('const' in schema) return json(schema.const)
  if (typeof schema.type === 'string') {
    if (schema.type === 'string' && typeof schema.pattern === 'string') {
      return 'a reference string such as "@sk1/<lineId>"'
    }
    return schema.type === 'array' ? 'a list' : `a ${schema.type}`
  }
  if (Array.isArray(schema.anyOf)) {
    return (schema.anyOf as JsonSchema[]).map(describeSchema).join(' or ')
  }
  return 'a valid value'
}

/**
 * Validate a setter value against the schema definition of the field it names.
 * The subset covers every keyword the part-document schema uses for one
 * authored field: enum, const, type, pattern, anyOf, items, min/max items,
 * properties/required/additionalProperties and the numeric bounds. Null is the
 * documented clear and is handled by the caller, not here.
 */
export function schemaValueProblem(value: unknown, schema: JsonSchema, label: string): string | null {
  if (Array.isArray(schema.anyOf)) {
    const branches = schema.anyOf as JsonSchema[]
    const pass = branches.some(branch => schemaValueProblem(value, branch, label) === null)
    if (!pass) return `${label} must be ${describeSchema(schema)}, got ${json(value)}`
  }
  if (Array.isArray(schema.enum) && !(schema.enum as unknown[]).includes(value)) {
    return `${label} must be ${describeSchema(schema)}, got ${json(value)}`
  }
  if ('const' in schema && value !== schema.const) {
    return `${label} must be ${json(schema.const)}, got ${json(value)}`
  }
  if (typeof schema.type === 'string' && !schemaAccepts(schema, value)) {
    return `${label} must be ${describeSchema(schema)}, got ${json(value)}`
  }
  if (typeof value === 'string' && typeof schema.minLength === 'number' && value.length < schema.minLength) {
    return `${label} must have at least ${schema.minLength} characters, got ${json(value)}`
  }
  if (typeof value === 'number') {
    if (typeof schema.exclusiveMinimum === 'number' && !(value > schema.exclusiveMinimum)) {
      return `${label} must be greater than ${schema.exclusiveMinimum}, got ${json(value)}`
    }
    if (typeof schema.minimum === 'number' && !(value >= schema.minimum)) {
      return `${label} must be at least ${schema.minimum}, got ${json(value)}`
    }
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      return `${label} must have at least ${schema.minItems} entries, got ${value.length}`
    }
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      return `${label} must have at most ${schema.maxItems} entries, got ${value.length}`
    }
    if (isRecord(schema.items)) {
      for (let i = 0; i < value.length; i++) {
        const problem = schemaValueProblem(value[i], schema.items, `${label}[${i}]`)
        if (problem !== null) return problem
      }
    }
  }
  if (isRecord(value) && isRecord(schema.properties)) {
    const properties = schema.properties
    for (const [key, property] of Object.entries(properties)) {
      if (!(key in value) || !isRecord(property)) continue
      const problem = schemaValueProblem(value[key], property, `${label}.${key}`)
      if (problem !== null) return problem
    }
    if (Array.isArray(schema.required)) {
      for (const key of schema.required as string[]) {
        if (!(key in value)) return `${label}.${key} is required`
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) return `${label} has no field ${json(key)}`
      }
    }
  }
  // A pattern in this schema always marks a REF; the shared ref rule owns the
  // message so a `$` sigil or an empty string gets the accepted spelling rather
  // than a bare "does not match".
  return refsInSchemaProblem(value, schema, label)
}

// ─── individual rules ───

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(entry => typeof entry === 'string')
}

function nonEmptyStringsProblem(value: unknown, label: string): string | null {
  if (!isStringArray(value)) return `${label} must be a list of reference strings, got ${json(value)}`
  if (value.length === 0) return `${label} must name at least one reference, got an empty list`
  return stringListProblem(value, label)
}

// A pick list may legitimately start empty (the feature is added before its
// picks), but an entry in it is still a reference the applier would store.
function stringListProblem(value: unknown, label: string): string | null {
  if (!isStringArray(value)) return `${label} must be a list of reference strings, got ${json(value)}`
  for (let i = 0; i < value.length; i++) {
    const ref = value[i]
    if (ref.trim().length === 0) return `${label}[${i}] must be a non-empty reference, got ${json(ref)}`
  }
  return null
}

function finitePointProblem(value: unknown, label: string): string | null {
  if (!Array.isArray(value) || value.length !== 2 || !value.every(isFiniteNumber)) {
    return `${label} must be 2 finite numbers [x, y], got ${json(value)}`
  }
  return null
}

function positiveNumberProblem(value: unknown, label: string): string | null {
  if (!isFiniteNumber(value) || value <= 0) {
    return `${label} must be a finite positive number, got ${json(value)}`
  }
  return null
}

function nonNegativeIndexProblem(value: unknown, label: string): string | null {
  if (!isFiniteNumber(value) || !Number.isInteger(value) || value < 0) {
    return `${label} must be a non-negative integer index, got ${json(value)}`
  }
  return null
}

function sketchQueryProblem(value: unknown, field: string): string | null {
  if (typeof value !== 'string' || value.length === 0) {
    return `field "${field}" must name a sketch as "$<sketchId>" or "@<sketchId>", got ${json(value)}`
  }
  if (/\s/.test(value)) {
    return `field "${field}" must name a sketch without spaces, got ${json(value)}`
  }
  if (!value.startsWith('$') && !value.startsWith('@') && !value.startsWith('?')) {
    return `field "${field}" must name a sketch as "$<sketchId>" or "@<sketchId>", got ${json(value)}`
  }
  return null
}

function pickQueryProblem(value: unknown, field: string): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return `field "${field}" must be a non-empty query such as an ancestry string or a body id, got ${json(value)}`
  }
  if (/\s/.test(value)) {
    return `field "${field}" must be a query without spaces, got ${json(value)}`
  }
  return null
}

function unitIntervalProblem(value: unknown, label: string): string | null {
  if (!isFiniteNumber(value) || value < 0 || value > 1) {
    return `${label} must be a number between 0 and 1, got ${json(value)}`
  }
  return null
}

// ─── constraint targets ───

// Every target spelling the sketch mutation path understands. A bare name is
// not on the list on purpose: parseTarget would prefix it with `$` and persist
// a reference the caller never actually named (the rod_end "$a start" typo
// landed exactly that way).
const TARGET_FORMS: ReadonlyArray<{ prefix: string; parts: number | 'at-least'; label: string }> = [
  { prefix: 'entity:', parts: 3, label: 'entity:<sketchId>:<entityId>' },
  { prefix: 'vertex:', parts: 4, label: 'vertex:<sketchId>:<entityId>:<vertexKey>' },
  { prefix: 'dock:', parts: 3, label: 'dock:<sketchId>:<constraintId>' },
  { prefix: 'isect:', parts: 'at-least', label: 'isect:<sketchId>:<x>:<y>:<entityId>...' },
  { prefix: 'face:', parts: 'at-least', label: 'face:<featureId>:<query>' },
  { prefix: 'edge:', parts: 'at-least', label: 'edge:<featureId>:<query>' },
]

function targetProblem(value: unknown, index: number): string | null {
  if (typeof value !== 'string') return `target ${index} must be a reference string, got ${json(value)}`
  const accepted = `${TARGET_FORMS.map(form => `"${form.label}"`).join(', ')}, "@<query>", or "$<entityId>"`
  if (value.length === 0) return `target ${index} is empty; accepted forms: ${accepted}`
  if (/\s/.test(value)) {
    return `target ${index} ${json(value)} contains a space, which no reference spelling allows; accepted forms: ${accepted}`
  }
  if (value.startsWith('@') || value.startsWith('$')) return null
  for (const form of TARGET_FORMS) {
    if (!value.startsWith(form.prefix)) continue
    const parts = value.slice(form.prefix.length).split(':')
    const countOk = form.parts === 'at-least' ? parts.length >= 2 : parts.length === form.parts - 1
    if (!countOk || parts.some(part => part.length === 0)) {
      return `target ${index} ${json(value)} is a malformed ${form.label}; accepted forms: ${accepted}`
    }
    return null
  }
  return `target ${index} ${json(value)} names no recognised reference; accepted forms: ${accepted}`
}

// ─── specific rules ───

function moveEntity(raw: RawStep): ValueViolation | null {
  const problem = finitePointProblem(raw.delta, 'delta')
  return problem === null ? null : invalid(problem)
}

function resizeCircle(raw: RawStep, ctx: ValueContext): ValueViolation | null {
  const problem = positiveNumberProblem(raw.radius, 'radius')
  if (problem !== null) return invalid(problem)
  const featureId = raw.featureId
  const entityId = raw.entityId
  if (ctx.doc === null || typeof featureId !== 'string' || typeof entityId !== 'string') return null
  const sketch = sketchOf(ctx.doc, featureId)
  if (sketch === undefined) {
    return unknownTarget(`resize_circle names no sketch feature ${json(featureId)}`)
  }
  const entity = sketch.entities?.find(candidate => candidate.id === entityId)
  if (entity === undefined) {
    return unknownTarget(`resize_circle names no entity ${json(entityId)} in sketch ${featureId}`)
  }
  if (entity.kind !== 'circle') {
    return invalid(`resize_circle target ${json(entityId)} is a ${entity.kind}, not a circle`)
  }
  return null
}

function addConstraint(raw: RawStep): ValueViolation | null {
  const kind = raw.kind
  if (typeof kind === 'string' && !CONSTRAINT_BY_KIND.has(kind)) {
    return invalid(
      `constraint kind ${json(kind)} is not a sketch constraint; use one of ${[...CONSTRAINT_BY_KIND.keys()].join(', ')}`,
    )
  }
  const targets = raw.targets
  if (!Array.isArray(targets)) return invalid(`targets must be a list of references, got ${json(targets)}`)
  if (targets.length === 0) return invalid('targets must name at least one entity or vertex reference')
  for (let i = 0; i < targets.length; i++) {
    const problem = targetProblem(targets[i], i)
    if (problem !== null) return invalid(problem)
  }
  if (raw.pos !== undefined) {
    const problem = finitePointProblem(raw.pos, 'pos')
    if (problem !== null) return invalid(problem)
  }
  return null
}

function setConstraintPos(raw: RawStep): ValueViolation | null {
  const problem = finitePointProblem(raw.pos, 'pos')
  return problem === null ? null : invalid(problem)
}

const DELETE_FORMS =
  '"entity:<sketchId>:<entityId>", "vertex:<sketchId>:<entityId>:<vertexKey>" or "constraint:<sketchId>:<constraintId>"'

function deleteTargetProblem(value: unknown, index: number): string | null {
  if (typeof value !== 'string') return `delete target ${index} must be a reference string, got ${json(value)}`
  const parts = value.split(':')
  const kind = parts[0]
  if (kind !== 'entity' && kind !== 'vertex' && kind !== 'constraint') {
    const featureHint = value.startsWith('@') || value.length === 0 || value.includes(':') === false
      ? ' (features are deleted with delete_feature, not with a sketch target)'
      : ''
    return `delete target ${index} ${json(value)} is not a sketch target; use ${DELETE_FORMS}${featureHint}`
  }
  const expected = kind === 'vertex' ? 4 : 3
  if (parts.length !== expected || parts.slice(1).some(part => part.length === 0)) {
    return `delete target ${index} ${json(value)} is malformed; use ${DELETE_FORMS}`
  }
  return null
}

function deleteRule(raw: RawStep, ctx: ValueContext): ValueViolation | null {
  const targets = raw.targets
  if (!Array.isArray(targets)) return invalid(`targets must be a list of references, got ${json(targets)}`)
  if (targets.length === 0) return invalid('targets must name at least one id to delete')
  const parsed: Array<{ kind: string; featureId: string; id: string }> = []
  for (let i = 0; i < targets.length; i++) {
    const problem = deleteTargetProblem(targets[i], i)
    if (problem !== null) return invalid(problem)
    const parts = (targets[i] as string).split(':')
    parsed.push({ kind: parts[0], featureId: parts[1], id: parts[2] })
  }
  if (ctx.doc === null) return null
  // A target that matches nothing used to answer ok with an unchanged doc: the
  // caller could not tell it apart from a successful delete. The app's own
  // in-flight targets are always resolved against the doc it holds, so only an
  // external step reaches this with a stale or invented id.
  for (const target of parsed) {
    const sketch = sketchOf(ctx.doc, target.featureId)
    if (sketch === undefined) {
      return unknownTarget(`delete target names no sketch feature ${json(target.featureId)}`)
    }
    const exists = target.kind === 'constraint'
      ? (sketch.constraints ?? []).some(c => c.id === target.id)
      : (sketch.entities ?? []).some(e => e.id === target.id)
    if (!exists) {
      const what = target.kind === 'constraint' ? 'constraint' : 'entity'
      return unknownTarget(`delete target names no ${what} ${json(target.id)} in sketch ${target.featureId}`)
    }
  }
  return null
}

const TOGGLE_ENTITY_FORM = '"entity:<sketchId>:<entityId>"'

function toggleConstructionTargetProblem(value: unknown, index: number): string | null {
  if (typeof value !== 'string') {
    return `toggle_construction target ${index} must be a reference string, got ${json(value)}`
  }
  const parts = value.split(':')
  const accepted = `${TOGGLE_ENTITY_FORM} (the form \`select\` returns for a sketch entity)`
  if (parts[0] !== 'entity') {
    return `toggle_construction target ${index} ${json(value)} is not an entity ref; use ${accepted}`
  }
  if (parts.length !== 3 || parts[1] === '' || parts[2] === '') {
    return `toggle_construction target ${index} ${json(value)} is malformed; use ${accepted}`
  }
  return null
}

function toggleConstructionRule(raw: RawStep, ctx: ValueContext): ValueViolation | null {
  const targets = raw.targets
  if (!Array.isArray(targets)) return invalid(`targets must be a list of references, got ${json(targets)}`)
  if (targets.length === 0) return invalid('targets must name at least one sketch entity')
  const parsed: Array<{ featureId: string; id: string }> = []
  for (let i = 0; i < targets.length; i++) {
    const problem = toggleConstructionTargetProblem(targets[i], i)
    if (problem !== null) return invalid(problem)
    const parts = (targets[i] as string).split(':')
    parsed.push({ featureId: parts[1], id: parts[2] })
  }
  if (ctx.doc === null) return null
  // The applier skips a target whose sketch or entity is gone, which used to
  // read as a successful toggle that changed nothing.
  for (const target of parsed) {
    const sketch = sketchOf(ctx.doc, target.featureId)
    if (sketch === undefined) {
      return unknownTarget(`toggle_construction target names no sketch feature ${json(target.featureId)}`)
    }
    if (!(sketch.entities ?? []).some(entity => entity.id === target.id)) {
      return unknownTarget(
        `toggle_construction target names no entity ${json(target.id)} in sketch ${target.featureId}`,
      )
    }
  }
  return null
}

function addEntity(raw: RawStep, ctx: ValueContext): ValueViolation | null {
  const kind = raw.kind
  const params = raw.params
  if (typeof kind !== 'string') return invalid(`kind must be an entity kind string, got ${json(kind)}`)
  if (!Array.isArray(params)) return invalid(`params must be a list of numbers, got ${json(params)}`)
  const problem = entityParamsProblem(kind, params, 'add_entity')
  if (problem !== null) return invalid(problem)
  if (raw.tangents !== undefined) {
    if (kind !== 'fit_spline') return invalid(`tangents is only valid on a fit_spline, not ${json(kind)}`)
    const tangentProblem = fitTangentsProblem(raw.tangents)
    if (tangentProblem !== null) return invalid(tangentProblem)
  }
  if (raw.tangentScale !== undefined && typeof raw.tangentScale !== 'boolean') {
    return invalid(`tangentScale must be a boolean, got ${json(raw.tangentScale)}`)
  }
  const idProblem = entityIdProblem(raw, ctx)
  return idProblem === null ? null : invalid(idProblem)
}

function fitTangentsProblem(value: unknown): string | null {
  if (!Array.isArray(value) || value.length !== 2) {
    return `tangents must be [start, end], each [tx, ty] or null, got ${json(value)}`
  }
  for (let i = 0; i < 2; i++) {
    const t = value[i]
    if (t === null || t === undefined) continue
    if (!Array.isArray(t) || t.length !== 2 || !t.every(isFiniteNumber)) {
      return `tangents[${i}] must be [tx, ty] or null, got ${json(t)}`
    }
    if (t[0] === 0 && t[1] === 0) return `tangents[${i}] must not be a zero vector`
  }
  return null
}

function insertFitPoint(raw: RawStep): ValueViolation | null {
  if (typeof raw.entityId !== 'string' || raw.entityId.length === 0) return invalid('entityId must be a fit_spline entity id')
  if (!Number.isInteger(raw.index) || (raw.index as number) < 0) return invalid(`index must be a non-negative integer, got ${json(raw.index)}`)
  if (!Array.isArray(raw.point) || raw.point.length !== 2 || !raw.point.every(isFiniteNumber)) {
    return invalid(`point must be [x, y], got ${json(raw.point)}`)
  }
  return null
}

function setFitSplineHandle(raw: RawStep): ValueViolation | null {
  if (typeof raw.entityId !== 'string' || raw.entityId.length === 0) return invalid('entityId must be a fit_spline entity id')
  if (raw.end !== 'start' && raw.end !== 'end') return invalid(`end must be "start" or "end", got ${json(raw.end)}`)
  if (raw.handle === null) return null
  if (!Array.isArray(raw.handle) || raw.handle.length !== 2 || !raw.handle.every(isFiniteNumber)) {
    return invalid(`handle must be [x, y] or null, got ${json(raw.handle)}`)
  }
  return null
}

function addEntityWithConstraint(raw: RawStep, ctx: ValueContext): ValueViolation | null {
  const base = addEntity(raw, ctx)
  if (base !== null) return base
  const vertexKey = raw.vertexKey
  if (typeof vertexKey !== 'string' || vertexKey.length === 0) {
    return invalid(`vertexKey must name a vertex such as "start" or "xy", got ${json(vertexKey)}`)
  }
  const kind = raw.constraintKind
  if (typeof kind !== 'string' || !CONSTRAINT_BY_KIND.has(kind)) {
    return invalid(
      `constraintKind ${json(kind)} is not a sketch constraint; use one of ${[...CONSTRAINT_BY_KIND.keys()].join(', ')}`,
    )
  }
  for (const field of ['snapVertexId', 'snapEntityRef']) {
    const value = raw[field]
    if (value === undefined) continue
    const problem = targetProblem(value, 0)
    if (problem !== null) return invalid(`field "${field}": ${problem}`)
  }
  return null
}

function addProjectedEntity(raw: RawStep, ctx: ValueContext): ValueViolation | null {
  const kind = raw.kind
  if (typeof kind !== 'string') return invalid(`kind must be an entity kind string, got ${json(kind)}`)
  const kindProblem = entityKindProblem(kind, 'add_projected_entity')
  if (kindProblem !== null) return invalid(kindProblem)
  const source = raw.source
  const sourceProblem = pickQueryProblem(source, 'source')
  if (sourceProblem !== null) return invalid(sourceProblem)
  const idProblem = entityIdProblem(raw, ctx)
  return idProblem === null ? null : invalid(idProblem)
}

function addRect(raw: RawStep): ValueViolation | null {
  for (const field of ['p0', 'p1']) {
    const problem = finitePointProblem(raw[field], field)
    if (problem !== null) return invalid(problem)
  }
  return null
}

function addCenterRect(raw: RawStep): ValueViolation | null {
  for (const field of ['center', 'corner']) {
    const problem = finitePointProblem(raw[field], field)
    if (problem !== null) return invalid(problem)
  }
  return null
}

function addNgon(raw: RawStep): ValueViolation | null {
  const rectProblem = addCenterRect(raw)
  if (rectProblem !== null) return rectProblem
  const sides = raw.sides
  if (!isFiniteNumber(sides) || !Number.isInteger(sides) || sides < 3) {
    return invalid(`sides must be an integer of at least 3, got ${json(sides)}`)
  }
  return null
}

function applyOffset(raw: RawStep, ctx: ValueContext): ValueViolation | null {
  const sourceProblem = nonEmptyStringsProblem(raw.sourceIds, 'sourceIds')
  if (sourceProblem !== null) return invalid(sourceProblem)
  if (!isFiniteNumber(raw.distance)) {
    return invalid(`distance must be a finite number, got ${json(raw.distance)}`)
  }
  const featureId = raw.featureId
  if (ctx.doc === null || typeof featureId !== 'string') return null
  // A source id that names nothing used to answer ok with an unchanged document
  // and no created ids, which read like an offset that had run and produced no
  // geometry. The app's own offset always resolves ids from the selection it
  // holds, so only an external step reaches this with an invented or stale id.
  const sketch = sketchOf(ctx.doc, featureId)
  if (sketch === undefined) {
    return unknownTarget(`apply_offset names no sketch feature ${json(featureId)}`)
  }
  const entityIds = new Set((sketch.entities ?? []).map(entity => entity.id))
  for (const id of raw.sourceIds as string[]) {
    if (!entityIds.has(id)) {
      return unknownTarget(
        `apply_offset source id ${json(id)} names no entity in sketch ${featureId}; use a bare entity id from that sketch`,
      )
    }
  }
  return null
}

// The applier skips what it cannot mirror (the axis listed as a source, a
// projected entity, a degenerate axis); at the boundary each of those is a
// refusal naming the id, so an authored step never silently mirrors a subset.
function mirrorEntities(raw: RawStep, ctx: ValueContext): ValueViolation | null {
  const sourceProblem = nonEmptyStringsProblem(raw.sourceIds, 'sourceIds')
  if (sourceProblem !== null) return invalid(sourceProblem)
  if (typeof raw.line !== 'string') return invalid(`line must be an entity id string, got ${json(raw.line)}`)
  const featureId = raw.featureId
  if (ctx.doc === null || typeof featureId !== 'string') return null
  const sketch = sketchOf(ctx.doc, featureId)
  if (sketch === undefined) {
    return unknownTarget(`mirror_entities names no sketch feature ${json(featureId)}`)
  }
  const byId = new Map((sketch.entities ?? []).map(entity => [entity.id, entity]))
  const axis = byId.get(raw.line)
  if (axis === undefined) {
    return unknownTarget(
      `mirror_entities line ${json(raw.line)} names no entity in sketch ${featureId}; use a bare entity id from that sketch`,
    )
  }
  if (axis.kind !== 'line') {
    return invalid(`mirror_entities line ${json(raw.line)} names a ${json(axis.kind)}; the axis must be a line entity`)
  }
  if (mirrorAxisFromLineParams(sketch.initial?.[raw.line] ?? []) === null) {
    return invalid(`mirror_entities line ${json(raw.line)} has no usable axis: its params need two distinct finite points`)
  }
  for (const id of raw.sourceIds as string[]) {
    const entity = byId.get(id)
    if (entity === undefined) {
      return unknownTarget(
        `mirror_entities source id ${json(id)} names no entity in sketch ${featureId}; use a bare entity id from that sketch`,
      )
    }
    if (id === raw.line) {
      return invalid(`mirror_entities line ${json(raw.line)} must not also be a sourceId; the axis is not mirrored`)
    }
    if (entity.source !== undefined) {
      return invalid(
        `mirror_entities source id ${json(id)} names a projected entity; projected geometry re-projects from its source and is not mirrored`,
      )
    }
  }
  return null
}

// The bare builtin names resolveSketchPlane accepts. They stay case-sensitive:
// accepting "top" would shadow a user plane whose id is exactly that, so the
// boundary refuses an unmatched spelling with the valid names instead of
// spending a solve on a ref the kernel can only refuse.
const BARE_PLANE_NAMES = ['Front', 'Top', 'Right'] as const

function planeTargetProblem(value: string, ctx: ValueContext): string | null {
  // A face query is resolved through the repo after the solve; its predicates
  // cannot be checked here.
  if (value.startsWith('?')) return null
  const name = value.startsWith('@') ? value.slice(1) : value
  if (Object.hasOwn(BUILTIN_PLANES, name)) return null
  if (!value.startsWith('@') && resolveBarePlaneId(name) !== null) return null
  // Without a document only the builtin vocabulary is knowable; a custom plane
  // id may live in the document the caller did not pass.
  if (ctx.doc === null) return null
  const planeIds = (ctx.doc.features ?? [])
    .filter(feature => feature.kind === 'plane')
    .map(feature => String(feature.id))
  if (planeIds.includes(name)) return null
  const valid = [
    ...Object.keys(BUILTIN_PLANES).map(id => `@${id}`),
    ...BARE_PLANE_NAMES,
    ...planeIds
      .filter(id => !BARE_PLANE_NAMES.includes(id as typeof BARE_PLANE_NAMES[number]))
      .filter(id => !Object.hasOwn(BUILTIN_PLANES, id))
      .map(id => `@${id}`),
  ]
  return `plane ${json(value)} names no plane; use one of ${valid.join(', ')}, or a "?" face query from select `
    + '(bare builtin names are case-sensitive)'
}

// A `{selector}` pick is an authoring aid: the headless drive resolves it
// against the settled solve before this boundary runs, so an object that still
// reaches the value rules is on a surface with no solved body set (the browser
// bridge). Refuse it by name instead of storing the object in the document.
const UNRESOLVED_SELECTOR =
  'a {selector} pick needs the solved bodies; the headless drive resolves it before the step runs, '
  + 'so pass the query string `select` returned instead'

function selectorRefProblem(value: unknown, label: string): string | null {
  if (!isRecord(value)) return `${label} must be {selector: <a select selector>}, got ${json(value)}`
  const keys = Object.keys(value)
  if (keys.length !== 1 || !isRecord(value.selector)) {
    return `${label} must be {selector: <a select selector>} and carry nothing else, got ${json(value)}`
  }
  return `${label}: ${UNRESOLVED_SELECTOR}`
}

function planeRefProblem(plane: unknown, ctx: ValueContext): string | null {
  if (isRecord(plane)) return selectorRefProblem(plane, 'plane')
  if (typeof plane !== 'string' || plane.trim().length === 0) {
    return `plane must be a non-empty plane reference such as "@builtin_plane_front", got ${json(plane)}`
  }
  const problem = refValueProblem(plane, 'plane')
  if (problem !== null) return problem
  return planeTargetProblem(plane, ctx)
}

function setFeaturePlane(raw: RawStep, ctx: ValueContext): ValueViolation | null {
  const problem = planeRefProblem(raw.plane, ctx)
  return problem === null ? null : invalid(problem)
}

// A feature id an anchor field names must be in the document the step applies
// to; the refusal names it rather than letting the move silently do nothing.
function anchorProblem(raw: RawStep, key: string, ctx: ValueContext): string | null {
  const id = raw[key]
  if (typeof id !== 'string' || id.trim().length === 0) return `${key} must be a feature id, got ${json(id)}`
  if (ctx.doc !== null && !(ctx.doc.features ?? []).some(f => f.id === id)) {
    return `${key} names no feature: ${json(id)} is not in the document`
  }
  return null
}

function reorderFeatures(raw: RawStep, ctx: ValueContext): ValueViolation | null {
  const given = ['toIndex', 'before', 'after'].filter(key => raw[key] !== undefined)
  if (given.length !== 1) {
    return invalid(`give exactly one of toIndex, before or after, got ${given.length === 0 ? 'none' : given.join(', ')}`)
  }
  if (given[0] === 'toIndex') {
    const problem = nonNegativeIndexProblem(raw.toIndex, 'toIndex')
    return problem === null ? null : invalid(problem)
  }
  const problem = anchorProblem(raw, given[0], ctx)
  return problem === null ? null : invalid(problem)
}

function addPlane(raw: RawStep, ctx: ValueContext): ValueViolation | null {
  if (raw.before !== undefined) {
    const problem = anchorProblem(raw, 'before', ctx)
    if (problem !== null) return invalid(problem)
  }
  const definition = raw.definition
  if (definition === undefined) return null
  if (!isRecord(definition)) return invalid(`definition must be a plane definition object, got ${json(definition)}`)
  // PLANE_DEF is the same schema the saved document is held to, so a mode or
  // ref typo is refused here under the same names.
  const problem = schemaValueProblem(definition, planeDefinitionSchema(), 'definition')
  return problem === null ? null : invalid(problem)
}

function addSketch(raw: RawStep, ctx: ValueContext): ValueViolation | null {
  if (raw.plane === undefined) return null
  const problem = planeRefProblem(raw.plane, ctx)
  return problem === null ? null : invalid(problem)
}

// The fields a bulk add carries inline are checked against the same schema
// definition their `set_<kind>_field` setter uses, so the two spellings of one
// edit accept exactly the same values.
function inlineFieldsProblem(
  raw: RawStep,
  ctx: ValueContext,
  setter: Mutation['type'],
  keys: readonly string[],
): ValueViolation | null {
  for (const key of keys) {
    if (raw[key] === undefined) continue
    const schema = ctx.fieldSchema(setter, key)
    if (schema === null) continue
    const problem = fieldValueProblem(raw[key], schema, `${raw.type as string} field ${json(key)}`)
    if (problem !== null) return invalid(problem)
  }
  return null
}

// The ref fields an empty string clears, for the setter and its inline add in
// one row each. The applier deletes the key on "", but the shared ref rule
// refuses an empty string, so the boundary admits the clear only for the fields
// named here: each one is optional in its kind's schema (clearing a required ref
// would save a document the loader then refuses), and the rules test holds the
// list to that rule. A ref the caller still has to name (a hole sketch, a split
// plane, a revolve axis) keeps the refusal. Enum and number fields refuse an
// empty value too, so a blank never silently reverts a field to its default.
const UP_TO: ReadonlySet<string> = new Set(['up_to'])
const HOLE_TARGET: ReadonlySet<string> = new Set(['target'])
export const EMPTY_REF_CLEARS: Readonly<Record<string, ReadonlySet<string>>> = {
  add_extrude: UP_TO,
  set_extrude_field: UP_TO,
  add_hole: HOLE_TARGET,
  set_hole_field: HOLE_TARGET,
}

/** True when an empty string is the documented clear for this (mutation, field).
 *  A setter names the field in `field` and its value in `value`; an inline add
 *  carries the value under the field name, so both read one table. */
function clearsOnEmpty(type: Mutation['type'], field: unknown, value: unknown): boolean {
  return typeof field === 'string' && value === '' && (EMPTY_REF_CLEARS[type]?.has(field) ?? false)
}

function addExtrude(raw: RawStep, ctx: ValueContext): ValueViolation | null {
  const problem = sketchQueryProblem(raw.sketchQuery, 'sketchQuery')
  if (problem !== null) return invalid(problem)
  if (!isFiniteNumber(raw.distance)) return invalid(`distance must be a finite number, got ${json(raw.distance)}`)
  // Every remaining inline field follows the extrude schema, so a field added
  // there is validated here without a second hand-kept key list. sketchQuery
  // and distance are the two the explicit checks above own.
  for (const field of featureFieldNames('extrude')) {
    if (field === 'sketch' || field === 'distance') continue
    const value = raw[field]
    if (value === undefined || value === null) continue
    if (clearsOnEmpty(raw.type as Mutation['type'], field, value)) continue
    const schema = ctx.fieldSchema('set_extrude_field', field)
    if (schema === null) continue
    const fieldProblem = fieldValueProblem(value, schema, `add_extrude field ${json(field)}`)
    if (fieldProblem !== null) return invalid(fieldProblem)
  }
  return null
}

function addBoolean(raw: RawStep, ctx: ValueContext): ValueViolation | null {
  if (raw.tools !== undefined) {
    const toolsProblem = stringListProblem(raw.tools, 'tools')
    if (toolsProblem !== null) return invalid(toolsProblem)
  }
  return inlineFieldsProblem(raw, ctx, 'set_boolean_field', ['operation', 'target'])
}

// The array and mirror adds carry the same fields their setters set, so each
// present one is held to that field's schema definition, exactly like add_hole:
// an unknown enum spelling or a bad vector is refused at the boundary instead
// of stored and read back as a default.
function inlineFeatureFieldsProblem(
  raw: RawStep,
  ctx: ValueContext,
  kind: FeatureKind,
  setter: Mutation['type'],
): ValueViolation | null {
  for (const field of featureFieldNames(kind)) {
    const value = raw[field]
    // Null is the documented clear, and the applier writes no key for it on an
    // add (a circular array's step_angle is the field the union spells | null).
    if (value === undefined || value === null) continue
    const schema = ctx.fieldSchema(setter, field)
    if (schema === null) continue
    const problem = fieldValueProblem(value, schema, `${raw.type as string} field ${json(field)}`)
    if (problem !== null) return invalid(problem)
  }
  return null
}

function addArray(raw: RawStep, ctx: ValueContext): ValueViolation | null {
  return inlineFeatureFieldsProblem(raw, ctx, 'array', 'set_array_field')
}

function addCircularArray(raw: RawStep, ctx: ValueContext): ValueViolation | null {
  return inlineFeatureFieldsProblem(raw, ctx, 'circular_array', 'set_circular_array_field')
}

function addMirror(raw: RawStep, ctx: ValueContext): ValueViolation | null {
  return inlineFeatureFieldsProblem(raw, ctx, 'mirror', 'set_mirror_field')
}

function addRevolve(raw: RawStep): ValueViolation | null {
  const problem = sketchQueryProblem(raw.sketchQuery, 'sketchQuery')
  if (problem !== null) return invalid(problem)
  const angleProblem = positiveNumberProblem(raw.angle, 'angle (degrees)')
  if (angleProblem !== null) return invalid(angleProblem)
  // The axis is a stored pick, not a default, so a malformed ref used to reach
  // the solver and fail there. Refuse it at the boundary with the accepted form.
  const axis = raw.axis
  if (typeof axis !== 'string' || axis.trim().length === 0) {
    return invalid(
      'axis must be a non-empty pick such as "@<sketchId>/<entityId>" or an edge query from `select`, '
      + 'got ' + json(axis),
    )
  }
  const axisProblem = refValueProblem(axis, 'axis')
  return axisProblem === null ? null : invalid(axisProblem)
}

function addSweep(raw: RawStep): ValueViolation | null {
  const sketchProblem = sketchQueryProblem(raw.sketchQuery, 'sketchQuery')
  if (sketchProblem !== null) return invalid(sketchProblem)
  const pathProblem = sketchQueryProblem(raw.pathQuery, 'pathQuery')
  return pathProblem === null ? null : invalid(pathProblem)
}

function addImportStep(raw: RawStep): ValueViolation | null {
  const fileId = raw.fileId
  if (typeof fileId !== 'string' || fileId.trim().length === 0) {
    return invalid(`fileId must be a non-empty files registry id, got ${json(fileId)}`)
  }
  return null
}

function addFillet(raw: RawStep): ValueViolation | null {
  if (raw.edges !== undefined) {
    const edgesProblem = stringListProblem(raw.edges, 'edges')
    if (edgesProblem !== null) return invalid(edgesProblem)
  }
  const radius = raw.radius
  if (radius === undefined) return null
  if (typeof radius === 'string') {
    if (radius.trim().length === 0) {
      return invalid(`radius must be a positive number or a non-empty expression string, got ${json(radius)}`)
    }
    return null
  }
  const radiusProblem = positiveNumberProblem(radius, 'radius')
  return radiusProblem === null ? null : invalid(radiusProblem)
}

// A number-or-expression field a bulk add carries: the number is a positive
// magnitude, the string is a non-empty expression resolved after the solve.
function positiveScalarProblem(value: unknown, label: string): string | null {
  if (typeof value === 'string') {
    return value.trim().length === 0
      ? `${label} must be a positive number or a non-empty expression string, got ${json(value)}`
      : null
  }
  return positiveNumberProblem(value, label)
}

function addChamfer(raw: RawStep): ValueViolation | null {
  if (raw.edges !== undefined) {
    const edgesProblem = stringListProblem(raw.edges, 'edges')
    if (edgesProblem !== null) return invalid(edgesProblem)
  }
  if (raw.distance !== undefined) {
    const distanceProblem = positiveScalarProblem(raw.distance, 'distance')
    if (distanceProblem !== null) return invalid(distanceProblem)
  }
  return null
}

// Each shell face entry is a query string or a selector the drive resolves. A
// string is checked like any other reference list; a selector that survives to
// here is on a surface with no solved bodies, so name that.
function facePickListProblem(value: unknown, label: string): string | null {
  if (!Array.isArray(value)) {
    return `${label} must be a list of face queries or {selector} entries, got ${json(value)}`
  }
  for (let i = 0; i < value.length; i++) {
    const entry = value[i]
    if (isRecord(entry)) {
      const problem = selectorRefProblem(entry, `${label}[${i}]`)
      if (problem !== null) return problem
      continue
    }
    if (typeof entry !== 'string') {
      return `${label}[${i}] must be a face query or {selector: <a select selector>}, got ${json(entry)}`
    }
    if (entry.trim().length === 0) return `${label}[${i}] must be a non-empty reference, got ${json(entry)}`
  }
  return null
}

function addShell(raw: RawStep): ValueViolation | null {
  if (raw.faces !== undefined) {
    const facesProblem = facePickListProblem(raw.faces, 'faces')
    if (facesProblem !== null) return invalid(facesProblem)
  }
  if (raw.thickness !== undefined) {
    const thicknessProblem = positiveScalarProblem(raw.thickness, 'thickness')
    if (thicknessProblem !== null) return invalid(thicknessProblem)
  }
  if (raw.direction !== undefined && raw.direction !== 'inward' && raw.direction !== 'outward') {
    return invalid(`direction must be "inward" or "outward", got ${json(raw.direction)}`)
  }
  return null
}

function addDeleteFace(raw: RawStep): ValueViolation | null {
  if (raw.faces === undefined) return null
  const problem = stringListProblem(raw.faces, 'faces')
  return problem === null ? null : invalid(problem)
}

function addDeleteBody(raw: RawStep): ValueViolation | null {
  if (raw.bodies === undefined) return null
  const problem = stringListProblem(raw.bodies, 'bodies')
  return problem === null ? null : invalid(problem)
}

function addHelix(raw: RawStep): ValueViolation | null {
  const reference = raw.reference
  if (reference === undefined) return null
  if (typeof reference !== 'string') return invalid(`reference must be a reference string, got ${json(reference)}`)
  const problem = refValueProblem(reference, 'reference')
  return problem === null ? null : invalid(problem)
}

// `add_hole` carries the same fields a setter sets, so each present one is held
// to that field's schema definition: an unknown enum spelling (a `style` typo)
// is refused here, at the boundary, rather than solved into a silent fallback.
function addHole(raw: RawStep, ctx: ValueContext): ValueViolation | null {
  for (const field of featureFieldNames('hole')) {
    const value = raw[field]
    if (value === undefined) continue
    if (clearsOnEmpty(raw.type as Mutation['type'], field, value)) continue
    const schema = ctx.fieldSchema('set_hole_field', field)
    if (schema === null) continue
    const problem = fieldValueProblem(value, schema, `add_hole field ${json(field)}`)
    if (problem !== null) return invalid(problem)
  }
  return null
}

// A split's inline fields: `bodies` is a pick list, `plane` goes through the
// same target vocabulary `set_feature_plane`/`add_sketch` accept, and `keep` is
// one of the three side names. Each refusal names the accepted values, because
// "top" and "bottom" are the spellings an author brings from CadQuery.
const SPLIT_KEEPS = ['above', 'below', 'both'] as const

function splitPlaneProblem(plane: unknown, ctx: ValueContext): string | null {
  if (typeof plane !== 'string' || plane.trim().length === 0) {
    return `plane must be a non-empty plane reference such as "@builtin_plane_top", got ${json(plane)}`
  }
  const shapeProblem = refValueProblem(plane, 'plane')
  return shapeProblem ?? planeTargetProblem(plane, ctx)
}

function splitKeepProblem(keep: unknown): string | null {
  if (typeof keep === 'string' && (SPLIT_KEEPS as readonly string[]).includes(keep)) return null
  return `keep must be one of ${SPLIT_KEEPS.map(k => `"${k}"`).join(', ')}, got ${json(keep)}`
}

function addSplit(raw: RawStep, ctx: ValueContext): ValueViolation | null {
  if (raw.bodies !== undefined) {
    const problem = stringListProblem(raw.bodies, 'bodies')
    if (problem !== null) return invalid(problem)
  }
  if (raw.plane !== undefined) {
    const problem = splitPlaneProblem(raw.plane, ctx)
    if (problem !== null) return invalid(problem)
  }
  if (raw.keep !== undefined) {
    const problem = splitKeepProblem(raw.keep)
    if (problem !== null) return invalid(problem)
  }
  return null
}

// The generic setter check holds `keep` to its schema enum; `plane` needs the
// target vocabulary on top, because the schema only knows it is a ref.
function setSplitField(raw: RawStep, ctx: ValueContext): ValueViolation | null {
  const generic = fieldValue(raw, ctx)
  if (generic !== null) return generic
  if (raw.field === 'plane' && raw.value !== null && raw.value !== undefined) {
    const problem = splitPlaneProblem(raw.value, ctx)
    if (problem !== null) return invalid(problem)
  }
  return null
}

function renamePart(raw: RawStep): ValueViolation | null {
  const name = raw.name
  if (typeof name !== 'string' || name.trim().length === 0) {
    return invalid(`name must be a non-empty body name, got ${json(name)}`)
  }
  return null
}

function setPartColor(raw: RawStep): ValueViolation | null {
  const color = raw.color
  if (typeof color !== 'string' || color.trim().length === 0) {
    return invalid(`color must be a non-empty CSS colour string, got ${json(color)}`)
  }
  return null
}

function unitInterval(field: string) {
  return (raw: RawStep): ValueViolation | null => {
    const problem = unitIntervalProblem(raw[field], field)
    return problem === null ? null : invalid(problem)
  }
}

function queryField(field: string) {
  return (raw: RawStep): ValueViolation | null => {
    const problem = pickQueryProblem(raw[field], field)
    return problem === null ? null : invalid(problem)
  }
}

function indexField(field: string) {
  return (raw: RawStep): ValueViolation | null => {
    const problem = nonNegativeIndexProblem(raw[field], field)
    return problem === null ? null : invalid(problem)
  }
}

function reorderPickField(raw: RawStep): ValueViolation | null {
  const field = raw.field
  if (typeof field !== 'string' || field.length === 0) {
    return invalid(`field must name a pick field, got ${json(field)}`)
  }
  for (const key of ['fromIndex', 'toIndex']) {
    const problem = nonNegativeIndexProblem(raw[key], key)
    if (problem !== null) return invalid(problem)
  }
  return null
}

function isFieldSetterRule(type: string): boolean {
  return type.startsWith('set_') && type.endsWith('_field')
}

// A setter's value follows the schema of the field it names. The catalog has
// already refused an unknown field name; this refuses a value the field's own
// definition does not accept (an enum spelling, a `$` ref, an empty ref). Null
// stays the documented clear and skips the check.
function fieldValue(raw: RawStep, ctx: ValueContext): ValueViolation | null {
  const type = raw.type as Mutation['type']
  const field = raw.field
  if (typeof field !== 'string' || raw.value === null || raw.value === undefined) return null
  if (!isFieldSetterRule(type)) return null
  const schema = ctx.fieldSchema(type, field)
  if (schema === null) return null
  const problem = fieldValueProblem(raw.value, schema, `${type} field ${json(field)}`)
  return problem === null ? null : invalid(problem)
}

// `up_to` and a hole's `target` are the two refs with a natural empty clear;
// EMPTY_REF_CLEARS says which, and every other field takes the schema check.
function setExtrudeField(raw: RawStep, ctx: ValueContext): ValueViolation | null {
  if (clearsOnEmpty(raw.type as Mutation['type'], raw.field as string, raw.value)) return null
  return fieldValue(raw, ctx)
}

// A hole's `target` is a pick the solve can derive instead: with no target the
// hole drills the body its drill sites sit on, so an empty string is the clear
// the note promises rather than a refused reference.
function setHoleField(raw: RawStep, ctx: ValueContext): ValueViolation | null {
  if (clearsOnEmpty(raw.type as Mutation['type'], raw.field as string, raw.value)) return null
  return fieldValue(raw, ctx)
}

// The revolve angle is the one numeric field whose semantic range the schema
// cannot express with the shared number-or-expression union: a non-positive
// angle builds no solid. Applied on top of the generic field check.
function setRevolveField(raw: RawStep, ctx: ValueContext): ValueViolation | null {
  const generic = fieldValue(raw, ctx)
  if (generic !== null) return generic
  if (raw.field === 'angle' && typeof raw.value === 'number' && raw.value <= 0) {
    return invalid(`set_revolve_field angle is in degrees and must be positive, got ${json(raw.value)}`)
  }
  return null
}

// ─── the table ───

// One row per mutation type, so a new type cannot be added without deciding
// what its values may be. 'none' means the applier takes whatever value the
// catalog's type check admits (a plain flag, a label, an internal marker).
export const MUTATION_VALUE_RULES = {
  move_vertex: 'none',
  move_vertex_with_constraint: 'none',
  move_entity: moveEntity,
  resize_circle: resizeCircle,
  add_constraint: addConstraint,
  set_constraint_value: 'none',
  set_constraint_pos: setConstraintPos,
  set_constraint_sign: 'none',
  delete: deleteRule,
  add_entity: addEntity,
  add_entity_with_constraint: addEntityWithConstraint,
  insert_fit_point: insertFitPoint,
  set_fit_spline_handle: setFitSplineHandle,
  add_projected_entity: addProjectedEntity,
  add_rect: addRect,
  add_center_rect: addCenterRect,
  add_ngon: addNgon,
  apply_offset: applyOffset,
  mirror_entities: mirrorEntities,
  toggle_construction: toggleConstructionRule,
  set_feature_plane: setFeaturePlane,
  add_sketch: addSketch,
  add_fillet: addFillet,
  delete_feature: 'none',
  set_feature_visibility: 'none',
  add_plane: addPlane,
  set_plane_definition_field: fieldValue,
  rename_feature: 'none',
  toggle_sketch_plane_visibility: 'none',
  toggle_plane_visibility: 'none',
  add_extrude: addExtrude,
  set_extrude_field: setExtrudeField,
  add_extrude_profile: queryField('sketchQuery'),
  remove_extrude_profile: indexField('index'),
  add_revolve: addRevolve,
  set_revolve_field: setRevolveField,
  add_revolve_profile: queryField('sketchQuery'),
  remove_revolve_profile: indexField('index'),
  add_sweep: addSweep,
  set_sweep_field: fieldValue,
  add_sweep_profile: queryField('sketchQuery'),
  remove_sweep_profile: indexField('index'),
  add_sweep_path: queryField('pathQuery'),
  remove_sweep_path: indexField('index'),
  add_import_step: addImportStep,
  add_chamfer: addChamfer,
  set_fillet_field: fieldValue,
  set_chamfer_field: fieldValue,
  add_fillet_edge: queryField('edgeQuery'),
  remove_fillet_edge: indexField('index'),
  add_chamfer_edge: queryField('edgeQuery'),
  remove_chamfer_edge: indexField('index'),
  add_shell: addShell,
  set_shell_field: fieldValue,
  add_shell_face: queryField('faceQuery'),
  remove_shell_face: indexField('index'),
  add_move_face: 'none',
  set_move_face_field: fieldValue,
  add_move_face_ref: queryField('faceQuery'),
  remove_move_face_ref: indexField('index'),
  add_delete_face: addDeleteFace,
  add_delete_face_ref: queryField('faceQuery'),
  remove_delete_face_ref: indexField('index'),
  add_boolean: addBoolean,
  set_boolean_field: fieldValue,
  add_boolean_tool: queryField('tool'),
  remove_boolean_tool: queryField('tool'),
  add_array: addArray,
  set_array_field: fieldValue,
  add_circular_array: addCircularArray,
  set_circular_array_field: fieldValue,
  add_delete_body: addDeleteBody,
  add_delete_body_ref: queryField('bodyQuery'),
  remove_delete_body_ref: indexField('index'),
  add_hole: addHole,
  set_hole_field: setHoleField,
  add_transform: 'none',
  set_transform_field: fieldValue,
  add_transform_body: queryField('bodyQuery'),
  remove_transform_body: indexField('index'),
  rename_part: renamePart,
  set_part_color: setPartColor,
  set_part_transparency: unitInterval('transparency'),
  set_part_metalness: unitInterval('metalness'),
  set_part_roughness: unitInterval('roughness'),
  set_part_transmission: unitInterval('transmission'),
  add_mirror: addMirror,
  set_mirror_field: fieldValue,
  add_split: addSplit,
  set_split_field: setSplitField,
  add_split_body: queryField('bodyQuery'),
  remove_split_body: indexField('index'),
  add_variable: 'none',
  set_variable_field: fieldValue,
  add_helix: addHelix,
  set_helix_field: fieldValue,
  reorder_features: reorderFeatures,
  set_body_visibility: 'none',
  reorder_pick_field: reorderPickField,
  set_feature_suppression: 'none',
  set_rollback: 'none',
  edit_session: 'none',
  preview_commit: 'none',
  remove_dangling_content: 'none',
} satisfies { [K in Mutation['type']]: ValueRule }

/** Run the table row for a mutation type. Null when the value passes. */
export function mutationValueViolation(
  type: Mutation['type'],
  raw: RawStep,
  ctx: ValueContext,
): ValueViolation | null {
  const rule = MUTATION_VALUE_RULES[type] as ValueRule
  return rule === 'none' ? null : rule(raw, ctx)
}
