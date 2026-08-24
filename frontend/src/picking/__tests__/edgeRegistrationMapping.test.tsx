import { describe, it, expect, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import * as THREE from 'three'
import { IdPipeline } from '../IdPipeline'
import { setLivePipeline } from '../IdPipelineContext'
import { useEdgeIdRegistration } from '../useEdgeIdRegistration'
import { rgbToId } from '../idEncoding'
import type { EdgeData } from '@/types/cad'

/**
 * End-to-end lock for the single-traversal edge registration: an edge skipped
 * by the segment builder (non-finite endpoint) must not shift every later
 * segment onto the previous edge's query. The former counts-based map did
 * exactly that, so picks resolved silently wrong.
 */
describe('useEdgeIdRegistration segment -> edge mapping', () => {
  let pipeline: IdPipeline
  afterEach(() => {
    setLivePipeline(null)
    pipeline?.dispose()
  })

  it('resolves the only built segment of [NaN line, valid line] to edge 1', () => {
    pipeline = new IdPipeline({ width: 32, height: 32 })
    setLivePipeline(pipeline)

    const edges: EdgeData[] = [
      { kind: 'line', start: [0, 0, 0], end: [NaN, 0, 0] },  // builder skips this one
      { kind: 'line', start: [1, 0, 0], end: [2, 0, 0] },
    ]
    renderHook(() => useEdgeIdRegistration({
      featureId: 'f1',
      bodyId: 'b1',
      edges,
      edgeQueries: ['edge@A', 'edge@B'],
    }))

    const seg = pipeline.edgeLayer.scene.children[0] as THREE.LineSegments
    // One built segment = 2 vertices.
    expect(seg.geometry.getAttribute('position').count).toBe(2)
    const colorAttr = seg.geometry.getAttribute('aColor')
    const id = rgbToId(
      Math.round(colorAttr.getX(0) * 255),
      Math.round(colorAttr.getY(0) * 255),
      Math.round(colorAttr.getZ(0) * 255),
    )
    // The segment carries edge index 1's query, and nothing was allocated for
    // the skipped edge 0 (per-primitive keys, so registry size is the honest count).
    expect(pipeline.registry.lookup(id)!.entityKey).toBe('edge@B')
    expect(pipeline.registry.size()).toBe(1)
  })
})
