import { describe, it, expect } from 'vitest'
import { getBodiesToRender } from '../bodyUtils'
import type { Feature, BodyResult, Mesh3D } from '../../../types/cad'

const TEST_CUBE_MESH: Mesh3D = {
  vertices: [[0,0,0],[1,0,0],[1,1,0],[0,1,0],[0,0,1],[1,0,1],[1,1,1],[0,1,1]],
  faces: [[0,1,2],[0,2,3],[4,6,5],[4,7,6],[0,4,5],[0,5,1],
          [1,5,6],[1,6,2],[2,6,7],[2,7,3],[3,7,4],[3,4,0]],
  normals: [],
}

const TEST_BODIES: Record<string, BodyResult> = {
  body_ex1: { id: 'body_ex1', created_by: 'ex1', modified_by: [], mesh: TEST_CUBE_MESH },
}

const FEATURES: Feature[] = [
  { id: 'Origin', kind: 'origin' },
  { id: 'Top', kind: 'plane' },
  { id: 'Front', kind: 'plane' },
  { id: 'Right', kind: 'plane' },
  { id: 'sk1', kind: 'sketch' },
  { id: 'ex1', kind: 'extrude', extrude: { sketch: '$sk1', distance: 10, direction: 'normal' } },
]

describe('getBodiesToRender - vertex_queries handling', () => {
  it('passes vertex_queries through for STEP imports', () => {
    const bodies: Record<string, BodyResult> = {
      body_import1: {
        id: 'body_import1',
        created_by: 'import1',
        modified_by: [],
        mesh: TEST_CUBE_MESH,
        vertices: [[0,0,0],[1,0,0],[1,1,0],[0,1,0],[0,0,1],[1,0,1],[1,1,1],[0,1,1]],
        vertex_queries: ['?f;@import1vertex0:vertex', '?f;@import1vertex1:vertex', '?f;@import1vertex2:vertex', '?f;@import1vertex3:vertex', '?f;@import1vertex4:vertex', '?f;@import1vertex5:vertex', '?f;@import1vertex6:vertex', '?f;@import1vertex7:vertex'],
      },
    }
    const features: Feature[] = [
      { id: 'Origin', kind: 'origin' },
      { id: 'import1', kind: 'import_step', file_id: 'test.step' },
    ]
    const items = getBodiesToRender(bodies, features, undefined, new Set(['import1']))
    expect(items).toHaveLength(1)
    expect(items[0].key).toBe('body_import1')
    expect(items[0].featureId).toBe('import1')  // Should use createdBy, not bodyId
    expect(items[0].vertexQueries).toBeDefined()
    expect(items[0].vertexQueries).toHaveLength(8)
    expect(items[0].vertexQueries![0]).toBe('?f;@import1vertex0:vertex')
  })

  it('passes vertex_queries through for extrusions', () => {
    const bodies: Record<string, BodyResult> = {
      body_ex1: {
        id: 'body_ex1',
        created_by: 'ex1',
        modified_by: [],
        mesh: TEST_CUBE_MESH,
        vertices: [[0,0,0],[1,0,0],[1,1,0],[0,1,0],[0,0,1],[1,0,1],[1,1,1],[0,1,1]],
        vertex_queries: ['?b;@ex1vertex0:vertex', '?b;@ex1vertex1:vertex', '?b;@ex1vertex2:vertex', '?b;@ex1vertex3:vertex', '?b;@ex1vertex4:vertex', '?b;@ex1vertex5:vertex', '?b;@ex1vertex6:vertex', '?b;@ex1vertex7:vertex'],
      },
    }
    const features: Feature[] = [
      { id: 'Origin', kind: 'origin' },
      { id: 'ex1', kind: 'extrude', extrude: { sketch: '$sk1', distance: 10, direction: 'normal' } },
    ]
    const items = getBodiesToRender(bodies, features, undefined, new Set(['ex1']))
    expect(items).toHaveLength(1)
    expect(items[0].key).toBe('body_ex1')
    expect(items[0].vertexQueries).toBeDefined()
    expect(items[0].vertexQueries).toHaveLength(8)
    expect(items[0].vertexQueries![0]).toBe('?b;@ex1vertex0:vertex')
  })

  it('handles body without vertex_queries', () => {
    const bodies: Record<string, BodyResult> = {
      body_ex1: {
        id: 'body_ex1',
        created_by: 'ex1',
        modified_by: [],
        mesh: TEST_CUBE_MESH,
        // No vertices or vertex_queries
      },
    }
    const features: Feature[] = [
      { id: 'Origin', kind: 'origin' },
      { id: 'ex1', kind: 'extrude', extrude: { sketch: '$sk1', distance: 10, direction: 'normal' } },
    ]
    const items = getBodiesToRender(bodies, features, undefined, new Set(['ex1']))
    expect(items).toHaveLength(1)
    expect(items[0].vertices).toBeUndefined()
    expect(items[0].vertexQueries).toBeUndefined()
  })
})

