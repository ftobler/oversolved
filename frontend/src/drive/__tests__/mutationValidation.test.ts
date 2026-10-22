// @vitest-environment node
//
// The drive boundary's mutation guard: an untyped JSON step is validated
// before it is cast to Mutation, so a typo, a missing field, a wrong JSON type
// or an internal type is a named step failure instead of a silent success.

import { describe, it, expect } from 'vitest'
import { MUTATION_CATALOG, setterFieldNames, validateMutation } from '../mutationCatalog'
import type { Mutation } from '@/types/cad'
import { seedBuiltins } from '../headlessOps'
import { runHeadless } from '../headlessOps'

function seededDoc() {
  return seedBuiltins({ version: 1, kind: 'part', features: [] })
}

describe('validateMutation', () => {
  it('refuses an unknown type and suggests the near miss', () => {
    const result = validateMutation({ type: 'add_fillett', featureId: 'f1' })
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'unknown-mutation' },
    })
    if (result.ok) throw new Error('unreachable')
    expect(result.error.message).toContain('add_fillet')
  })

  it('refuses a far-off type without inventing a suggestion', () => {
    const result = validateMutation({ type: 'frobnicate' })
    expect(result).toMatchObject({ ok: false, error: { code: 'unknown-mutation' } })
    if (result.ok) throw new Error('unreachable')
    expect(result.error.message).not.toContain('did you mean')
  })

  it('names the missing required field', () => {
    const result = validateMutation({ type: 'add_extrude', featureId: 'ex1', distance: 5 })
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid-mutation' } })
    if (result.ok) throw new Error('unreachable')
    expect(result.error.message).toContain('sketchQuery')
  })

  it('names the field with the wrong JSON type', () => {
    const result = validateMutation({
      type: 'add_extrude', featureId: 'ex1', sketchQuery: '$sk1', distance: '5',
    })
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid-mutation' } })
    if (result.ok) throw new Error('unreachable')
    expect(result.error.message).toContain('distance')
  })

  it('refuses an internal mutation type', () => {
    const result = validateMutation({ type: 'edit_session', featureId: 'f1' })
    expect(result).toMatchObject({ ok: false, error: { code: 'internal-mutation' } })
  })

  it('refuses prototype keys as unknown types instead of throwing', () => {
    for (const type of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
      const result = validateMutation({ type })
      expect(result).toMatchObject({ ok: false, error: { code: 'unknown-mutation' } })
    }
  })

  it('refuses an internal field on a visible mutation', () => {
    const result = validateMutation({
      type: 'add_extrude', featureId: 'ex1', sketchQuery: '$sk1', distance: 5, insertAt: 0,
    })
    expect(result).toMatchObject({ ok: false, error: { code: 'internal-mutation' } })
    if (result.ok) throw new Error('unreachable')
    expect(result.error.message).toContain('insertAt')
  })

  it('refuses an internal field on a visible row that does not declare it', () => {
    const result = validateMutation({ type: 'rename_feature', featureId: 'f1', label: 'x', insertAt: 0 })
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid-mutation' } })
    if (result.ok) throw new Error('unreachable')
    expect(result.error.message).toContain('insertAt')
  })

  it('refuses a drag snapshot on an unhidden drag mutation', () => {
    for (const type of ['move_entity', 'resize_circle']) {
      const result = validateMutation({
        type,
        featureId: 'sk1',
        entityId: 'e1',
        ...(type === 'move_entity' ? { delta: [1, 0] } : { radius: 3 }),
        solvedGeometry: { e1: [0, 0, 1, 0] },
      })
      expect(result).toMatchObject({ ok: false, error: { code: 'internal-mutation' } })
    }
  })

  it('accepts the app null clears that journals replay', () => {
    expect(validateMutation({
      type: 'set_hole_field', featureId: 'h1', field: 'thread', value: null,
    }, { allowInternal: true })).toMatchObject({ ok: true })
    expect(validateMutation({
      type: 'set_circular_array_field', featureId: 'ca1', field: 'step_angle', value: null,
    }, { allowInternal: true })).toMatchObject({ ok: true })
  })

  it('refuses an out-of-schema setter field unless the replay path allows internal', () => {
    // An external script must not name a field the schema does not define. The
    // replay path re-applies the app's own journal, so it skips the check.
    const bogus = { type: 'set_hole_field', featureId: 'h1', field: 'bogus', value: 1 }
    expect(validateMutation(bogus)).toMatchObject({ ok: false, error: { code: 'invalid-mutation' } })
    expect(validateMutation(bogus, { allowInternal: true })).toMatchObject({ ok: true })
  })

  it('accepts null only where the union spells it', () => {
    expect(validateMutation({
      type: 'add_rect', featureId: 'sk1', p0: [0, 0], p1: [1, 1], p0Ref: null,
    })).toMatchObject({ ok: true })
    expect(validateMutation({
      type: 'add_extrude', featureId: 'ex1', sketchQuery: '$sk1', distance: null,
    })).toMatchObject({ ok: false, error: { code: 'invalid-mutation' } })
    // A setter value is a pass-through: null is the documented clear.
    expect(validateMutation({
      type: 'set_extrude_field', featureId: 'ex1', field: 'distance', value: null,
    })).toMatchObject({ ok: true })
    // Internal plumbing is allowed only on the replay path, where the app's
    // own set_rollback payload can legitimately carry a null position.
    expect(validateMutation({ type: 'set_rollback', position: null }, { allowInternal: true }))
      .toMatchObject({ ok: true })
  })

  it('refuses a non-object and a missing type', () => {
    expect(validateMutation(null)).toMatchObject({ ok: false, error: { code: 'invalid-mutation' } })
    expect(validateMutation('add_sketch')).toMatchObject({ ok: false, error: { code: 'invalid-mutation' } })
    expect(validateMutation({ featureId: 'sk1' })).toMatchObject({ ok: false, error: { code: 'invalid-mutation' } })
  })

  it('accepts a valid mutation unchanged', () => {
    const mutation = { type: 'add_sketch' as const, featureId: 'sk1', label: 'Sketch' }
    expect(validateMutation(mutation)).toEqual({ ok: true, mutation })
  })
})

