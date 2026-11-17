// The wrap's document row: the loader accepts the authored fields (an
// expression height, an absent target the solve soft fails on) and refuses a
// value no rule reads; the published schema carries the same row. There is no
// version bump for the kind, because an unknown kind loads and the solver
// refuses it by name.
import { describe, it, expect } from 'vitest'
import { loadPartDoc } from '@/persistence/docSchema'
import { FEATURE_SCHEMA_BY_KIND } from '@/persistence/partDocSchema'

function doc(wrap: unknown): Record<string, unknown> {
  return {
    version: 9,
    kind: 'part',
    features: [
      { id: 'sk1', kind: 'sketch', plane: '@builtin_plane_front', entities: [{ id: 'p', kind: 'point' }], initial: { p: [0, 0] }, constraints: [] },
      { id: 'wr1', kind: 'wrap', label: 'Wrap', wrap },
    ],
  }
}

function refusal(wrap: unknown): string {
  const result = loadPartDoc(doc(wrap))
  if (result.ok) throw new Error(`expected a refusal for ${JSON.stringify(wrap)}`)
  return JSON.stringify(result.error)
}

describe('the wrap document row', () => {
  it('loads the full form and an expression height', () => {
    for (const height of [0.5, 't * 2']) {
      const result = loadPartDoc(doc({
        sketch: '@sk1', target: '?face', height, operation: 'cut', merge_target: '@body_ex1',
      }))
      expect(result.ok, JSON.stringify(!result.ok ? result.error : null)).toBe(true)
    }
  })

  it('loads a wrap still waiting for its target', () => {
    expect(loadPartDoc(doc({ sketch: '@sk1', height: 1 })).ok).toBe(true)
  })

  it('refuses a non-positive height, an unknown operation and a non-ref target', () => {
    expect(refusal({ sketch: '@sk1', height: 0 })).toContain('height')
    expect(refusal({ sketch: '@sk1', height: -2 })).toContain('height')
    expect(refusal({ sketch: '@sk1', height: 1, operation: 'emboss' })).toContain('operation')
    expect(refusal({ sketch: '@sk1', height: 1, target: 3 })).toContain('target')
  })

  it('publishes the same row, with no origin or direction field', () => {
    const schema = FEATURE_SCHEMA_BY_KIND.wrap as { properties: { wrap: { properties: Record<string, unknown>; required: string[] } } }
    const row = schema.properties.wrap
    expect(Object.keys(row.properties).sort()).toEqual(['height', 'merge_target', 'operation', 'sketch', 'target'])
    expect(row.required.sort()).toEqual(['height', 'sketch'])
  })
})
