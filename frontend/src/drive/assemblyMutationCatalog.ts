// The assembly drive vocabulary: the operation table spelled for the wire.
//
// Every assembly mutation an agent sends is `{ type: <wire name>, ... }`, mapped
// one-to-one onto ASSEMBLY_OPERATIONS (D9). The mapped type below makes a new
// operation without a catalog row fail `tsc -b`; the runtime validator refuses a
// typo, a missing field, a wrong value and a ref the build cannot resolve, so a
// step is one named outcome instead of a silent no-op.
//
// The wire fields are deliberately flatter than the operation inputs: a script
// authors `position: [x,y,z]` and the validator builds the Transform3D, and a
// mate's refs are drive refs (part-local picks) that the resolver turns into the
// stored {part, anchor, anchor_descriptor} triple (D4).

import type { AssemblyDoc, MateKind, MateRef, MateRefField } from '@/types/cad'
import type { AssemblyOperationId, AssemblyOperationInputs } from '@/utils/assemblyOperations'
import { ASSEMBLY_HANDLE } from '@/utils/assemblyBuiltins'
import { findInstance, findMate } from '@/utils/assemblyMutations'
import { MATE_KINDS, MATE_KIND_LABELS, mateParams } from '@/utils/mateKinds'
import { quatFromEulerXyz } from '@/utils/transform3d'
import type { MateParamPatch } from '@/utils/assemblyMutations'
import type { DriveMateRef, ResolvedDriveRef } from '@/drive/assemblyRefs'

export type Vec3Tuple = [number, number, number]

/** A mate offset as a script writes it: a scalar or a partial vector. */
export type DriveMateOffset = number | { x?: number; y?: number; z?: number }

/**
 * The wire mutation union. The typecheck file compares each member's field
 * names, optionality and nullability with its catalog row, so the two cannot
 * drift.
 */
export type AssemblyWireMutation =
  | { type: 'add_part'; handle: string; part: string; position?: Vec3Tuple; rotation?: Vec3Tuple; fixed?: boolean }
  | { type: 'duplicate_part'; handle: string; newHandle: string }
  | { type: 'delete_part'; handle: string }
  | { type: 'set_part_position'; handle: string; position: Vec3Tuple }
  | { type: 'set_part_rotation'; handle: string; rotation: Vec3Tuple }
  | { type: 'set_part_fixed'; handle: string; fixed: boolean }
  | { type: 'set_part_visible'; handle: string; visible: boolean }
  | { type: 'set_builtin_visible'; id: string; visible: boolean }
  | {
    type: 'add_mate'
    featureId: string
    kind: MateKind
    label?: string
    ref_a: DriveMateRef
    ref_b: DriveMateRef
    flip?: boolean
    offset?: DriveMateOffset
    angle?: number
    radius?: number
    ratio?: number
  }
  | { type: 'set_mate_ref'; featureId: string; field: MateRefField; ref: DriveMateRef }
  | {
    type: 'update_mate'
    featureId: string
    flip?: boolean | null
    offset?: DriveMateOffset | null
    angle?: number | null
    radius?: number | null
    ratio?: number | null
  }
  | { type: 'rename_mate'; featureId: string; label: string }
  | { type: 'delete_mate'; featureId: string }
  | { type: 'reorder_part'; handle: string; before: string | null }
  | { type: 'reorder_mate'; featureId: string; before: string | null }

export type AssemblyWireType = AssemblyWireMutation['type']

/** The one row where the wire spelling and the operation id differ: the drive
 *  exposes the structural one-shot toggle, never the fold twin. */
export const ASSEMBLY_OPERATION_BY_MUTATION: Readonly<Record<AssemblyWireType, AssemblyOperationId>> = {
  add_part: 'add_part',
  duplicate_part: 'duplicate_part',
  delete_part: 'delete_part',
  set_part_position: 'set_part_position',
  set_part_rotation: 'set_part_rotation',
  set_part_fixed: 'set_part_fixed_oneshot',
  set_part_visible: 'set_part_visible',
  set_builtin_visible: 'set_builtin_visible',
  add_mate: 'add_mate',
  set_mate_ref: 'set_mate_ref',
  update_mate: 'update_mate',
  rename_mate: 'rename_mate',
  delete_mate: 'delete_mate',
  reorder_part: 'reorder_part',
  reorder_mate: 'reorder_mate',
}

