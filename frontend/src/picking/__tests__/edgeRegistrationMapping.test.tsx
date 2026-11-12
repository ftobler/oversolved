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

  it('registers nothing when every edge is skipped by the segment builder', () => {
    pipeline = new IdPipeline({ width: 32, height: 32 })
    setLivePipeline(pipeline)

    // Non-finite endpoints mean buildEdgeSegmentGeometry emits no segments; the
    // hook must refuse rather than register an empty body and claim the picks.
    const edges: EdgeData[] = [
      { kind: 'line', start: [NaN, 0, 0], end: [1, 0, 0] },
      { kind: 'line', start: [2, 0, 0], end: [Infinity, 0, 0] },
    ]
    renderHook(() => useEdgeIdRegistration({
      featureId: 'f1',
      bodyId: 'b1',
      edges,
      edgeQueries: ['edge@A', 'edge@B'],
    }))

    expect(pipeline.edgeLayer.bodyCount()).toBe(0)
    expect(pipeline.registry.size()).toBe(0)
  })

  it('registers no segment owned by a hidden edge and keeps the queries byte-identical', () => {
    pipeline = new IdPipeline({ width: 32, height: 32 })
    setLivePipeline(pipeline)

    const edges: EdgeData[] = [
      { kind: 'line', start: [0, 0, 0], end: [1, 0, 0] },
      { kind: 'line', start: [1, 0, 0], end: [2, 0, 0] },  // the body's seam
      { kind: 'line', start: [2, 0, 0], end: [3, 0, 0] },
    ]
    const edgeQueries = ['edge@A', 'edge@SEAM', 'edge@C']
    renderHook(() => useEdgeIdRegistration({
      featureId: 'f1',
      bodyId: 'b1',
      edges,
      edgeQueries,
      hiddenEdges: new Set([1]),
    }))

    const seg = pipeline.edgeLayer.scene.children[0] as THREE.LineSegments
    // Two built segments, so two owned ids: none for the hidden seam.
    expect(seg.geometry.getAttribute('position').count).toBe(4)
    expect(pipeline.registry.size()).toBe(2)
    const keys = [...Array(2)].map((_v, i) => {
      const a = seg.geometry.getAttribute('aColor')
      const id = rgbToId(
        Math.round(a.getX(i * 2) * 255),
        Math.round(a.getY(i * 2) * 255),
        Math.round(a.getZ(i * 2) * 255),
      )
      return pipeline.registry.lookup(id)!.entityKey
    })
    expect(keys).toEqual(['edge@A', 'edge@C'])
    // The hook passes the resolved list through untouched: the seam query stays
    // in the array, it just has no segment drawing it.
    expect(edgeQueries).toEqual(['edge@A', 'edge@SEAM', 'edge@C'])
  })
})
