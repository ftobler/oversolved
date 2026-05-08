import { describe, it, expect } from 'vitest'
import { getBodiesToRender } from '../bodyUtils'
import type { Feature, BodyResult } from '../../../types/cad'

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
