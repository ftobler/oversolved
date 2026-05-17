import { describe, it, expect } from 'vitest'
import {
  IdPipeline,
  DIMENSION_LABEL_LAYER_NAME,
  DIMENSION_LABEL_FAT_PIXELS,
} from '../IdPipeline'

describe('dimensionLabel ID layer', () => {
  it('is mounted with priority 70 and no-depth policy', () => {
    const p = new IdPipeline({ width: 100, height: 100 })
    const layer = p.dimensionLabelLayer
    expect(layer.name).toBe(DIMENSION_LABEL_LAYER_NAME)
    expect(layer.priority).toBe(70)
    expect(layer.zPolicy).toBe('no-depth')
    p.dispose()
  })

  it('uses the documented fat-pixel hit radius', () => {
    const p = new IdPipeline({ width: 100, height: 100 })
    p.dimensionLabelLayer.registerBody({
      bodyKey: 'dim:c1',
      vertices: [[0, 0, 0]],
      vertexQueries: ['dim:c1'],
    })
    p.dimensionLabelLayer.onBeforeRender!(800, 600)
    const im = p.dimensionLabelLayer.scene.children[0] as import('three').InstancedMesh
    const mat = im.material as import('three').ShaderMaterial
    expect(mat.uniforms.uFatPixels.value).toBe(DIMENSION_LABEL_FAT_PIXELS)
    p.dispose()
  })

  it('registration round-trips one ID per (constraintId, sub)', () => {
    const p = new IdPipeline({ width: 100, height: 100 })
    p.dimensionLabelLayer.registerBody({
      bodyKey: 'dim:c1:value-1',
      vertices: [[0, 0, 0]],
      vertexQueries: ['dim:c1:value-1'],
    })
    p.dimensionLabelLayer.registerBody({
      bodyKey: 'dim:c1:value-2',
      vertices: [[1, 0, 0]],
      vertexQueries: ['dim:c1:value-2'],
    })
    expect(p.registry.lookupKey(DIMENSION_LABEL_LAYER_NAME, 'dim:c1:value-1')).toBeDefined()
    expect(p.registry.lookupKey(DIMENSION_LABEL_LAYER_NAME, 'dim:c1:value-2')).toBeDefined()
    expect(p.dimensionLabelLayer.bodyCount()).toBe(2)
    p.dispose()
  })

  it('unregister frees the allocated id', () => {
    const p = new IdPipeline({ width: 100, height: 100 })
    p.dimensionLabelLayer.registerBody({
      bodyKey: 'dim:c1',
      vertices: [[0, 0, 0]],
      vertexQueries: ['dim:c1'],
    })
    expect(p.registry.size()).toBe(1)
    p.dimensionLabelLayer.unregisterBody('dim:c1')
    expect(p.registry.size()).toBe(0)
    p.dispose()
  })
})