describe('set_*_field field names', () => {
  // Derived from the catalog, so a new setter kind joins this table without a
  // second hand-written list to keep in step.
  const setterTypes = Object.keys(MUTATION_CATALOG)
    .filter(type => type.startsWith('set_') && type.endsWith('_field'))

  it('maps every catalog setter to its schema sub-definition', () => {
    expect(setterTypes.length).toBeGreaterThan(0)
    for (const type of setterTypes) {
      expect(setterFieldNames(type as Mutation['type']), type).not.toBeNull()
    }
  })

  it.each(setterTypes)('%s refuses an unknown field and lists the valid ones', (type) => {
    const names = setterFieldNames(type as Mutation['type'])
    expect(names).not.toBeNull()
    expect(names!.length).toBeGreaterThan(0)
    const result = validateMutation({ type, featureId: 'f1', field: 'diameterx', value: 1 })
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid-mutation' } })
    if (result.ok) throw new Error('unreachable')
    expect(result.error.message).toContain('diameterx')
    for (const name of names!) expect(result.error.message).toContain(name)
  })

  it.each(setterTypes)('%s accepts a field its schema names', (type) => {
    const names = setterFieldNames(type as Mutation['type'])!
    expect(validateMutation({ type, featureId: 'f1', field: names[0], value: 1 }))
      .toMatchObject({ ok: true })
  })

  it('names the hole field a typo meant and the fields that exist', () => {
    const result = validateMutation({ type: 'set_hole_field', featureId: 'h1', field: 'diameterx', value: 8 })
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid-mutation' } })
    if (result.ok) throw new Error('unreachable')
    expect(result.error.message).toContain('diameterx')
    expect(result.error.message).toContain('diameter')
    expect(result.error.message).toContain('depth_mode')
    expect(result.error.message).toContain('sketch')
  })
})

describe('headless drive boundary', () => {
  it('stops at an unknown mutation and leaves the seeded doc unchanged', async () => {
    const result = await runHeadless({
      doc: seededDoc(),
      steps: [
        { mutation: { type: 'add_fillett', featureId: 'f1' } as never },
        { mutation: { type: 'add_sketch', featureId: 'sk1', label: 'Sketch' } },
      ],
    })
    // The second step never ran, so only the refusal is recorded.
    expect(result.outcome.steps).toHaveLength(1)
    expect(result.outcome.steps[0]).toMatchObject({
      index: 0,
      kind: 'mutation',
      ok: false,
      error: { code: 'unknown-mutation' },
    })
    expect(result.ok).toBe(false)
    const empty = await runHeadless({ doc: seededDoc(), steps: [] })
    expect(result.docHash).toBe(empty.docHash)
  })

  it('reports a malformed step as an invalid-mutation outcome, not a crash', async () => {
    for (const step of [{}, { mutation: null }]) {
      const result = await runHeadless({ doc: seededDoc(), steps: [step as never] })
      expect(result.outcome.steps).toHaveLength(1)
      expect(result.outcome.steps[0]).toMatchObject({
        index: 0,
        ok: false,
        error: { code: 'invalid-mutation' },
      })
    }
    for (const step of [{ command: 123 }, { command: '' }]) {
      const result = await runHeadless({ doc: seededDoc(), steps: [step as never] })
      expect(result.outcome.steps[0]).toMatchObject({
        ok: false,
        error: { code: 'invalid-step' },
      })
    }
  })

  it('refuses prototype-key types through the headless step executor', async () => {
    for (const type of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
      const result = await runHeadless({ doc: seededDoc(), steps: [{ mutation: { type } as never }] })
      expect(result.outcome.steps[0]).toMatchObject({
        ok: false,
        error: { code: 'unknown-mutation' },
      })
    }
  })

  it('refuses internal plumbing sent as a script step', async () => {
    const result = await runHeadless({
      doc: seededDoc(),
      steps: [{
        mutation: { type: 'add_sketch', featureId: 'sk1', label: 'Sketch', insertAt: 0 } as never,
      }],
    })
    expect(result.outcome.steps[0]).toMatchObject({
      ok: false,
      error: { code: 'internal-mutation' },
    })
  })

  it('refuses a missing required field before the session sees it', async () => {
    const result = await runHeadless({
      doc: seededDoc(),
      steps: [{ mutation: { type: 'add_sketch' } as never }],
    })
    expect(result.outcome.steps[0]).toMatchObject({
      ok: false,
      error: { code: 'invalid-mutation' },
    })
    if (result.outcome.steps[0].error) expect(result.outcome.steps[0].error.message).toContain('featureId')
  })
})
