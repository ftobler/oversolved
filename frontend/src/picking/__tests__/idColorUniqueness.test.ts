import { describe, it, expect } from 'vitest'
import { IdRegistry } from '../IdRegistry'
import { FaceIdLayer } from '../FaceIdLayer'
import { EdgeIdLayer } from '../EdgeIdLayer'
import { VertexIdLayer } from '../VertexIdLayer'
import { rgbToId } from '../idEncoding'

/**
 * The load-bearing invariant of the ID buffer: every pickable primitive that is
 * rendered must own a UNIQUE id-color. If two primitives share a color, a pixel
 * read at pick time resolves to an ambiguous primitive and selection collapses
 * onto a group (the symptom that motivated the query/pick-key decoupling).
 *
 * This walks each rendered primitive of every layer, decodes the id-color it was
 * actually given, and asserts no color is reused -- even in the worst case where
 * every primitive of a kind shares one ancestral query (no minted UUID / shared
 * octant). The production hooks register faces and edges with per-primitive pick
 * keys for exactly this reason; vertices must do the same.
 */

// Decode one id per primitive from a layer geometry's color attribute.
// `attr` is the attribute name, `stride` the vertex count per primitive.
function primitiveColorIds(
  geometry: import('three').BufferGeometry,
  attr: string,
  stride: number,
): number[] {
  const color = geometry.getAttribute(attr)
  const ids: number[] = []
  for (let v = 0; v < color.count; v += stride) {
    const r = Math.round(color.getX(v) * 255)
    const g = Math.round(color.getY(v) * 255)
    const b = Math.round(color.getZ(v) * 255)
    ids.push(rgbToId(r, g, b))
  }
  return ids
}

describe('id-color uniqueness across all pickable primitives', () => {
  it('every face, edge and vertex owns a distinct id-color even when their queries collide', () => {
    const reg = new IdRegistry()
    const faceLayer = new FaceIdLayer(reg)
    const edgeLayer = new EdgeIdLayer(reg)
    const vertexLayer = new VertexIdLayer(reg)
    const bodyKey = 'feat1/body1'

    // Worst case: 3 of each kind, every one carrying the SAME query as its siblings.
    faceLayer.registerBody({
      bodyKey,
      positions: new Float32Array([
        0, 0, 0, 1, 0, 0, 0, 1, 0,
        2, 0, 0, 3, 0, 0, 2, 1, 0,
        4, 0, 0, 5, 0, 0, 4, 1, 0,
      ]),
      triangleToFace: new Uint32Array([0, 1, 2]),
      faceQueries: ['face@dup', 'face@dup', 'face@dup'],
      perPrimitivePickKeys: true,
    })
    edgeLayer.registerBody({
      bodyKey,
      segmentPositions: new Float32Array([
        0, 0, 0, 1, 0, 0,
        0, 1, 0, 1, 1, 0,
        0, 2, 0, 1, 2, 0,
      ]),
      segmentToEdge: new Uint32Array([0, 1, 2]),
      edgeQueries: ['edge@dup', 'edge@dup', 'edge@dup'],
      perPrimitivePickKeys: true,
    })
    vertexLayer.registerBody({
      bodyKey,
      vertices: [[0, 0, 0], [1, 0, 0], [2, 0, 0]],
      vertexQueries: ['vtx@dup', 'vtx@dup', 'vtx@dup'],
      perPrimitivePickKeys: true,
    })

    const faceGeo = (faceLayer.scene.children[0] as import('three').Mesh).geometry
    const edgeGeo = (edgeLayer.scene.children[0] as import('three').LineSegments).geometry
    const vertexGeo = (vertexLayer.scene.children[0] as import('three').Points).geometry

    const allIds = [
      ...primitiveColorIds(faceGeo, 'color', 3),
      ...primitiveColorIds(edgeGeo, 'aColor', 2),
      ...primitiveColorIds(vertexGeo, 'aColor', 1),
    ]

    // 9 rendered primitives -> 9 distinct id-colors, none reused.
    expect(allIds.length).toBe(9)
    expect(new Set(allIds).size).toBe(9)
  })
})
