import { describe, it, expect } from 'vitest'
import { getBodiesToRender, computeEffectiveVisibleBodies } from '@/components/Viewport/bodyUtils'
import type { Feature, BodyResult, PartStyleEntry } from '@/types/cad'

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

  it('keeps rendering when created_by does not match any feature', () => {
    const orphanBodies: Record<string, BodyResult> = {
      body_orphan: {
        id: 'body_orphan',
        created_by: 'missing_feature',
        modified_by: [],
        mesh: { vertices: [], faces: [], face_data: [], face_queries: [] },
      } as unknown as BodyResult,
    }
    const items = getBodiesToRender(orphanBodies, features, undefined, undefined)
    expect(items).toHaveLength(1)
    expect(items[0].featureId).toBe('missing_feature')
  })

  it('falls back featureId to bodyId when created_by is missing', () => {
    const noCreatorBodies: Record<string, BodyResult> = {
      body_no_creator: {
        id: 'body_no_creator',
        modified_by: [],
        mesh: { vertices: [], faces: [], face_data: [], face_queries: [] },
      } as unknown as BodyResult,
    }
    const items = getBodiesToRender(noCreatorBodies, features, undefined, undefined)
    expect(items).toHaveLength(1)
    expect(items[0].featureId).toBe('body_no_creator')
  })
})

describe('computeEffectiveVisibleBodies', () => {
  const twoBodyResult = (id: string, createdBy: string): BodyResult =>
    ({ id, created_by: createdBy, modified_by: [], mesh: { vertices: [], faces: [] } } as unknown as BodyResult)

  const bodies: Record<string, BodyResult> = {
    body_a: twoBodyResult('body_a', 'feat_a'),
    body_b: twoBodyResult('body_b', 'feat_b'),
  }
  const allVisible = new Set(['feat_a', 'feat_b'])

  const partStyle = (overrides: Record<string, Partial<PartStyleEntry>>): Record<string, PartStyleEntry> => {
    const out: Record<string, PartStyleEntry> = {}
    for (const [id, override] of Object.entries(overrides)) {
      out[id] = { ...override }
    }
    return out
  }

  it('returns undefined when no bodies (nothing to filter)', () => {
    expect(computeEffectiveVisibleBodies(undefined, allVisible, {})).toBeUndefined()
  })

  it('includes all bodies when features are visible and no overrides', () => {
    const result = computeEffectiveVisibleBodies(bodies, allVisible, {})
    expect(result?.has('body_a')).toBe(true)
    expect(result?.has('body_b')).toBe(true)
  })

  it('excludes one body when it is explicitly hidden', () => {
    const result = computeEffectiveVisibleBodies(bodies, allVisible, partStyle({ body_a: { visible: false } }))
    expect(result?.has('body_a')).toBe(false)
    expect(result?.has('body_b')).toBe(true)
  })

  it('returns empty set (not undefined) when all bodies are explicitly hidden', () => {
    const result = computeEffectiveVisibleBodies(bodies, allVisible, partStyle({ body_a: { visible: false }, body_b: { visible: false } }))
    expect(result).toBeInstanceOf(Set)
    expect(result?.size).toBe(0)
  })

  it('excludes body when visible is true but its feature is hidden (no explicit show override)', () => {
    const result = computeEffectiveVisibleBodies(bodies, new Set(), partStyle({ body_a: { visible: true } }))
    expect(result).toBeUndefined()
  })

  it('treats missing visible as visible', () => {
    const result = computeEffectiveVisibleBodies(bodies, allVisible, partStyle({ body_a: { name: 'test' } }))
    expect(result?.has('body_a')).toBe(true)
  })
})
