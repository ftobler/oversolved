import { describe, it, expect } from 'vitest'
import { sectionPickSource } from '@/viewport/sectionPick'
import { FACE_LAYER_NAME, EDGE_LAYER_NAME, PLANE_LAYER_NAME, SKETCH_ENTITY_LAYER_NAME } from '@/picking/layerNames'

describe('sectionPickSource', () => {
  it('turns a face or a user plane pick into a query source', () => {
    expect(sectionPickSource({ layer: FACE_LAYER_NAME, entityKey: '?04;abcd' }))
      .toEqual({ kind: 'query', query: '?04;abcd' })
    // The plane layer's selection id is `@<featureId>`; the solve result is
    // keyed by the bare feature id.
    expect(sectionPickSource({ layer: PLANE_LAYER_NAME, entityKey: '@Plane1' }))
      .toEqual({ kind: 'query', query: 'Plane1' })
  })

  it('maps a picked builtin reference plane to the builtin source', () => {
    expect(sectionPickSource({ layer: PLANE_LAYER_NAME, entityKey: '@builtin_plane_top' }))
      .toEqual({ kind: 'builtin', id: 'top' })
    expect(sectionPickSource({ layer: PLANE_LAYER_NAME, entityKey: 'builtin_plane_right' }))
      .toEqual({ kind: 'builtin', id: 'right' })
  })

  it('refuses anything that does not name a plane', () => {
    for (const layer of [EDGE_LAYER_NAME, SKETCH_ENTITY_LAYER_NAME, 'originMarker']) {
      expect(sectionPickSource({ layer, entityKey: 'x' })).toBeNull()
    }
  })
})
