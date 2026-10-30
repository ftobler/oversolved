// The assembly mutation catalog and its boundary validator. The catalog is the
// wire vocabulary mapped onto ASSEMBLY_OPERATIONS; the validator refuses a typo,
// a missing or wrong value, a duplicate id and an unbound part by name, and
// resolves a mate ref through the same resolver the drive uses.

import { describe, it, expect } from 'vitest'
import type { AssemblyDoc } from '@/types/cad'
import { validateSelector } from '@/kernel/select'
import { ASSEMBLY_OPERATIONS, planAssemblyOperation, type AssemblyOperationId } from '@/utils/assemblyOperations'
import {
  ASSEMBLY_MUTATION_CATALOG,
  ASSEMBLY_MUTATION_FAMILY,
  ASSEMBLY_OPERATION_BY_MUTATION,
  validateAssemblyMutation,
  type AssemblyWireMutation,
} from '../assemblyMutationCatalog'
import { ASSEMBLY_MUTATION_EXAMPLES } from '../assemblyExamples'
import type { DriveMateRef, ResolvedDriveRef } from '../assemblyRefs'

const EMPTY: AssemblyDoc = { kind: 'assembly', features: [] }

function docWithLeft(): AssemblyDoc {
  return {
    kind: 'assembly',
    features: [
      { id: 'inst_left', kind: 'part_instance', instance: {
        handle: 'left', doc_id: 'rail_400', doc_rev: 0, transform: { tx: 0, ty: 0, tz: 0, qx: 0, qy: 0, qz: 0, qw: 1 },
      } },
      { id: 'inst_right', kind: 'part_instance', instance: {
        handle: 'right', doc_id: 'panel', doc_rev: 0, transform: { tx: 0, ty: 0, tz: 0, qx: 0, qy: 0, qz: 0, qw: 1 },
      } },
      { id: 'm1', kind: 'mate', mate: {
        kind: 'sliding', ref_a: { part: 'left', anchor: 'a' }, ref_b: { part: 'right', anchor: 'b' },
      } },
    ],
  }
}

// A stand-in for the kernel: a selector/query resolves to a deterministic anchor
// id per part, which is all the validator needs to build a stored ref. The
// selector still goes through the real grammar check, so a served example with a
// typo fails here rather than shipping unnoticed.
function stubResolver(ref: DriveMateRef): ResolvedDriveRef {
  if ('anchor' in ref) return { ok: true, ref: { part: ref.part, anchor: ref.anchor } }
  if ('selector' in ref) {
    try {
      validateSelector(ref.selector)
    } catch (e) {
      return { ok: false, code: 'invalid-ref', message: e instanceof Error ? e.message : String(e) }
    }
  }
  return { ok: true, ref: { part: ref.part, anchor: `a_${ref.part}` } }
}

function validate(raw: unknown, doc: AssemblyDoc | null = docWithLeft(), boundPartIds: ReadonlySet<string> | null = new Set(['rail_400', 'panel'])) {
  return validateAssemblyMutation(raw, { doc, boundPartIds, resolveRef: stubResolver })
}

describe('ASSEMBLY_MUTATION_CATALOG', () => {
  it('covers every operation except the hidden fold twin', () => {
    const expected = (Object.keys(ASSEMBLY_OPERATIONS) as AssemblyOperationId[])
      .filter(id => id !== 'set_part_fixed_oneshot')
    expect(Object.keys(ASSEMBLY_MUTATION_CATALOG).sort()).toEqual(expected.sort())
    // Every row maps onto a real operation, and the one wire spelling that
    // differs is the structural fixed toggle.
    for (const [type, operation] of Object.entries(ASSEMBLY_OPERATION_BY_MUTATION)) {
      expect(ASSEMBLY_OPERATIONS[operation], type).toBeDefined()
    }
    expect(ASSEMBLY_OPERATION_BY_MUTATION.set_part_fixed).toBe('set_part_fixed_oneshot')
  })

  it('gives every field a JSON type and every object field a note', () => {
    for (const [type, info] of Object.entries(ASSEMBLY_MUTATION_CATALOG)) {
      expect(Object.keys(info.fields).length, type).toBeGreaterThan(0)
      for (const [name, field] of Object.entries(info.fields)) {
        expect(['string', 'number', 'boolean', 'vec3', 'object', 'ref', 'offset']).toContain(field.type)
        if (field.type === 'object' || field.type === 'ref' || field.type === 'vec3' || field.type === 'offset') {
          expect(field.note, `${type}.${name} needs a note`).toBeDefined()
        }
      }
      expect(ASSEMBLY_MUTATION_FAMILY[type as AssemblyWireMutation['type']]).toBeDefined()
    }
  })

  // headlessAssembly's capture runs BEFORE the step writes anything, so the
  // seeds it measures are the ones the step's own solve starts from. That
  // claim (its capture-before-operation comment) only holds while both
  // mate-writing operations leave the seeds unbaked: a bake flag here would
  // make the capture report measure poses the document no longer keeps.
  it('keeps both mate-writing operations unbaked, which the pre-op capture assumes', () => {
    expect(ASSEMBLY_OPERATIONS.add_mate.bake).toBe(false)
    expect(ASSEMBLY_OPERATIONS.set_mate_ref.bake).toBe(false)
  })
})

