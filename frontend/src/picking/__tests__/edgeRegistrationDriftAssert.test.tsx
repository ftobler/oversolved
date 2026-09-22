import { describe, it, expect, afterEach, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import type { EdgeData } from '@/types/cad'
import { IdPipeline } from '../IdPipeline'
import { setLivePipeline } from '../IdPipelineContext'

// buildEdgeSegmentGeometry normally returns positions and the segment -> edge
// map from ONE traversal, so the two agree by construction. The hook asserts
// that agreement so a future refactor that derives them separately cannot
// silently shift every later segment onto the wrong edge query. This stubs the
// builder to disagree and pins the loud failure.
vi.mock('@/components/Geometry3D/bodyGeometry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/Geometry3D/bodyGeometry')>()
  return {
    ...actual,
    buildEdgeSegmentGeometry: () => ({
      positions: new Float32Array(6),  // one built segment
      segmentToEdge: new Uint32Array(0),  // but no map entry for it
    }),
  }
})

import { useEdgeIdRegistration } from '../useEdgeIdRegistration'

describe('useEdgeIdRegistration single-traversal drift assert', () => {
  afterEach(() => {
    setLivePipeline(null)
    vi.restoreAllMocks()
  })

  it('throws when the built segment positions and their edge map disagree', () => {
    const pipeline = new IdPipeline({ width: 32, height: 32 })
    setLivePipeline(pipeline)
    const edges: EdgeData[] = [{ kind: 'line', start: [0, 0, 0], end: [1, 0, 0] }]

    expect(() => renderHook(() => useEdgeIdRegistration({
      featureId: 'f1', bodyId: 'b1', edges, edgeQueries: ['edge@A'],
    }))).toThrow(/does not match/)

    // The failed register must not leave a half-built body claiming picks.
    expect(pipeline.edgeLayer.bodyCount()).toBe(0)
    pipeline.dispose()
  })
})
