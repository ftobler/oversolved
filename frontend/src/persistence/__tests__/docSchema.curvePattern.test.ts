// The curve pattern's document row and boundary: the loader accepts the fields
// the editor and the drive write and refuses a value no rule reads (an enum
// outside its list, a grid cell in a one-dimensional skip list), and the
// published schema carries the same row.
import { describe, it, expect } from 'vitest'
import { loadPartDoc } from '@/persistence/docSchema'
import { FEATURE_SCHEMA_BY_KIND } from '@/persistence/partDocSchema'

function doc(curve: unknown): Record<string, unknown> {
  return {
    version: 9,
    kind: 'part',
    features: [
      { id: 'sk1', kind: 'sketch', plane: '@builtin_plane_front', entities: [{ id: 'l', kind: 'line' }], initial: { l: [0, 0, 10, 0] }, constraints: [] },
      { id: 'cv1', kind: 'curve_pattern', label: 'Curve', curve_pattern: curve },
    ],
  }
}

function loaded(curve: unknown): Record<string, unknown> {
  const result = loadPartDoc(doc(curve))
  expect(result.ok, JSON.stringify(!result.ok ? result.error : null)).toBe(true)
  if (!result.ok) throw new Error('load failed')
  return (result.doc.features as Record<string, unknown>[])[1]
}

function refusal(curve: unknown): string {
  const result = loadPartDoc(doc(curve))
  if (result.ok) throw new Error(`expected a refusal for ${JSON.stringify(curve)}`)
  return JSON.stringify(result.error)
}

describe('the curve pattern document row', () => {
  it('loads the full set of fields', () => {
    const feature = loaded({
      subject: 'body', source_body: '@body_ex1', operation: 'add',
      path: ['@sk1'], count: 4, spacing: 'distance', distance: 12.5,
      reverse: true, orientation: 'normal_to', normal_ref: '@builtin_plane_top', skip: [2],
    })
    expect(feature.id).toBe('cv1')
    expect(feature.kind).toBe('curve_pattern')
    expect(feature.curve_pattern).toEqual({
      subject: 'body', source_body: '@body_ex1', operation: 'add',
      path: ['@sk1'], count: 4, spacing: 'distance', distance: 12.5,
      reverse: true, orientation: 'normal_to', normal_ref: '@builtin_plane_top', skip: [2],
    })
  })

  it('loads a bare row: the app writes half-configured adds, so no field is required', () => {
    expect(loaded({})).toMatchObject({ kind: 'curve_pattern', curve_pattern: {} })
    expect(loaded({ path: '@sk1' })).toMatchObject({ kind: 'curve_pattern', curve_pattern: { path: '@sk1' } })
  })

  it('refuses an enum spelling no rule reads', () => {
    expect(refusal({ spacing: 'pitch' })).toContain('spacing')
    expect(refusal({ orientation: 'radial' })).toContain('orientation')
  })

  it('refuses a grid cell in the skip list: a path has one dimension', () => {
    expect(refusal({ skip: [[1, 2]] })).toContain('skip')
    expect(refusal({ skip: [0] })).toContain('skip')
  })

  it('refuses a count that generates nothing', () => {
    expect(refusal({ count: 0 })).toContain('count')
    expect(refusal({ count: 2.5 })).toContain('count')
  })

  it('publishes the row in the feature schema, path as a feature-level ref', () => {
    const schema = FEATURE_SCHEMA_BY_KIND.curve_pattern
    expect(schema).toBeDefined()
    const text = JSON.stringify(schema)
    expect(text).toContain('"curve_pattern"')
    expect(text).toContain('normal_to')
    expect(text).toContain('"path"')
  })
})
