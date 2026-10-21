// @vitest-environment node
//
// The drive boundary's mutation guard: an untyped JSON step is validated
// before it is cast to Mutation, so a typo, a missing field, a wrong JSON type
// or an internal type is a named step failure instead of a silent success.

import { describe, it, expect } from 'vitest'
import { validateMutation } from '../mutationCatalog'
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
