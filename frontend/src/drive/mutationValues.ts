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

import type { EntityKind, Mutation, PartDoc } from '@/types/cad'
import { ENTITY_BY_KIND } from '@/registry/entityRegistry'
import { CONSTRAINT_BY_KIND } from '@/registry/constraintRegistry'
import { BUILTIN_PLANES, resolveBarePlaneId } from '@/kernel/solverConstants'
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
  const idProblem = entityIdProblem(raw, ctx)
  return idProblem === null ? null : invalid(idProblem)
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

// The bare builtin names resolveSketchPlane accepts. They stay case-sensitive:
// accepting "top" would shadow a user plane whose id is exactly that, so the
// boundary refuses an unmatched spelling with the valid names instead of
// letting resolveSketchPlane's front-plane fallback hide the mistake.
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

function setFeaturePlane(raw: RawStep, ctx: ValueContext): ValueViolation | null {
  const plane = raw.plane
  if (typeof plane !== 'string' || plane.trim().length === 0) {
    return invalid(`plane must be a non-empty plane reference such as "@builtin_plane_front", got ${json(plane)}`)
  }
  const problem = refValueProblem(plane, 'plane')
  if (problem !== null) return invalid(problem)
  const targetProblem = planeTargetProblem(plane, ctx)
  return targetProblem === null ? null : invalid(targetProblem)
}

function addPlane(raw: RawStep): ValueViolation | null {
  const definition = raw.definition
  if (definition === undefined) return null
  if (!isRecord(definition)) return invalid(`definition must be a plane definition object, got ${json(definition)}`)
  // PLANE_DEF is the same schema the saved document is held to, so a mode or
  // ref typo is refused here under the same names.
  const problem = schemaValueProblem(definition, planeDefinitionSchema(), 'definition')
  return problem === null ? null : invalid(problem)
}

function addSketch(raw: RawStep, ctx: ValueContext): ValueViolation | null {
  const plane = raw.plane
  if (plane === undefined) return null
  if (typeof plane !== 'string' || plane.trim().length === 0) {
    return invalid(`plane must be a non-empty plane reference such as "@builtin_plane_front", got ${json(plane)}`)
  }
  const problem = refValueProblem(plane, 'plane')
  if (problem !== null) return invalid(problem)
  const targetProblem = planeTargetProblem(plane, ctx)
  return targetProblem === null ? null : invalid(targetProblem)
}

function addExtrude(raw: RawStep): ValueViolation | null {
  const problem = sketchQueryProblem(raw.sketchQuery, 'sketchQuery')
  if (problem !== null) return invalid(problem)
  if (!isFiniteNumber(raw.distance)) return invalid(`distance must be a finite number, got ${json(raw.distance)}`)
  return null
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
    const schema = ctx.fieldSchema('set_hole_field', field)
    if (schema === null) continue
    const problem = schemaValueProblem(value, schema, `add_hole field ${json(field)}`)
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
  const problem = schemaValueProblem(raw.value, schema, `${type} field ${json(field)}`)
  return problem === null ? null : invalid(problem)
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
  add_projected_entity: addProjectedEntity,
  add_rect: addRect,
  add_center_rect: addCenterRect,
  add_ngon: addNgon,
  apply_offset: applyOffset,
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
  set_extrude_field: fieldValue,
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
  add_chamfer: 'none',
  set_fillet_field: fieldValue,
  set_chamfer_field: fieldValue,
  add_fillet_edge: queryField('edgeQuery'),
  remove_fillet_edge: indexField('index'),
  add_chamfer_edge: queryField('edgeQuery'),
  remove_chamfer_edge: indexField('index'),
  add_shell: 'none',
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
  add_boolean: 'none',
  set_boolean_field: fieldValue,
  add_boolean_tool: queryField('tool'),
  remove_boolean_tool: queryField('tool'),
  add_array: 'none',
  set_array_field: fieldValue,
  add_circular_array: 'none',
  set_circular_array_field: fieldValue,
  add_delete_body: addDeleteBody,
  add_delete_body_ref: queryField('bodyQuery'),
  remove_delete_body_ref: indexField('index'),
  add_hole: addHole,
  set_hole_field: fieldValue,
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
  add_mirror: 'none',
  set_mirror_field: fieldValue,
  add_variable: 'none',
  set_variable_field: fieldValue,
  add_helix: addHelix,
  set_helix_field: fieldValue,
  reorder_features: indexField('toIndex'),
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
