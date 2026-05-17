import { describe, it, expect } from 'vitest'
import { IdPipeline } from '../IdPipeline'
import { FACE_LAYER_NAME } from '../FaceIdLayer'
import { EDGE_LAYER_NAME } from '../EdgeIdLayer'
import { VERTEX_LAYER_NAME } from '../VertexIdLayer'

describe('IdPipeline layering', () => {
  it('mounts B-rep + helper layers in priority order', () => {
    const p = new IdPipeline({ width: 100, height: 100 })
    const layers = p.getLayers()
    expect(layers.map(l => l.name)).toEqual([
      FACE_LAYER_NAME, EDGE_LAYER_NAME, VERTEX_LAYER_NAME,
      'planeFace', 'sketchEntity', 'sketchVertex', 'originMarker',
    ])
    p.dispose()
  })

  it('declares the documented z-policy on each layer', () => {
    const p = new IdPipeline({ width: 100, height: 100 })
    const layers = p.getLayers()
    expect(layers[0].zPolicy).toBe('clear-then-fresh')         // face
    expect(layers[1].zPolicy).toBe('depth-test-against-prev')  // edge: reuse face depth
    expect(layers[2].zPolicy).toBe('no-depth')                  // vertex
    expect(layers[3].zPolicy).toBe('clear-then-fresh')          // planeFace
    expect(layers[4].zPolicy).toBe('clear-then-fresh')          // sketchEntity
    expect(layers[5].zPolicy).toBe('no-depth')                  // sketchVertex
    expect(layers[6].zPolicy).toBe('no-depth')                  // originMarker
    p.dispose()
  })

  it('addLayer keeps the array sorted by priority', () => {
    const p = new IdPipeline({ width: 100, height: 100 })
    expect(p.getLayers().map(l => l.priority)).toEqual([0, 10, 20, 30, 40, 50, 60])
    p.dispose()
  })

  it('dispose tears down every layer', () => {
    const p = new IdPipeline({ width: 100, height: 100 })
    p.dispose()
    expect(p.faceLayer.bodyCount()).toBe(0)
    expect(p.edgeLayer.bodyCount()).toBe(0)
    expect(p.vertexLayer.bodyCount()).toBe(0)
    expect(p.planeLayer.bodyCount()).toBe(0)
    expect(p.sketchEntityLayer.bodyCount()).toBe(0)
    expect(p.sketchVertexLayer.bodyCount()).toBe(0)
    expect(p.originLayer.bodyCount()).toBe(0)
  })
})
