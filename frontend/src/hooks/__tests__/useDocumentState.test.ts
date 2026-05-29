import { describe, it, expect } from 'vitest'
import { BUILTIN_FEATURE_DEFAULTS, BUILTIN_FEATURE_IDS } from '@/hooks/useDocumentState'

describe('BUILTIN_FEATURE_DEFAULTS', () => {
  it('contains the four standard built-in features', () => {
    expect(BUILTIN_FEATURE_DEFAULTS).toHaveLength(4)
  })

  it('includes Origin, Top, Front, Right', () => {
    const ids = BUILTIN_FEATURE_DEFAULTS.map(f => f.id).sort()
    expect(ids).toEqual(['Front', 'Origin', 'Right', 'Top'])
  })

  it('has correct kinds', () => {
    const origin = BUILTIN_FEATURE_DEFAULTS.find(f => f.id === 'Origin')
    expect(origin?.kind).toBe('origin')
    const planes = BUILTIN_FEATURE_DEFAULTS.filter(f => f.id !== 'Origin')
    expect(planes.every(p => p.kind === 'plane')).toBe(true)
  })
})

describe('BUILTIN_FEATURE_IDS', () => {
  it('is a Set of the same four IDs', () => {
    expect(BUILTIN_FEATURE_IDS.size).toBe(4)
    expect(BUILTIN_FEATURE_IDS.has('Origin')).toBe(true)
    expect(BUILTIN_FEATURE_IDS.has('Top')).toBe(true)
    expect(BUILTIN_FEATURE_IDS.has('Front')).toBe(true)
    expect(BUILTIN_FEATURE_IDS.has('Right')).toBe(true)
  })

  it('does not contain arbitrary IDs', () => {
    expect(BUILTIN_FEATURE_IDS.has('S1')).toBe(false)
    expect(BUILTIN_FEATURE_IDS.has('extrude1')).toBe(false)
  })
})
