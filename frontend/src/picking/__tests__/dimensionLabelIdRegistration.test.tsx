import { describe, it, expect } from 'vitest'
import { renderHook } from '@testing-library/react'
import { IdPipeline, DIMENSION_LABEL_LAYER_NAME } from '../IdPipeline'
import { setLivePipeline } from '../IdPipelineContext'
import { useDimensionLabelIdRegistration } from '../useDimensionLabelIdRegistration'

describe('useDimensionLabelIdRegistration', () => {
  it('registers under dim:<cid> when no sub-key is given', () => {
    const p = new IdPipeline({ width: 100, height: 100 })
    setLivePipeline(p)
    try {
      const { unmount } = renderHook(() => useDimensionLabelIdRegistration({
        constraintId: 'cid1',
        position: [1, 2, 0.001],
      }))
      expect(p.registry.lookupKey(DIMENSION_LABEL_LAYER_NAME, 'dim:cid1')).toBeDefined()
      unmount()
      expect(p.registry.lookupKey(DIMENSION_LABEL_LAYER_NAME, 'dim:cid1')).toBeUndefined()
    } finally {
      setLivePipeline(null)
      p.dispose()
    }
  })

  it('encodes sub-key into the entity key so two hit circles per constraint do not collide', () => {
    const p = new IdPipeline({ width: 100, height: 100 })
    setLivePipeline(p)
    try {
      renderHook(() => useDimensionLabelIdRegistration({
        constraintId: 'cid1', position: [0, 0, 0], sub: 'value-1',
      }))
      renderHook(() => useDimensionLabelIdRegistration({
        constraintId: 'cid1', position: [1, 0, 0], sub: 'value-2',
      }))
      expect(p.registry.lookupKey(DIMENSION_LABEL_LAYER_NAME, 'dim:cid1:value-1')).toBeDefined()
      expect(p.registry.lookupKey(DIMENSION_LABEL_LAYER_NAME, 'dim:cid1:value-2')).toBeDefined()
      expect(p.dimensionLabelLayer.bodyCount()).toBe(2)
    } finally {
      setLivePipeline(null)
      p.dispose()
    }
  })

  it('does not register when disabled', () => {
    const p = new IdPipeline({ width: 100, height: 100 })
    setLivePipeline(p)
    try {
      renderHook(() => useDimensionLabelIdRegistration({
        constraintId: 'cid1', position: [0, 0, 0], enabled: false,
      }))
      expect(p.registry.lookupKey(DIMENSION_LABEL_LAYER_NAME, 'dim:cid1')).toBeUndefined()
      expect(p.dimensionLabelLayer.bodyCount()).toBe(0)
    } finally {
      setLivePipeline(null)
      p.dispose()
    }
  })
})