export type AssemblyFieldType = 'string' | 'number' | 'boolean' | 'vec3' | 'object' | 'ref' | 'offset'

export interface AssemblyFieldInfo {
  type: AssemblyFieldType
  required: boolean
  nullable?: boolean
  note?: string
}

export interface AssemblyMutationInfo {
  summary: string
  fields: Record<string, AssemblyFieldInfo>
  note?: string
}

export type AssemblyMutationFamily = 'parts' | 'mates'

const str = (note?: string) => ({ type: 'string', required: true, ...(note !== undefined && { note }) } as const)
const optStr = (note?: string) => ({ type: 'string', required: false, ...(note !== undefined && { note }) } as const)
const nullableStr = () => ({ type: 'string', required: true, nullable: true } as const)
const optNum = (note?: string) => ({ type: 'number', required: false, ...(note !== undefined && { note }) } as const)
const nullableNum = () => ({ type: 'number', required: false, nullable: true } as const)
const bool = () => ({ type: 'boolean', required: true } as const)
const optBool = () => ({ type: 'boolean', required: false } as const)
const nullableBool = () => ({ type: 'boolean', required: false, nullable: true } as const)
const vec3 = (note: string) => ({ type: 'vec3', required: true, note } as const)
const optVec3 = (note: string) => ({ type: 'vec3', required: false, note } as const)
const ref = (note: string) => ({ type: 'ref', required: true, note } as const)
const OFFSET_NOTE = 'A number along A\'s anchor axis, or a partial {x,y,z} in body A\'s local frame.'
const offsetOptional = () => ({ type: 'offset', required: false, note: OFFSET_NOTE } as const)
const offsetNullable = () => ({ type: 'offset', required: false, nullable: true, note: OFFSET_NOTE } as const)

const POSITION_NOTE = '[x, y, z] in mm, in the assembly frame.'
const ROTATION_NOTE = '[rx, ry, rz] in degrees, extrinsic XYZ (the editor\'s RX/RY/RZ boxes).'

const REF_NOTE =
  'A part-local pick: {part: <instance handle>, query: <a query `select` returned>}, '
  + '{part: <handle>, selector: <a select selector naming exactly one entity>}, '
  + '{part: <handle>, anchor: <anchor id>}, or the assembly frame {part: "__assembly", anchor: "AssemblyTop"} '
  + '(AssemblyOrigin, AssemblyTop, AssemblyFront, AssemblyRight). The selector is an authoring aid and is never stored.'

const MATE_PARAM_NOTE =
  'Only the parameters the kind reads are accepted (see mateParams): fixed reads offset, flip, angle; '
  + 'sliding reads flip, angle; rotating and sliding_rotating read flip; spherical reads none; parallel reads flip; '
  + 'parallel_plane_distance reads offset, flip; tangential reads offset, radius; copy_rotation reads ratio. '
  + 'face-to-face contact between two outward normals needs flip: true. Absent means the default '
  + '(parallel axes, canonical zero roll); there is no on-screen pose to capture headlessly (D5).'

