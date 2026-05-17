import { describe, it, expect } from 'vitest'
import { IdPipeline } from '../IdPipeline'
import { FACE_LAYER_NAME } from '../FaceIdLayer'
import { EDGE_LAYER_NAME } from '../EdgeIdLayer'
import { VERTEX_LAYER_NAME } from '../VertexIdLayer'

describe('IdPipeline layering', () => {
  it('mounts face, edge, vertex layers in priority order', () => {
    const p = new IdPipeline({ width: 100, height: 100 })
    const layers = p.getLayers()
    expect(layers.length).toBe(3)
    expect(layers[0].name).toBe(FACE_LAYER_NAME)
    expect(layers[1].name).toBe(EDGE_LAYER_NAME)
    expect(layers[2].name).toBe(VERTEX_LAYER_NAME)
    p.dispose()
  })

  it('declares the documented z-policy on each layer', () => {
    const p = new IdPipeline({ width: 100, height: 100 })
    const layers = p.getLayers()
    expect(layers[0].zPolicy).toBe('clear-then-fresh')         // face
    expect(layers[1].zPolicy).toBe('depth-test-against-prev')  // edge: reuse face depth
    expect(layers[2].zPolicy).toBe('no-depth')                  // vertex: clear depth, always wins
    p.dispose()
  })

  it('addLayer keeps the array sorted by priority', () => {
    const p = new IdPipeline({ width: 100, height: 100 })
    expect(p.getLayers().map(l => l.priority)).toEqual([0, 10, 20])
    p.dispose()
  })

  it('dispose tears down every layer', () => {
    const p = new IdPipeline({ width: 100, height: 100 })
    p.dispose()
    expect(p.faceLayer.bodyCount()).toBe(0)
    expect(p.edgeLayer.bodyCount()).toBe(0)
    expect(p.vertexLayer.bodyCount()).toBe(0)
  })
})
