import { describe, it, expect } from 'vitest'
import { getBodiesToRender, computeEffectiveVisibleBodies } from '@/components/Viewport/bodyUtils'
import type { Feature, BodyResult } from '@/types/cad'

describe('getBodiesToRender', () => {
  const features: Feature[] = [
    { id: 'sk1', kind: 'sketch' },
    { id: 'ex1', kind: 'extrude' },
  ]

  const bodies: Record<string, BodyResult> = {
    body_ex1: {
      id: 'body_ex1',
      created_by: 'ex1',
      modified_by: [],
      mesh: {
        vertices: [],
        normals: [],
        faces: [],
        face_data: [],
        face_queries: [],
      },
    } as unknown as BodyResult,
  }

  it('renders all bodies when visibleBodies is undefined', () => {
    const items = getBodiesToRender(bodies, features, undefined, undefined)
    expect(items).toHaveLength(1)
    expect(items[0].featureId).toBe('ex1')
  })

  it('marks bodies not in visibleBodies set as invisible', () => {
    const visible = new Set<string>()
    const items = getBodiesToRender(bodies, features, undefined, visible)
    expect(items).toHaveLength(1)
    expect(items[0].visible).toBe(false)
  })

  it('marks bodies in visibleBodies set as visible', () => {
    const visible = new Set(['body_ex1'])
    const items = getBodiesToRender(bodies, features, undefined, visible)
    expect(items).toHaveLength(1)
    expect(items[0].visible).toBe(true)
  })

  it('filters by rollbackPosition', () => {
    const items = getBodiesToRender(bodies, features, 1, new Set(['body_ex1']))
    expect(items).toHaveLength(0)
  })

  it('returns one item per visible body', () => {
    const items = getBodiesToRender(bodies, features, undefined, undefined)
    expect(items).toHaveLength(1)
  })
})

describe('computeEffectiveVisibleBodies', () => {
  const twoBodyResult = (id: string, createdBy: string): BodyResult =>
    ({ id, created_by: createdBy, modified_by: [], mesh: { vertices: [], normals: [], faces: [] } } as unknown as BodyResult)

  const bodies: Record<string, BodyResult> = {
    body_a: twoBodyResult('body_a', 'feat_a'),
    body_b: twoBodyResult('body_b', 'feat_b'),
  }
  const allVisible = new Set(['feat_a', 'feat_b'])

  it('returns undefined when no bodies (nothing to filter)', () => {
    expect(computeEffectiveVisibleBodies(undefined, allVisible, {})).toBeUndefined()
  })

  it('includes all bodies when features are visible and no overrides', () => {
    const result = computeEffectiveVisibleBodies(bodies, allVisible, {})
    expect(result?.has('body_a')).toBe(true)
    expect(result?.has('body_b')).toBe(true)
  })

  it('excludes one body when it is explicitly hidden', () => {
    const result = computeEffectiveVisibleBodies(bodies, allVisible, { body_a: false })
    expect(result?.has('body_a')).toBe(false)
    expect(result?.has('body_b')).toBe(true)
  })

  it('returns empty set (not undefined) when all bodies are explicitly hidden', () => {
    // Bug fix: hiding all bodies previously snapped back to "show all"
    // because visible.size === 0 was treated as undefined (no filter).
    const result = computeEffectiveVisibleBodies(bodies, allVisible, { body_a: false, body_b: false })
    expect(result).toBeInstanceOf(Set)
    expect(result?.size).toBe(0)
  })

  it('keeps body_a visible when explicitly set true even if its feature is hidden', () => {
    const result = computeEffectiveVisibleBodies(bodies, new Set(), { body_a: true })
    expect(result?.has('body_a')).toBe(true)
  })
})