describe('validateAssemblyMutation refusals', () => {
  it('refuses an unknown type with a did-you-mean', () => {
    const result = validate({ type: 'add_mates', featureId: 'm2' })
    expect(result).toMatchObject({ ok: false, error: { code: 'unknown-mutation' } })
    expect(!result.ok && result.error.message).toContain('did you mean "add_mate"')
  })

  it('refuses a missing required field by name', () => {
    const result = validate({ type: 'add_part', part: 'rail_400' })
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid-mutation' } })
    expect(!result.ok && result.error.message).toContain('missing required field "handle"')
  })

  it('refuses the reserved assembly handle', () => {
    const result = validate({ type: 'add_part', handle: '__assembly', part: 'rail_400' })
    expect(!result.ok && result.error.message).toContain('reserved assembly frame')
  })

  it('refuses a duplicate handle', () => {
    const result = validate({ type: 'add_part', handle: 'left', part: 'rail_400' })
    expect(!result.ok && result.error.message).toContain('already names a part instance')
  })

  it('refuses an unbound part and lists the bound ids', () => {
    const result = validate({ type: 'add_part', handle: 'new', part: 'ghost' })
    expect(result).toMatchObject({ ok: false, error: { code: 'unknown-target' } })
    expect(!result.ok && result.error.message).toContain('bound parts: panel, rail_400')
  })

  it('refuses an offset on a sliding mate, listing the params it reads', () => {
    const result = validate({
      type: 'add_mate', featureId: 'm2', kind: 'sliding',
      ref_a: { part: 'left', anchor: 'a' }, ref_b: { part: 'right', anchor: 'b' }, offset: 5,
    })
    expect(!result.ok && result.error.message).toContain('does not read offset')
    expect(!result.ok && result.error.message).toContain('flip, angle')
    expect(!result.ok && result.error.message).toContain('motor')
  })

  it('refuses an expression angle', () => {
    const result = validate({
      type: 'add_mate', featureId: 'm2', kind: 'fixed',
      ref_a: { part: 'left', anchor: 'a' }, ref_b: { part: 'right', anchor: 'b' }, angle: 'a*2',
    })
    expect(!result.ok && result.error.message).toContain('angle must be a finite number')
    expect(!result.ok && result.error.message).toContain('expressions are not supported')
  })

  it('refuses both refs naming the same instance', () => {
    const result = validate({
      type: 'add_mate', featureId: 'm2', kind: 'fixed',
      ref_a: { part: 'left', anchor: 'a' }, ref_b: { part: 'left', anchor: 'b' },
    })
    expect(!result.ok && result.error.message).toContain('two different parts')
  })

  it('keeps a malformed selector an invalid ref, not a failed match', () => {
    const invalid = (): ResolvedDriveRef => ({
      ok: false,
      code: 'invalid-ref',
      message: 'selector.where.type "plane" is not a valid face surface type',
    })
    const result = validateAssemblyMutation(
      {
        type: 'add_mate', featureId: 'm2', kind: 'fixed',
        ref_a: { part: 'left', selector: { kind: 'face', where: { type: 'plane' } } },
        ref_b: { part: 'right', anchor: 'b' },
      },
      { doc: docWithLeft(), boundPartIds: new Set(['rail_400', 'panel']), resolveRef: invalid },
    )
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid-ref' } })
    expect(!result.ok && result.error.message).toContain('face surface type')
  })

  it('refuses a rotation of length 2', () => {
    const result = validate({ type: 'set_part_rotation', handle: 'left', rotation: [0, 90] })
    expect(!result.ok && result.error.message).toContain('rotation must be [x, y, z]')
  })

  it('refuses a mate parameter edit the kind does not read', () => {
    const result = validate({ type: 'update_mate', featureId: 'm1', offset: 5 })
    expect(!result.ok && result.error.message).toContain('does not read offset')
  })

  it('accepts a null parameter as the documented delete', () => {
    const result = validate({ type: 'update_mate', featureId: 'm1', angle: null })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.operation).toBe('update_mate')
    expect(result.input).toEqual({ id: 'm1', patch: { angle: undefined } })
  })
})

describe('the catalog examples', () => {
  for (const example of ASSEMBLY_MUTATION_EXAMPLES) {
    it(`validates and applies every step of ${example.name}`, () => {
      const boundPartIds = new Set(Object.keys(example.parts))
      let doc: AssemblyDoc = { ...EMPTY, features: [] }
      for (const [index, step] of example.steps.entries()) {
        const validated = validateAssemblyMutation(step.mutation, { doc, boundPartIds, resolveRef: stubResolver })
        expect(validated.ok, `${example.name} step ${index}: ${validated.ok ? '' : validated.error.message}`).toBe(true)
        if (!validated.ok) throw new Error('unreachable')
        const plan = planAssemblyOperation(validated.operation, validated.input as never, { doc, transforms: {} })
        expect(plan).not.toBeNull()
        doc = plan!.doc
      }
      // The authored refs are the durable triple; no selector was stored.
      expect(JSON.stringify(doc)).not.toContain('selector')
    })
  }
})
