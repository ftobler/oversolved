import { describe, it, expect } from 'vitest'
import { resolveDrawPressSnap } from '@/utils/geometry/drawPressSnap'
import type { Entity } from '@/types/cad'
import {
  EDGE_LAYER_NAME, ORIGIN_LAYER_NAME, SKETCH_ENTITY_LAYER_NAME, SKETCH_VERTEX_LAYER_NAME,
} from '@/picking/layerNames'

// The press snap is built from the id-buffer hit at the press pixel, never from
// the async store hover, so every drawing tool commits from the pixel the user
// pressed. These pin what each layer contributes to that snap.

const SKETCH: Record<string, Entity> = {
  L1: { start: [0, 0], end: [10, 0] } as Entity,
}
const GEO = { sketch: SKETCH }

describe('resolveDrawPressSnap', () => {
  it('carries a sketch vertex id and the position of the entity it names', () => {
    expect(resolveDrawPressSnap(
      { layer: SKETCH_VERTEX_LAYER_NAME, entityKey: 'vertex:S1:L1:end' },
      [0, 0],
      GEO,
    )).toEqual({
      hoveredVertexId: 'vertex:S1:L1:end',
      hoveredVertexPosition: [10, 0],
      hoveredSnapKind: 'vertex',
      hoveredSelectionId: 'vertex:S1:L1:end',
    })
  })

  it('finds a foreign sketch vertex through the geometry it was handed', () => {
    expect(resolveDrawPressSnap(
      { layer: SKETCH_VERTEX_LAYER_NAME, entityKey: 'vertex:S2:L1:end' },
      [0, 0],
      { otherSketches: { S2: SKETCH } },
    ).hoveredVertexPosition).toEqual([10, 0])
  })

  it('publishes the active origin frame position for the origin marker', () => {
    expect(resolveDrawPressSnap(
      { layer: ORIGIN_LAYER_NAME, entityKey: '@builtin_origin' },
      [-37.5, 12.25],
      GEO,
    )).toEqual({
      hoveredVertexId: '@builtin_origin',
      hoveredVertexPosition: [-37.5, 12.25],
      hoveredSnapKind: 'vertex',
      hoveredSelectionId: '@builtin_origin',
    })
  })

  it('reads a sketch curve hit as a selection only, with no vertex claim', () => {
    expect(resolveDrawPressSnap(
      { layer: SKETCH_ENTITY_LAYER_NAME, entityKey: 'entity:S1:L1' },
      [0, 0],
      GEO,
    )).toEqual({
      hoveredVertexId: null,
      hoveredVertexPosition: null,
      hoveredSnapKind: null,
      hoveredSelectionId: 'entity:S1:L1',
    })
  })

  it('reads a B-rep hit as a selection only, which the project tool lowers', () => {
    expect(resolveDrawPressSnap(
      { layer: EDGE_LAYER_NAME, entityKey: '?4,4;@bxx@fyy:edge' },
      [0, 0],
      GEO,
    )).toEqual({
      hoveredVertexId: null,
      hoveredVertexPosition: null,
      hoveredSnapKind: null,
      hoveredSelectionId: '?4,4;@bxx@fyy:edge',
    })
  })

  it('answers a miss with no snap and no selection', () => {
    expect(resolveDrawPressSnap(null, [0, 0], GEO)).toEqual({
      hoveredVertexId: null,
      hoveredVertexPosition: null,
      hoveredSnapKind: null,
      hoveredSelectionId: null,
    })
  })

  it('keeps the vertex id when the entity cannot be resolved, without inventing a position', () => {
    // A ref the geometry does not hold still names the point; the click then
    // lands on the raw press point and the coincident pulls it onto the vertex.
    expect(resolveDrawPressSnap(
      { layer: SKETCH_VERTEX_LAYER_NAME, entityKey: 'vertex:S1:GONE:end' },
      [0, 0],
      GEO,
    )).toMatchObject({
      hoveredVertexId: 'vertex:S1:GONE:end',
      hoveredVertexPosition: null,
      hoveredSnapKind: 'vertex',
    })
  })
})
