import { describe, it, expect } from 'vitest'
import { sectionPickSource } from '@/viewport/sectionPick'
import { FACE_LAYER_NAME, EDGE_LAYER_NAME, PLANE_LAYER_NAME, SKETCH_ENTITY_LAYER_NAME } from '@/picking/layerNames'

describe('sectionPickSource', () => {
  it('turns a face or a user/reference plane pick into a query source', () => {
    expect(sectionPickSource({ layer: FACE_LAYER_NAME, entityKey: '?04;abcd' }))
      .toEqual({ kind: 'query', query: '?04;abcd' })
    expect(sectionPickSource({ layer: PLANE_LAYER_NAME, entityKey: 'Plane1' }))
      .toEqual({ kind: 'query', query: 'Plane1' })
  })

  it('refuses anything that does not name a plane', () => {
    for (const layer of [EDGE_LAYER_NAME, SKETCH_ENTITY_LAYER_NAME, 'originMarker']) {
      expect(sectionPickSource({ layer, entityKey: 'x' })).toBeNull()
    }
  })
})
