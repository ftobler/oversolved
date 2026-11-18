import { describe, it, expect, afterEach, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import type { Sketch, LineSegment } from '@/types/cad'
import { IdPipeline } from '../IdPipeline'
import { setLivePipeline } from '../IdPipelineContext'
import { useOriginMarkerIdRegistration } from '../useOriginMarkerIdRegistration'
import { usePlaneIdRegistration } from '../usePlaneIdRegistration'
import { useFeatureHandleIdRegistration } from '../useFeatureHandleIdRegistration'
import { useDimensionLabelIdRegistration } from '../useDimensionLabelIdRegistration'
import { useSketchIdRegistration } from '../useSketchIdRegistration'

/**
 * g4-M2: `IdRegistry.allocate` throws on 24-bit ID exhaustion. React 19
 * escalates a passive-effect throw to the nearest error boundary, and the
 * viewport has none, so an unguarded `registerPart` throw unmounts the whole
 * root. Every helper registration hook must swallow it (warn + no markDirty),
 * exactly as the body hooks do.
 */
describe('helper registration hooks survive a throwing registerPart (g4-M2)', () => {
  afterEach(() => {
    setLivePipeline(null)
    vi.restoreAllMocks()
  })

  function livePipeline(): IdPipeline {
    const p = new IdPipeline({ width: 64, height: 64 })
    setLivePipeline(p)
    return p
  }

  const cornerSketch = (): Sketch => ({
    lineA: { start: [0, 0], end: [2, 0] } as LineSegment,
    lineB: { start: [2, 0], end: [2, 2] } as LineSegment,
  })

  const cases: {
    name: string
    layer: (p: IdPipeline) => { registerPart: (...a: never[]) => unknown }
    useRun: () => void
    bodyCount: (p: IdPipeline) => number
  }[] = [
    {
      name: 'origin marker',
      layer: (p) => p.originLayer,
      useRun: () => useOriginMarkerIdRegistration({ selectionId: '@origin' }),
      bodyCount: (p) => p.originLayer.partCount(),
    },
    {
      name: 'plane',
      layer: (p) => p.planeLayer,
      useRun: () => usePlaneIdRegistration({ selectionId: '@plane', size: 10 }),
      bodyCount: (p) => p.planeLayer.partCount(),
    },
    {
      name: 'feature handle',
      layer: (p) => p.featureHandleLayer,
      useRun: () => useFeatureHandleIdRegistration({
        featureId: 'f1', field: 'distance', start: [0, 0, 0], end: [0, 0, 1],
      }),
      bodyCount: (p) => p.featureHandleLayer.partCount(),
    },
    {
      name: 'dimension label',
      layer: (p) => p.dimensionLabelLayer,
      useRun: () => useDimensionLabelIdRegistration({ constraintId: 'c1', position: [1, 1, 0] }),
      bodyCount: (p) => p.dimensionLabelLayer.partCount(),
    },
    {
      name: 'sketch entities',
      layer: (p) => p.sketchEntityLayer,
      useRun: () => useSketchIdRegistration({ featureId: 'S1', sketch: cornerSketch() }),
      bodyCount: (p) => p.sketchEntityLayer.partCount(),
    },
    {
      name: 'sketch vertices',
      layer: (p) => p.sketchVertexLayer,
      useRun: () => useSketchIdRegistration({ featureId: 'S1', sketch: cornerSketch() }),
      bodyCount: (p) => p.sketchVertexLayer.partCount(),
    },
  ]

  for (const c of cases) {
    it(`${c.name}: a registerPart throw does not escape the effect`, () => {
      const p = livePipeline()
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      vi.spyOn(c.layer(p), 'registerPart').mockImplementation(() => {
        throw new Error('IdRegistry: exhausted 24-bit ID space')
      })

      expect(() => renderHook(() => c.useRun())).not.toThrow()
      expect(c.bodyCount(p)).toBe(0)
      expect(warn).toHaveBeenCalled()
      p.dispose()
    })
  }
})