export const ASSEMBLY_MUTATION_CATALOG = {
  add_part: {
    summary: 'Place a bound part document as an instance with an explicit handle.',
    note: '`part` is a doc_id the run call bound; the feature id is derived as `inst_<handle>`. '
      + '`doc_rev` is recorded as 0: the headless binding has no revision. ' + POSITION_NOTE + ' ' + ROTATION_NOTE,
    fields: {
      handle: str('The instance handle, unique in this assembly and never "__assembly".'),
      part: str('The bound part doc_id, for example rail_400.'),
      position: optVec3(POSITION_NOTE),
      rotation: optVec3(ROTATION_NOTE),
      fixed: optBool(),
    },
  },
  duplicate_part: {
    summary: 'Copy an instance onto an explicit new handle.',
    fields: {
      handle: str('The instance to copy.'),
      newHandle: str('The copy\'s handle; the feature id is derived as `inst_<newHandle>`.'),
    },
  },
  delete_part: {
    summary: 'Delete a part instance. Mates that referenced it surface as stale.',
    fields: { handle: str() },
  },
  set_part_position: {
    summary: 'Move a part instance to an authored translation.',
    fields: { handle: str(), position: vec3(POSITION_NOTE) },
  },
  set_part_rotation: {
    summary: 'Orient a part instance from an authored Euler triple.',
    fields: { handle: str(), rotation: vec3(ROTATION_NOTE) },
  },
  set_part_fixed: {
    summary: 'Fix or unfix a part instance (the structural one-shot toggle).',
    fields: { handle: str(), fixed: bool() },
  },
  set_part_visible: {
    summary: 'Show or hide a part instance.',
    fields: { handle: str(), visible: bool() },
  },
  set_builtin_visible: {
    summary: 'Show or hide one of the assembly\'s own origin or plane features.',
    fields: { id: str('AssemblyOrigin, AssemblyTop, AssemblyFront or AssemblyRight.'), visible: bool() },
  },
  add_mate: {
    summary: 'Add a complete mate (both refs, parameters and an optional label) as one step.',
    note: REF_NOTE + ' ' + MATE_PARAM_NOTE,
    fields: {
      featureId: str('The mate feature id; unique in this assembly.'),
      kind: str(`One of ${MATE_KINDS.join(', ')}.`),
      label: optStr(),
      ref_a: ref(REF_NOTE),
      ref_b: ref(REF_NOTE),
      flip: optBool(),
      offset: offsetOptional(),
      angle: optNum('Degrees in [0, 360); the absolute roll between the anchors\' canonical frames.'),
      radius: optNum('Tangential clearance radius.'),
      ratio: optNum('Copy-rotation ratio.'),
    },
  },
  set_mate_ref: {
    summary: 'Write one mate reference from a part-local pick.',
    note: REF_NOTE,
    fields: {
      featureId: str(),
      field: str('ref_a or ref_b.'),
      ref: ref(REF_NOTE),
    },
  },
  update_mate: {
    summary: 'Patch a mate\'s parameters; a null value deletes the key.',
    note: MATE_PARAM_NOTE + ' A null (or an omitted field) deletes the key rather than storing it.',
    fields: {
      featureId: str(),
      flip: nullableBool(),
      offset: offsetNullable(),
      angle: nullableNum(),
      radius: nullableNum(),
      ratio: nullableNum(),
    },
  },
  rename_mate: {
    summary: 'Rename a mate. An empty label re-mints the stable default name.',
    fields: { featureId: str(), label: str() },
  },
  delete_mate: {
    summary: 'Delete a mate.',
    fields: { featureId: str() },
  },
  reorder_part: {
    summary: 'Move a part instance before another instance, or last among the parts.',
    fields: { handle: str(), before: nullableStr() },
  },
  reorder_mate: {
    summary: 'Move a mate before another mate, or last among the mates.',
    fields: { featureId: str(), before: nullableStr() },
  },
} as const satisfies { [K in AssemblyWireType]: AssemblyMutationInfo }

export type AssemblyMutationCatalog = typeof ASSEMBLY_MUTATION_CATALOG

export const ASSEMBLY_MUTATION_FAMILY: Record<AssemblyWireType, AssemblyMutationFamily> = {
  add_part: 'parts',
  duplicate_part: 'parts',
  delete_part: 'parts',
  set_part_position: 'parts',
  set_part_rotation: 'parts',
  set_part_fixed: 'parts',
  set_part_visible: 'parts',
  set_builtin_visible: 'parts',
  add_mate: 'mates',
  set_mate_ref: 'mates',
  update_mate: 'mates',
  rename_mate: 'mates',
  delete_mate: 'mates',
  reorder_part: 'parts',
  reorder_mate: 'mates',
}

export const ASSEMBLY_MUTATION_FAMILIES: readonly AssemblyMutationFamily[] = ['parts', 'mates']

export type AssemblyValidationErrorCode =
  | 'unknown-mutation'
  | 'invalid-mutation'
  | 'unknown-target'
  | 'unresolved-ref'

