import { describe, it, expect } from 'vitest'
import { IdPipeline, PLANE_LAYER_NAME } from '../IdPipeline'

/**
 * The plane layer is a FaceIdLayer instance configured with name='planeFace',
 * priority=-10, zPolicy='clear-then-fresh'. It renders behind the B-rep
 * stack so bodies occlude the plane in the ID buffer.
 * This test exercises it via the pipeline so we also pin the layer-config wiring.
 */

describe('PlaneIdLayer (via pipeline)', () => {
  it('registers each plane as a single body with one face query', () => {
    const p = new IdPipeline({ width: 100, height: 100 })
    const tri2 = new Uint32Array([0, 0])
    const positions = new Float32Array([
      -1, -1, 0,  1, -1, 0,  1, 1, 0,
      -1, -1, 0,  1, 1, 0,  -1, 1, 0,
    ])
    p.planeLayer.registerBody({
      bodyKey: '@builtin_plane_top',
      positions,
      triangleToFace: tri2,
      faceQueries: ['@builtin_plane_top'],
    })
    p.planeLayer.registerBody({
      bodyKey: '@builtin_plane_front',
      positions,
      triangleToFace: tri2,
      faceQueries: ['@builtin_plane_front'],
    })
    expect(p.planeLayer.bodyCount()).toBe(2)
    expect(p.registry.lookupKey(PLANE_LAYER_NAME, '@builtin_plane_top')).toBeDefined()
    expect(p.registry.lookupKey(PLANE_LAYER_NAME, '@builtin_plane_front')).toBeDefined()
    p.dispose()
  })

  it('plane layer renders before B-rep (priority=-10 < face=0)', () => {
    const p = new IdPipeline({ width: 100, height: 100 })
    const layers = p.getLayers()
    const planeIdx = layers.findIndex(l => l.name === PLANE_LAYER_NAME)
    const faceIdx = layers.findIndex(l => l.name === 'face')
    expect(planeIdx).toBeLessThan(faceIdx)
    p.dispose()
  })
})
