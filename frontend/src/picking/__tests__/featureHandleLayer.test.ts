import { describe, it, expect } from 'vitest'
import {
  IdPipeline,
  FEATURE_HANDLE_LAYER_NAME,
} from '../IdPipeline'
import { featureHandleKey } from '../useFeatureHandleIdRegistration'

describe('featureHandle ID layer', () => {
  it('is mounted with priority 80 (above dimension labels) and no-depth policy', () => {
    const p = new IdPipeline({ width: 100, height: 100 })
    const layer = p.featureHandleLayer
    expect(layer.name).toBe(FEATURE_HANDLE_LAYER_NAME)
    expect(layer.priority).toBe(80)
    expect(layer.priority).toBeGreaterThan(p.dimensionLabelLayer.priority)
    expect(layer.zPolicy).toBe('no-depth')
    p.dispose()
  })

  it('is part of the render order and layer priority map', () => {
    const p = new IdPipeline({ width: 100, height: 100 })
    expect(p.getLayers()[p.getLayers().length - 1].name).toBe(FEATURE_HANDLE_LAYER_NAME)
    expect(p.getLayerPriority()[FEATURE_HANDLE_LAYER_NAME]).toBe(80)
    p.dispose()
  })

  it('registration round-trips the fhandle key and unregister frees the id', () => {
    const p = new IdPipeline({ width: 100, height: 100 })
    const key = featureHandleKey('ex1', 'distance')
    expect(key).toBe('fhandle:ex1:distance')
    p.featureHandleLayer.registerBody({
      bodyKey: key,
      vertices: [[5, 5, 5]],
      vertexQueries: [key],
    })
    expect(p.registry.lookupKey(FEATURE_HANDLE_LAYER_NAME, key)).toBeDefined()
    expect(p.registry.size()).toBe(1)
    p.featureHandleLayer.unregisterBody(key)
    expect(p.registry.size()).toBe(0)
    p.dispose()
  })
})