export type AssemblyValidation =
  | { ok: true; operation: AssemblyOperationId; input: AssemblyOperationInputs[AssemblyOperationId] }
  | { ok: false; error: { code: AssemblyValidationErrorCode; message: string } }

export interface AssemblyValidationContext {
  doc: AssemblyDoc | null
  // The doc_ids the run bound. Null skips the binding rule (a shape-only check).
  boundPartIds: ReadonlySet<string> | null
  // Resolves a drive ref against the part build. Absent means only the anchor
  // form can resolve; a query or selector is refused with the reason.
  resolveRef?: (ref: DriveMateRef) => ResolvedDriveRef
}

function fail(code: AssemblyValidationErrorCode, message: string): AssemblyValidation {
  return { ok: false, error: { code, message } }
}

function isRecord(value: unknown): value is { [key: string]: unknown } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function json(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function editDistance(a: string, b: string): number {
  const previous = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let diagonal = previous[0]
    previous[0] = i
    for (let j = 1; j <= b.length; j++) {
      const above = previous[j]
      previous[j] = Math.min(previous[j] + 1, previous[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1))
      diagonal = above
    }
  }
  return previous[b.length]
}

export function nearestAssemblyMutationType(type: string): string | null {
  let best: string | null = null
  let bestDistance = 3
  for (const candidate of Object.keys(ASSEMBLY_MUTATION_CATALOG)) {
    const distance = editDistance(type, candidate)
    if (distance < bestDistance) {
      best = candidate
      bestDistance = distance
    }
  }
  return best
}

function matchesFieldType(type: AssemblyFieldType, value: unknown): boolean {
  switch (type) {
    case 'string': return typeof value === 'string'
    case 'number': return isFiniteNumber(value)
    case 'boolean': return typeof value === 'boolean'
    case 'vec3': return Array.isArray(value) && value.length === 3 && value.every(isFiniteNumber)
    case 'object': return isRecord(value)
    case 'offset': return isFiniteNumber(value) || isRecord(value)
    case 'ref': return isRecord(value) && typeof value.part === 'string'
  }
}

function handleList(doc: AssemblyDoc): string[] {
  return (doc.features ?? [])
    .filter(f => f.kind === 'part_instance' && f.instance)
    .map(f => f.instance!.handle)
}

function vec3Problem(value: unknown, label: string, length = 3): string | null {
  if (!Array.isArray(value) || value.length !== length || !value.every(isFiniteNumber)) {
    const shape = length === 3 ? '[x, y, z]' : `${length} finite numbers`
    return `${label} must be ${shape} of finite numbers, got ${json(value)}`
  }
  return null
}

function refShapeProblem(value: unknown, label: string): string | null {
  if (!isRecord(value)) return `${label} must be a ref object, got ${json(value)}`
  if (typeof value.part !== 'string' || value.part === '') return `${label}.part must be a non-empty instance handle`
  const forms = ['query', 'selector', 'anchor'].filter(key => value[key] !== undefined)
  if (forms.length !== 1) {
    return `${label} needs exactly one of query, selector or anchor (got ${forms.length === 0 ? 'none' : forms.join(', ')})`
  }
  const form = forms[0]
  if (form === 'query' && (typeof value.query !== 'string' || value.query === '')) {
    return `${label}.query must be a non-empty query from select`
  }
  if (form === 'selector' && !isRecord(value.selector)) return `${label}.selector must be a selector object`
  if (form === 'anchor' && (typeof value.anchor !== 'string' || value.anchor === '')) {
    return `${label}.anchor must be a non-empty anchor id`
  }
  for (const key of Object.keys(value)) {
    if (!['part', 'query', 'selector', 'anchor'].includes(key)) return `${label} has no field ${json(key)}`
  }
  return null
}

function offsetProblem(value: unknown, label: string): string | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? null : `${label} must be a finite number or a {x,y,z} object, got ${json(value)}`
  }
  if (!isRecord(value)) return `${label} must be a finite number or a {x,y,z} object, got ${json(value)}`
  for (const key of Object.keys(value)) {
    if (!['x', 'y', 'z'].includes(key)) return `${label} has no component ${json(key)}; use x, y or z`
    if (!isFiniteNumber(value[key])) return `${label}.${key} must be a finite number, got ${json(value[key])}`
  }
  return null
}

