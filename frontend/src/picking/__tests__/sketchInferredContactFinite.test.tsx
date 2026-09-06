import { describe, it, expect, afterEach, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import type { Sketch, LineSegment } from '@/types/cad'
import { IdPipeline, SKETCH_VERTEX_LAYER_NAME } from '../IdPipeline'
import { setLivePipeline } from '../IdPipelineContext'

/**
 * g4-H2: an inferred contact (tangency / curve-curve crossing) whose solved
 * position is non-finite must not become a pickable sketch vertex. The sketch
 * vertex layer publishes every mark position, and `axisCell(NaN)` buckets at the
 * origin while `axisCoincides` reads a NaN pair as coincident, so one NaN
 * contact would answer every click near the origin.
 */
const { candidates } = vi.hoisted(() => ({ candidates: [] as { id: string; position: number[] }[] }))

vi.mock('@/components/Geometry3D/snapDetection', () => ({
  inferredContactCandidates: () => candidates,
}))

const cornerSketch = (): Sketch => ({
  lineA: { start: [0, 0], end: [2, 0] } as LineSegment,
  lineB: { start: [2, 0], end: [2, 2] } as LineSegment,
})

describe('useSketchIdRegistration inferred-contact finite guard (g4-H2)', () => {
  afterEach(() => {
    setLivePipeline(null)
    candidates.length = 0
    vi.restoreAllMocks()
  })

  it('skips a non-finite inferred contact and keeps the finite ones', async () => {
    const { useSketchIdRegistration } = await import('../useSketchIdRegistration')
    candidates.push(
      { id: 'dock:S1:good', position: [1, 1] },
      { id: 'dock:S1:nan', position: [NaN, 0] },
      { id: 'isect:S1:inf', position: [0, Infinity] },
    )
    const p = new IdPipeline({ width: 64, height: 64 })
    setLivePipeline(p)
    try {
      renderHook(() => useSketchIdRegistration({ featureId: 'S1', sketch: cornerSketch() }))

      expect(p.registry.lookupKey(SKETCH_VERTEX_LAYER_NAME, 'dock:S1:good')).toBeDefined()
      expect(p.registry.lookupKey(SKETCH_VERTEX_LAYER_NAME, 'dock:S1:nan')).toBeUndefined()
      expect(p.registry.lookupKey(SKETCH_VERTEX_LAYER_NAME, 'isect:S1:inf')).toBeUndefined()

      // Nothing the layer published sits on the origin by way of a NaN bucket:
      // every real sketch corner recovers only itself or its constrained group.
      for (const rec of [...Array(64)].map((_, i) => p.registry.lookup(i)).filter(Boolean)) {
        expect(rec!.entityKey).not.toBe('dock:S1:nan')
      }
    } finally {
      setLivePipeline(null)
      p.dispose()
    }
  })
})
