import { describe, it, expect } from 'vitest'
import { renderHook } from '@testing-library/react'
import { IdPipeline, DIMENSION_LABEL_LAYER_NAME } from '../IdPipeline'
import { setLivePipeline } from '../IdPipelineContext'
import { useDimensionLabelIdRegistration } from '../useDimensionLabelIdRegistration'
import type { PlaneTransform } from '@/types/cad'

const IDENTITY_PLANE = (): PlaneTransform => ({
  rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], origin: [0, 0, 0],
})

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

  it('an equal-valued fresh PlaneTransform does not re-register (g4-L2)', () => {
    const p = new IdPipeline({ width: 100, height: 100 })
    setLivePipeline(p)
    try {
      const { rerender } = renderHook(
        ({ planeTransform }) => useDimensionLabelIdRegistration({
          constraintId: 'cid1', position: [1, 2, 0], planeTransform,
        }),
        { initialProps: { planeTransform: IDENTITY_PLANE() } },
      )
      const id1 = p.registry.lookupKey(DIMENSION_LABEL_LAYER_NAME, 'dim:cid1')
      expect(id1).toBeDefined()

      // A fresh object with identical values: the hook keyed the effect on
      // planeTransformKey, so no free + realloc churn.
      rerender({ planeTransform: IDENTITY_PLANE() })
      expect(p.dimensionLabelLayer.bodyCount()).toBe(1)
      expect(p.registry.lookupKey(DIMENSION_LABEL_LAYER_NAME, 'dim:cid1')).toBe(id1)

      // A genuinely different plane does re-register.
      rerender({ planeTransform: { rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], origin: [5, 0, 0] } })
      expect(p.registry.lookupKey(DIMENSION_LABEL_LAYER_NAME, 'dim:cid1')).not.toBe(id1)
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