function boundProblem(ctx: AssemblyValidationContext, part: string): string | null {
  if (ctx.boundPartIds === null) return null
  if (ctx.boundPartIds.has(part)) return null
  const bound = [...ctx.boundPartIds].sort()
  return `part "${part}" is not bound; bound parts: ${bound.join(', ') || 'none'}. `
    + 'Bind it with the run call\'s `parts` argument.'
}

function instanceProblem(doc: AssemblyDoc | null, handle: string, label: string): string | null {
  if (handle === ASSEMBLY_HANDLE) {
    return `${label} "${handle}" is the reserved assembly frame, not a part instance; use {part: "__assembly", anchor: ...} in a mate ref`
  }
  if (doc === null) return null
  if (findInstance(doc, handle)) return null
  return `${label} "${handle}" names no part instance; instances: ${handleList(doc).join(', ') || 'none'}`
}

function uniqueHandleProblem(doc: AssemblyDoc | null, handle: string, label: string): string | null {
  if (handle === ASSEMBLY_HANDLE) {
    return `${label} "${handle}" is the reserved assembly frame, not a part instance; pick another handle`
  }
  if (doc === null) return null
  if (!findInstance(doc, handle)) return null
  return `${label} "${handle}" already names a part instance; pick a new handle`
}

function mateProblem(doc: AssemblyDoc | null, featureId: string): string | null {
  if (doc === null) return null
  if (findMate(doc, featureId)) return null
  const ids = (doc.features ?? []).filter(f => f.kind === 'mate').map(f => f.id)
  return `featureId "${featureId}" names no mate; mates: ${ids.join(', ') || 'none'}`
}

function uniqueMateProblem(doc: AssemblyDoc | null, featureId: string): string | null {
  if (doc === null) return null
  if (!findMate(doc, featureId)) return null
  return `featureId "${featureId}" already names a mate; pick a new id`
}

function builtinProblem(doc: AssemblyDoc | null, id: string): string | null {
  if (doc === null) return null
  const feature = (doc.features ?? []).find(f => f.id === id)
  if (feature && (feature.kind === 'origin' || feature.kind === 'plane')) return null
  const ids = (doc.features ?? [])
    .filter(f => f.kind === 'origin' || f.kind === 'plane')
    .map(f => f.id)
  return `id "${id}" names no built-in reference feature; built-ins: ${ids.join(', ') || 'none'}`
}

function resolveRef(ctx: AssemblyValidationContext, ref: unknown, label: string): { ok: true; ref: MateRef } | { ok: false; message: string } {
  const shape = refShapeProblem(ref, label)
  if (shape !== null) return { ok: false, message: shape }
  const drive = ref as DriveMateRef
  if (ctx.resolveRef) {
    const resolved = ctx.resolveRef(drive)
    return resolved.ok ? resolved : { ok: false, message: resolved.message }
  }
  if ('anchor' in drive) return { ok: true, ref: { part: drive.part, anchor: drive.anchor } }
  return {
    ok: false,
    message: `${label} uses a ${'query' in drive ? 'query' : 'selector'}, which needs the part build; `
      + 'the drive resolves it before the step runs',
  }
}

function mateKindParamProblem(kind: string, param: string): string | null {
  if (!(MATE_KINDS as readonly string[]).includes(kind)) {
    return `kind ${json(kind)} is not a mate kind; use one of ${MATE_KINDS.join(', ')}`
  }
  if (!mateParams(kind as MateKind).includes(param as never)) {
    const reads = mateParams(kind as MateKind)
    const hint = param === 'offset' && kind === 'sliding'
      ? ' an offset on a sliding joint would be a motor, not a mate.'
      : ''
    return `a ${kind} mate does not read ${param}; it reads ${reads.join(', ') || 'nothing'}.${hint}`
  }
  return null
}

