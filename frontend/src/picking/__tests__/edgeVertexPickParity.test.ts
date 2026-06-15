import { describe, it, expect } from 'vitest'
import { IdRegistry } from '../IdRegistry'
import { EdgeIdLayer, EDGE_LAYER_NAME } from '../EdgeIdLayer'
import { VertexIdLayer, VERTEX_LAYER_NAME } from '../VertexIdLayer'
import { rgbToId } from '../idEncoding'

/**
 * Structural parity for edges and vertices: every segment / instance
 * decodes (via the registry) to the same `entityKey` that the legacy
 * raycaster path (Body3D.getIsEdgeSelected / vertexQueries[i]) would
 * resolve.
 *
 * The full GPU-rendered parity (cursor grid over a fixture cube) belongs
 * to GPU-backed test infra and is documented as deferred manual smoke
 * in id-buffer-edges-vertices.md.
 */

describe('edgeVertexPickParity (structural)', () => {
  it('every edge segment color decodes to its edgeQuery', () => {
    const edgeQueries = ['edge@e1', 'edge@e2', 'edge@e3']
    const segmentToEdge = new Uint32Array([0, 0, 1, 2, 2, 2])
    // Distinct positions; values don't matter for the structural check.
    const segmentPositions = new Float32Array(6 * 6)
    for (let i = 0; i < segmentPositions.length; i++) segmentPositions[i] = i * 0.01

    const reg = new IdRegistry()
    const layer = new EdgeIdLayer(reg)
    layer.registerBody({ bodyKey: 'cube', segmentPositions, segmentToEdge, edgeQueries })

    const segs = layer.scene.children[0] as import('three').LineSegments
    const aColor = segs.geometry.getAttribute('aColor')

    for (let seg = 0; seg < segmentToEdge.length; seg++) {
      const expectedKey = edgeQueries[segmentToEdge[seg]]
      const v0 = seg * 2
      const r = Math.round(aColor.getX(v0) * 255)
      const g = Math.round(aColor.getY(v0) * 255)
      const b = Math.round(aColor.getZ(v0) * 255)
      const rec = reg.lookup(rgbToId(r, g, b))
      expect(rec).toBeDefined()
      expect(rec!.layer).toBe(EDGE_LAYER_NAME)
      expect(rec!.entityKey).toBe(expectedKey)
    }
    layer.dispose()
  })

  it('every vertex instance color decodes to its vertexQuery', () => {
    const vertices: [number, number, number][] = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]]
    const vertexQueries = ['vtx@v1', 'vtx@v2', 'vtx@v3', 'vtx@v4']

    const reg = new IdRegistry()
    const layer = new VertexIdLayer(reg)
    layer.registerBody({ bodyKey: 'cube', vertices, vertexQueries })

    const im = layer.scene.children[0] as import('three').Points
    const aColor = im.geometry.getAttribute('aColor')

    for (let i = 0; i < vertices.length; i++) {
      const r = Math.round(aColor.getX(i) * 255)
      const g = Math.round(aColor.getY(i) * 255)
      const b = Math.round(aColor.getZ(i) * 255)
      const rec = reg.lookup(rgbToId(r, g, b))
      expect(rec).toBeDefined()
      expect(rec!.layer).toBe(VERTEX_LAYER_NAME)
      expect(rec!.entityKey).toBe(vertexQueries[i])
    }
    layer.dispose()
  })
})
