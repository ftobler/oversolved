import { describe, it, expect } from 'vitest'
import { sectionPickLayers, sectionPickSource, SECTION_PICK_LAYER_NAMES } from '@/viewport/sectionPick'
import { FACE_LAYER_NAME, EDGE_LAYER_NAME, PLANE_LAYER_NAME, SKETCH_ENTITY_LAYER_NAME, VERTEX_LAYER_NAME } from '@/picking/layerNames'

describe('sectionPickSource', () => {
  it('turns a face or a user plane pick into a query source', () => {
    expect(sectionPickSource({ layer: FACE_LAYER_NAME, entityKey: '?04;abcd' }))
      .toEqual({ kind: 'query', query: '?04;abcd' })
    // The plane layer's selection id is `@<featureId>`; the solve result is
    // keyed by the bare feature id.
    expect(sectionPickSource({ layer: PLANE_LAYER_NAME, entityKey: '@Plane1' }))
      .toEqual({ kind: 'query', query: 'Plane1' })
  })

  it('keeps the clicked face pickKey with the source', () => {
    expect(sectionPickSource({
      layer: FACE_LAYER_NAME, entityKey: '?04;abcd', pickKey: 'ex1/body_ex1#face#2',
    })).toEqual({ kind: 'query', query: '?04;abcd', pickKey: 'ex1/body_ex1#face#2' })
  })

  it('maps a picked builtin reference plane to the builtin source', () => {
    expect(sectionPickSource({ layer: PLANE_LAYER_NAME, entityKey: '@builtin_plane_top' }))
      .toEqual({ kind: 'builtin', id: 'top' })
    expect(sectionPickSource({ layer: PLANE_LAYER_NAME, entityKey: 'builtin_plane_right' }))
      .toEqual({ kind: 'builtin', id: 'right' })
  })

  it('refuses anything that does not name a plane', () => {
    for (const layer of [EDGE_LAYER_NAME, SKETCH_ENTITY_LAYER_NAME, VERTEX_LAYER_NAME, 'originMarker']) {
      expect(sectionPickSource({ layer, entityKey: 'x' })).toBeNull()
    }
  })
})

describe('sectionPickLayers', () => {
  it('narrows the consumed layers to faces and planes', () => {
    const consumed = new Set([FACE_LAYER_NAME, EDGE_LAYER_NAME, VERTEX_LAYER_NAME, PLANE_LAYER_NAME])
    expect([...sectionPickLayers(consumed)].sort()).toEqual([FACE_LAYER_NAME, PLANE_LAYER_NAME].sort())
    expect([...SECTION_PICK_LAYER_NAMES].sort()).toEqual([FACE_LAYER_NAME, PLANE_LAYER_NAME].sort())
  })

  it('never adds a layer the editor does not consume', () => {
    expect(sectionPickLayers(new Set([EDGE_LAYER_NAME])).size).toBe(0)
  })
})