function mateParamProblem(kind: string, param: string, value: unknown): string | null {
  const kindProblem = mateKindParamProblem(kind, param)
  if (kindProblem !== null) return kindProblem
  if (param === 'offset') return offsetProblem(value, 'offset')
  if (param === 'flip') return typeof value === 'boolean' ? null : `flip must be a boolean, got ${json(value)}`
  if (!isFiniteNumber(value)) {
    return `${param} must be a finite number, got ${json(value)}; mate expressions are not supported`
  }
  return null
}

function transformFrom(position: Vec3Tuple, rotation: Vec3Tuple) {
  const [rx, ry, rz] = rotation.map(deg => (deg * Math.PI) / 180) as Vec3Tuple
  const [qx, qy, qz, qw] = quatFromEulerXyz([rx, ry, rz])
  const [tx, ty, tz] = position
  return { tx, ty, tz, qx, qy, qz, qw }
}

function matePatch(raw: Record<string, unknown>): MateParamPatch {
  const patch: MateParamPatch = {}
  for (const key of ['flip', 'offset', 'angle', 'radius', 'ratio'] as const) {
    if (!(key in raw)) continue
    const value = raw[key]
    patch[key] = value === null ? undefined : value as never
  }
  return patch
}

function paramFieldsPresent(raw: Record<string, unknown>): string[] {
  return ['flip', 'offset', 'angle', 'radius', 'ratio'].filter(key => raw[key] !== undefined)
}

/**
 * Validate one untyped assembly mutation. Field presence, JSON type and the
 * value a field may hold are checked; a mate ref is resolved here so the stored
 * document only ever carries the durable triple (D4).
 */
export function validateAssemblyMutation(
  raw: unknown,
  ctx: AssemblyValidationContext,
): AssemblyValidation {
  if (!isRecord(raw)) return fail('invalid-mutation', 'an assembly mutation must be an object')
  const type = raw.type
  if (typeof type !== 'string' || type.length === 0) {
    return fail('invalid-mutation', 'an assembly mutation needs a non-empty string "type"')
  }
  const catalog = ASSEMBLY_MUTATION_CATALOG as Record<string, AssemblyMutationInfo | undefined>
  const info = Object.hasOwn(catalog, type) ? catalog[type] : undefined
  if (!info) {
    const suggestion = nearestAssemblyMutationType(type)
    return fail('unknown-mutation', `unknown assembly mutation type "${type}"${suggestion ? `; did you mean "${suggestion}"?` : ''}`)
  }
  for (const key of Object.keys(raw)) {
    if (key === 'type') continue
    if (!Object.hasOwn(info.fields, key)) {
      return fail('invalid-mutation', `assembly mutation "${type}" has no field "${key}"`)
    }
  }
  // A value whose shape the value rules can explain better is deferred to them:
  // a rotation of length 2 and an expression angle get a message that names the
  // accepted spelling instead of the generic JSON type.
  const deferred = new Set(['angle', 'radius', 'ratio', 'offset', 'flip', 'position', 'rotation'])
  for (const [name, field] of Object.entries(info.fields)) {
    const value = raw[name]
    if (value === undefined) {
      if (field.required) return fail('invalid-mutation', `assembly mutation "${type}" is missing required field "${name}"`)
      continue
    }
    if (value === null) {
      if (field.nullable === true) continue
      return fail('invalid-mutation', `assembly mutation "${type}" field "${name}" must be ${field.type}, got null`)
    }
    if (!matchesFieldType(field.type, value) && !deferred.has(name)) {
      return fail('invalid-mutation', `assembly mutation "${type}" field "${name}" must be ${field.type}, got ${json(value)}`)
    }
  }
  return validateValues(type as AssemblyWireType, raw, ctx)
}