describe('getBodiesToRender', () => {
  it('renders body with mesh', () => {
    const items = getBodiesToRender(TEST_BODIES, FEATURES, undefined, new Set(['ex1']))
    expect(items).toHaveLength(1)
    expect(items[0].key).toBe('body_ex1')
    expect(items[0].featureId).toBe('ex1')  // Uses createdBy, not bodyId
    expect(items[0].mesh).toBe(TEST_CUBE_MESH)
    expect(items[0].visible).toBe(true)
  })

  it('skips body with no mesh (mesh_error)', () => {
    const bodies: Record<string, BodyResult> = {
      body_ex1: { id: 'body_ex1', created_by: 'ex1', modified_by: [], mesh_error: 'no shape' },
    }
    const items = getBodiesToRender(bodies, FEATURES, undefined, new Set(['ex1']))
    expect(items).toHaveLength(0)
  })

  it('sets visible=false when created_by feature is hidden', () => {
    const items = getBodiesToRender(TEST_BODIES, FEATURES, undefined, new Set())
    expect(items).toHaveLength(1)
    expect(items[0].visible).toBe(false)
  })

  it('returns empty array when bodies is undefined', () => {
    const items = getBodiesToRender(undefined, FEATURES, undefined, new Set(['ex1']))
    expect(items).toHaveLength(0)
  })

  it('skips body when created_by feature is rolled back', () => {
    const items = getBodiesToRender(TEST_BODIES, FEATURES, 5, new Set(['ex1']))
    expect(items).toHaveLength(0)
  })

  it('skips body when created_by feature not found in features', () => {
    const items = getBodiesToRender(TEST_BODIES, FEATURES.slice(0, 3), undefined, new Set(['ex1']))
    expect(items).toHaveLength(0)
  })

  it('renders multiple bodies independently', () => {
    const bodies: Record<string, BodyResult> = {
      body_ex1: { id: 'body_ex1', created_by: 'ex1', modified_by: [], mesh: TEST_CUBE_MESH },
      body_ex2: { id: 'body_ex2', created_by: 'ex2', modified_by: [], mesh: TEST_CUBE_MESH },
    }
    const features: Feature[] = [
      ...FEATURES,
      { id: 'ex2', kind: 'extrude', extrude: { sketch: '$sk1', distance: 20, direction: 'normal' } },
    ]
    const items = getBodiesToRender(bodies, features, undefined, new Set(['ex1', 'ex2']))
    expect(items).toHaveLength(2)
    expect(items.map(i => i.key)).toContain('body_ex1')
    expect(items.map(i => i.key)).toContain('body_ex2')
  })

  it('skips body with mesh_error even when status is ok', () => {
    const bodies: Record<string, BodyResult> = {
      body_ex1: { id: 'body_ex1', created_by: 'ex1', modified_by: [], mesh_error: 'tessellation failed' },
    }
    const items = getBodiesToRender(bodies, FEATURES, undefined, new Set(['ex1']))
    expect(items).toHaveLength(0)
  })

  it('renders body visibly when visibleFeatures is undefined', () => {
    const items = getBodiesToRender(TEST_BODIES, FEATURES, undefined, undefined)
    expect(items).toHaveLength(1)
    expect(items[0].visible).toBe(true)
  })
})