// The instance pattern's document row and boundary: the loader accepts the two
// target forms and refuses a value no rule reads (an enum outside its list, a
// grid cell in a one-dimensional skip list, both target forms at once), and the
// published schema carries the same row.
import { describe, it, expect } from 'vitest'
import { loadPartDoc } from '@/persistence/docSchema'
import { FEATURE_SCHEMA_BY_KIND } from '@/persistence/partDocSchema'

function doc(instance: unknown): Record<string, unknown> {
  return {
    version: 9,
    kind: 'part',
    features: [
      { id: 'sk1', kind: 'sketch', plane: '@builtin_plane_front', entities: [{ id: 'p', kind: 'point' }], initial: { p: [0, 0] }, constraints: [] },
      { id: 'ip1', kind: 'instance_pattern', label: 'Instance', instance_pattern: instance },
    ],
  }
}

function loaded(instance: unknown): Record<string, unknown> {
  const result = loadPartDoc(doc(instance))
  expect(result.ok, JSON.stringify(!result.ok ? result.error : null)).toBe(true)
  if (!result.ok) throw new Error('load failed')
  return (result.doc.features as Record<string, unknown>[])[1]
}

function refusal(instance: unknown): string {
  const result = loadPartDoc(doc(instance))
  if (result.ok) throw new Error(`expected a refusal for ${JSON.stringify(instance)}`)
  return JSON.stringify(result.error)
}

describe('the instance pattern document row', () => {
  it('loads the full sketch form', () => {
    const feature = loaded({
      subject: 'body', source_body: '@body_ex1', operation: 'add',
      sketch: '@sk1', reference: '@builtin_plane_top',
      orientation: 'fixed', reverse_normal: true, skip: [2, 3],
    })
    expect(feature.id).toBe('ip1')
    expect(feature.kind).toBe('instance_pattern')
    expect(feature.instance_pattern).toEqual({
      subject: 'body', source_body: '@body_ex1', operation: 'add',
      sketch: '@sk1', reference: '@builtin_plane_top',
      orientation: 'fixed', reverse_normal: true, skip: [2, 3],
    })
  })

  it('loads the picked form', () => {
    expect(loaded({ targets: ['?@ex1:flatface', 'entity:sk1:p'] })).toMatchObject({
      kind: 'instance_pattern',
      instance_pattern: { targets: ['?@ex1:flatface', 'entity:sk1:p'] },
    })
  })

  it('loads a bare row: the app writes half-configured adds, so no field is required', () => {
    expect(loaded({})).toMatchObject({ kind: 'instance_pattern', instance_pattern: {} })
  })

  it('refuses both target forms at once', () => {
    expect(refusal({ sketch: '@sk1', targets: ['?@ex1:flatface'] }))
      .toContain('sketch and targets cannot both be set')
  })

  it('refuses an enum spelling no rule reads', () => {
    expect(refusal({ orientation: 'spin' })).toContain('orientation')
  })

  it('refuses a grid cell in the skip list: a target list has one dimension', () => {
    expect(refusal({ skip: [[1, 2]] })).toContain('skip')
    expect(refusal({ skip: [0] })).toContain('skip')
  })

  it('publishes the row in the feature schema with both target forms', () => {
    const schema = FEATURE_SCHEMA_BY_KIND.instance_pattern
    expect(schema).toBeDefined()
    const text = JSON.stringify(schema)
    expect(text).toContain('"instance_pattern"')
    expect(text).toContain('"sketch"')
    expect(text).toContain('"targets"')
    expect(text).toContain('normal')
  })
})