function validateValues(
  type: AssemblyWireType,
  raw: Record<string, unknown>,
  ctx: AssemblyValidationContext,
): AssemblyValidation {
  const doc = ctx.doc
  switch (type) {
    case 'add_part': {
      const handle = raw.handle as string
      const handleProblem = uniqueHandleProblem(doc, handle, 'handle')
      if (handleProblem !== null) return fail('invalid-mutation', handleProblem)
      const partProblem = boundProblem(ctx, raw.part as string)
      if (partProblem !== null) return fail('unknown-target', partProblem)
      if (raw.position !== undefined) {
        const problem = vec3Problem(raw.position, 'position')
        if (problem !== null) return fail('invalid-mutation', problem)
      }
      if (raw.rotation !== undefined) {
        const problem = vec3Problem(raw.rotation, 'rotation')
        if (problem !== null) return fail('invalid-mutation', problem)
      }
      const position = (raw.position as Vec3Tuple | undefined) ?? [0, 0, 0]
      const rotation = (raw.rotation as Vec3Tuple | undefined) ?? [0, 0, 0]
      return {
        ok: true,
        operation: 'add_part',
        input: {
          docId: raw.part as string,
          docRev: 0,
          handle,
          featureId: `inst_${handle}`,
          transform: transformFrom(position, rotation),
          ...(raw.fixed !== undefined && { fixed: raw.fixed as boolean }),
        },
      }
    }
    case 'duplicate_part': {
      const source = instanceProblem(doc, raw.handle as string, 'handle')
      if (source !== null) return fail('unknown-target', source)
      const newHandle = raw.newHandle as string
      const unique = uniqueHandleProblem(doc, newHandle, 'newHandle')
      if (unique !== null) return fail('invalid-mutation', unique)
      return {
        ok: true,
        operation: 'duplicate_part',
        input: { handle: raw.handle as string, newHandle, featureId: `inst_${newHandle}` },
      }
    }
    case 'delete_part':
    case 'set_part_visible':
    case 'set_part_fixed':
    case 'set_part_position':
    case 'set_part_rotation':
    case 'reorder_part': {
      const handle = raw.handle as string
      const problem = instanceProblem(doc, handle, 'handle')
      if (problem !== null) return fail('unknown-target', problem)
      if (type === 'reorder_part' && raw.before !== null && raw.before !== undefined) {
        const before = instanceProblem(doc, raw.before as string, 'before')
        if (before !== null) return fail('unknown-target', before)
      }
      const operation = ASSEMBLY_OPERATION_BY_MUTATION[type]
      if (type === 'delete_part') return { ok: true, operation, input: handle }
      if (type === 'set_part_visible') {
        return { ok: true, operation, input: { handle, visible: raw.visible as boolean } }
      }
      if (type === 'set_part_fixed') {
        return { ok: true, operation, input: { handle, fixed: raw.fixed as boolean } }
      }
      if (type === 'set_part_position') {
        const problem = vec3Problem(raw.position, 'position')
        if (problem !== null) return fail('invalid-mutation', problem)
        const [tx, ty, tz] = raw.position as Vec3Tuple
        return { ok: true, operation, input: { handle, pos: { tx, ty, tz } } }
      }
      if (type === 'set_part_rotation') {
        const problem = vec3Problem(raw.rotation, 'rotation')
        if (problem !== null) return fail('invalid-mutation', problem)
        const [rx, ry, rz] = raw.rotation as Vec3Tuple
        return { ok: true, operation, input: { handle, euler: { rx, ry, rz } } }
      }
      return {
        ok: true,
        operation,
        input: { movingHandle: handle, beforeHandle: (raw.before as string | null | undefined) ?? null },
      }
    }
    case 'set_builtin_visible': {
      const problem = builtinProblem(doc, raw.id as string)
      if (problem !== null) return fail('unknown-target', problem)
      return {
        ok: true,
        operation: 'set_builtin_visible',
        input: { id: raw.id as string, visible: raw.visible as boolean },
      }
    }
    case 'add_mate': {
      const featureId = raw.featureId as string
      const unique = uniqueMateProblem(doc, featureId)
      if (unique !== null) return fail('invalid-mutation', unique)
      const kind = raw.kind as string
      if (!(MATE_KINDS as readonly string[]).includes(kind)) {
        return fail('invalid-mutation', `kind ${json(kind)} is not a mate kind; use one of ${MATE_KINDS.join(', ')}`)
      }
      for (const param of paramFieldsPresent(raw)) {
        const problem = mateParamProblem(kind, param, raw[param])
        if (problem !== null) return fail('invalid-mutation', problem)
      }
      const refA = resolveRef(ctx, raw.ref_a, 'ref_a')
      if (!refA.ok) return fail('unresolved-ref', refA.message)
      const refB = resolveRef(ctx, raw.ref_b, 'ref_b')
      if (!refB.ok) return fail('unresolved-ref', refB.message)
      if (refA.ref.part === refB.ref.part) {
        return fail('invalid-mutation', `a mate needs two different parts; both refs name "${refA.ref.part}"`)
      }
      const patch = matePatch(raw)
      return {
        ok: true,
        operation: 'add_mate',
        input: {
          kind: kind as MateKind,
          id: featureId,
          ...(raw.label !== undefined && { label: raw.label as string }),
          ref_a: refA.ref,
          ref_b: refB.ref,
          ...(Object.keys(patch).length > 0 && { patch }),
        },
      }
    }
    case 'set_mate_ref': {
      const featureId = raw.featureId as string
      const mate = doc === null ? undefined : findMate(doc, featureId)
      const mateMissing = mateProblem(doc, featureId)
      if (mateMissing !== null) return fail('unknown-target', mateMissing)
      const field = raw.field as string
      if (field !== 'ref_a' && field !== 'ref_b') {
        return fail('invalid-mutation', `field must be "ref_a" or "ref_b", got ${json(field)}`)
      }
      const resolved = resolveRef(ctx, raw.ref, 'ref')
      if (!resolved.ok) return fail('unresolved-ref', resolved.message)
      if (mate) {
        const other = field === 'ref_a' ? mate.ref_b : mate.ref_a
        if (other.part !== '' && other.part === resolved.ref.part) {
          return fail('invalid-mutation', `a mate needs two different parts; the other ref already names "${other.part}"`)
        }
      }
      return {
        ok: true,
        operation: 'set_mate_ref',
        input: { id: featureId, field: field as MateRefField, ref: resolved.ref },
      }
    }
    case 'update_mate': {
      const featureId = raw.featureId as string
      const missing = mateProblem(doc, featureId)
      if (missing !== null) return fail('unknown-target', missing)
      const mate = doc === null ? undefined : findMate(doc, featureId)
      const kind = mate?.kind
      const present = paramFieldsPresent(raw)
      if (present.length === 0) {
        return fail('invalid-mutation', 'update_mate needs at least one of flip, offset, angle, radius or ratio')
      }
      if (kind !== undefined) {
        for (const param of present) {
          if (raw[param] === null) continue
          const problem = mateParamProblem(kind, param, raw[param])
          if (problem !== null) return fail('invalid-mutation', problem)
        }
      }
      return { ok: true, operation: 'update_mate', input: { id: featureId, patch: matePatch(raw) } }
    }
    case 'rename_mate': {
      const missing = mateProblem(doc, raw.featureId as string)
      if (missing !== null) return fail('unknown-target', missing)
      return {
        ok: true,
        operation: 'rename_mate',
        input: { id: raw.featureId as string, label: raw.label as string },
      }
    }
    case 'delete_mate': {
      const missing = mateProblem(doc, raw.featureId as string)
      if (missing !== null) return fail('unknown-target', missing)
      return { ok: true, operation: 'delete_mate', input: raw.featureId as string }
    }
    case 'reorder_mate': {
      const missing = mateProblem(doc, raw.featureId as string)
      if (missing !== null) return fail('unknown-target', missing)
      if (raw.before !== null && raw.before !== undefined) {
        const beforeMissing = mateProblem(doc, raw.before as string)
        if (beforeMissing !== null) return fail('unknown-target', beforeMissing)
      }
      return {
        ok: true,
        operation: 'reorder_mate',
        input: { movingId: raw.featureId as string, beforeId: (raw.before as string | null | undefined) ?? null },
      }
    }
  }
  return fail('unknown-mutation', `unknown assembly mutation type "${type}"`)
}

/** The wire fields an example or a caller sees, for the payload and tests. */
export function assemblyMutationInfoOf(type: AssemblyWireType): AssemblyMutationInfo {
  return ASSEMBLY_MUTATION_CATALOG[type] as AssemblyMutationInfo
}

/** A mate kind's display label, used by the catalog notes and the summary. */
export function mateKindLabel(kind: MateKind): string {
  return MATE_KIND_LABELS[kind] ?? kind
}
