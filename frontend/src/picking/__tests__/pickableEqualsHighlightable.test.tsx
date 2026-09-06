import { describe, it, expect, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import * as THREE from 'three'
import type { EdgeData } from '@/types/cad'
import { IdPipeline } from '../IdPipeline'
import { setLivePipeline } from '../IdPipelineContext'
import { useEdgeIdRegistration } from '../useEdgeIdRegistration'
import { useVertexIdRegistration } from '../useVertexIdRegistration'
import {
  resolveEdgeQueries, resolveVertexQueries, resolveFaceQueries,
} from '@/components/Geometry3D/bodyGeometry'
import { topoFallbackQuery } from '@/utils/query/selectionId'
import { rgbToId } from '../idEncoding'
import type { Mesh3D } from '@/types/cad'

/**
 * g4-H1: the ID-layer index space is the SAME padded query list Body3D's
 * HighlightIndex counts from. A body with fewer kernel queries than tessellated
 * primitives used to highlight the tail primitives while leaving them with no
 * ID-buffer pixel, so they could be hovered-onto only by the highlight but never
 * clicked. Body3D has no R3F pointer handlers, so the ID buffer is the only pick
 * route: highlightable-but-unpickable is a real dead spot.
 */
describe('pickable equals highlightable (g4-H1)', () => {
  afterEach(() => setLivePipeline(null))

  it('resolveEdgeQueries pads a short list with body-keyed topo fallbacks', () => {
    expect(resolveEdgeQueries([{}, {}, {}], ['e0'], 'body_x'))
      .toEqual(['e0', topoFallbackQuery('body_x', 'edge', 1), topoFallbackQuery('body_x', 'edge', 2)])
  })

  it('resolveEdgeQueries returns the raw array (identity) when the kernel covered every edge', () => {
    const full = ['e0', 'e1']
    expect(resolveEdgeQueries([{}, {}], full, 'body_x')).toBe(full)
  })

  it('resolveEdgeQueries / resolveVertexQueries return null only when there is nothing to index', () => {
    expect(resolveEdgeQueries([], [], 'body_x')).toBeNull()
    expect(resolveEdgeQueries(undefined, undefined, 'body_x')).toBeNull()
    expect(resolveVertexQueries([], [], 'body_x')).toBeNull()
    expect(resolveVertexQueries(undefined, undefined, 'body_x')).toBeNull()
  })

  it('resolveVertexQueries pads a short list', () => {
    const v: [number, number, number][] = [[0, 0, 0], [1, 0, 0]]
    expect(resolveVertexQueries(v, ['v0'], 'body_x'))
      .toEqual(['v0', topoFallbackQuery('body_x', 'vertex', 1)])
  })

  it('the edge ID layer registers the padded tail edge, so it is pickable where it highlights', () => {
    const pipeline = new IdPipeline({ width: 32, height: 32 })
    setLivePipeline(pipeline)
    const edges: EdgeData[] = [
      { kind: 'line', start: [0, 0, 0], end: [1, 0, 0] },
      { kind: 'line', start: [1, 0, 0], end: [2, 0, 0] },  // kernel gave no query
    ]
    renderHook(() => useEdgeIdRegistration({
      featureId: 'f1', bodyId: 'b1', edges, edgeQueries: ['edge@A'],
    }))

    // Both segments drawn (2 vertices each), and both edges have a registry id.
    const seg = pipeline.edgeLayer.scene.children[0] as THREE.LineSegments
    expect(seg.geometry.getAttribute('position').count).toBe(4)
    expect(pipeline.registry.size()).toBe(2)
    // Per-primitive pick keys, so the fallback query rides as a record entityKey.
    const aColor = seg.geometry.getAttribute('aColor')
    const tailId = rgbToId(
      Math.round(aColor.getX(2) * 255), Math.round(aColor.getY(2) * 255), Math.round(aColor.getZ(2) * 255),
    )
    expect(pipeline.registry.lookup(tailId)!.entityKey).toBe(topoFallbackQuery('b1', 'edge', 1))

    pipeline.dispose()
  })

  it('the vertex ID layer registers the padded tail vertex', () => {
    const pipeline = new IdPipeline({ width: 32, height: 32 })
    setLivePipeline(pipeline)
    const vertices: [number, number, number][] = [[0, 0, 0], [1, 0, 0], [0, 1, 0]]
    renderHook(() => useVertexIdRegistration({
      featureId: 'f1', bodyId: 'b1', vertices, vertexQueries: ['vtx@A'],
    }))

    const obj = pipeline.vertexLayer.scene.children[0] as THREE.Mesh
    // Cube mode: 8 corners per drawn vertex, all three drawn.
    expect(obj.geometry.getAttribute('position').count).toBe(3 * 8)
    expect(pipeline.registry.size()).toBe(3)

    pipeline.dispose()
  })

  it('the face hook and Body3D count from one resolveFaceQueries result', () => {
    // Faces already shared the resolver; this pins that edges/vertices now do
    // too by exercising the same call the hook makes.
    const mesh: Mesh3D = {
      vertices: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
      faces: new Uint32Array([0, 1, 2, 0, 2, 3]),
      triangle_to_face: [0, 1],
      face_queries: ['?f0'],  // one short
    }
    const resolved = resolveFaceQueries(mesh, 'b1')
    expect(resolved).toEqual(['?f0', topoFallbackQuery('b1', 'face', 1)])
  })
})
