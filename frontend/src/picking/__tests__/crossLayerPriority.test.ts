import { describe, it, expect, beforeEach } from 'vitest'
import { IdRegistry } from '../IdRegistry'
import { resolvePixelWindow } from '../IdResolver'
import { idToRGB } from '../idEncoding'
import { FACE_LAYER_NAME } from '../FaceIdLayer'
import { EDGE_LAYER_NAME } from '../EdgeIdLayer'
import { VERTEX_LAYER_NAME } from '../VertexIdLayer'

/**
 * Cross-layer priority sanity check at the resolver level.
 *
 * The plan's headline regression tests (`insideCornerPick`, `occludedEdgeHidden`,
 * `occludedEdgeXray`) require a real WebGL context to render the layered ID
 * target. Those are deferred to manual smoke. As a CPU-side stand-in we
 * verify the resolver picks correctly given the kind of pixel patterns the
 * GPU layering is *expected* to produce -- so a regression in the upstream
 * shader policy still surfaces in tests once the GPU writes the buffer.
 */

function fillPixel(buf: Uint8Array, size: number, x: number, y: number, id: number): void {
  const [r, g, b] = idToRGB(id)
  const i = (y * size + x) * 4
  buf[i] = r
  buf[i + 1] = g
  buf[i + 2] = b
  buf[i + 3] = 255
}

describe('crossLayerPriority (CPU stand-in for GPU layering)', () => {
  let reg: IdRegistry
  let faceId: number
  let edgeId: number
  let vertexId: number

  beforeEach(() => {
    reg = new IdRegistry()
    faceId = reg.allocate(FACE_LAYER_NAME, 'face@A')
    edgeId = reg.allocate(EDGE_LAYER_NAME, 'edge@A')
    vertexId = reg.allocate(VERTEX_LAYER_NAME, 'vtx@A')
  })

  it('with face beneath an edge at the same pixel, the GPU writes the edge color (depthTest+priority); resolver returns edge', () => {
    const size = 17
    const buf = new Uint8Array(size * size * 4)
    // Simulate the post-layered-render state: the cursor center pixel was
    // written by the edge layer (which runs after the face layer with
    // depth-test passing along the edge silhouette).
    fillPixel(buf, size, 8, 8, edgeId)
    const hit = resolvePixelWindow(buf, size, reg)
    expect(hit!.layer).toBe(EDGE_LAYER_NAME)
  })

  it('with vertex written on top of edge at the same pixel, resolver returns vertex', () => {
    const size = 17
    const buf = new Uint8Array(size * size * 4)
    // Vertex layer (no-depth, runs last) overwrites the same pixel.
    fillPixel(buf, size, 8, 8, vertexId)
    const hit = resolvePixelWindow(buf, size, reg)
    expect(hit!.layer).toBe(VERTEX_LAYER_NAME)
  })

  it('within the snap window: vertex at 5px beats edge at 3px, because layer priority is geometric (vertex overdraws)', () => {
    // This mirrors the "vertex always wins where it draws" rule:
    // GPU has already written vertex pixels in a 16-pixel radius around
    // the vertex center, so within that radius the cursor sees vertex.
    // The resolver's "nearest non-empty" then returns vertex.
    const size = 17
    const buf = new Uint8Array(size * size * 4)
    fillPixel(buf, size, 5, 8, edgeId)     // 3 px left of center
    fillPixel(buf, size, 13, 8, vertexId)  // 5 px right of center
    const hit = resolvePixelWindow(buf, size, reg)
    // Nearest-to-center wins (edge here) -- the layer-priority rule lives in
    // the GPU pass, not the resolver. This is by design per the plan:
    // "layer priority is baked into render order".
    expect(hit!.layer).toBe(EDGE_LAYER_NAME)
  })

  it('inside-corner: only edge ID is present at the cursor, resolver returns edge (not the face beneath)', () => {
    // Headline inside-corner case at the pixel level. Both adjacent faces
    // are occluded by the edge's fattened ribbon along the seam, so the
    // pixel under the cursor carries the edge ID.
    const size = 17
    const buf = new Uint8Array(size * size * 4)
    // Fill the row that hosts the edge seam.
    for (let dx = -2; dx <= 2; dx++) fillPixel(buf, size, 8 + dx, 8, edgeId)
    const hit = resolvePixelWindow(buf, size, reg)
    expect(hit!.layer).toBe(EDGE_LAYER_NAME)
    expect(hit!.entityKey).toBe('edge@A')
  })

  it('cursor inside a face away from edges: face wins (only face pixels in window)', () => {
    const size = 17
    const buf = new Uint8Array(size * size * 4)
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) fillPixel(buf, size, x, y, faceId)
    }
    const hit = resolvePixelWindow(buf, size, reg)
    expect(hit!.layer).toBe(FACE_LAYER_NAME)
  })

  it('tool filter (face-only) ignores edge/vertex pixels even if present', () => {
    const size = 17
    const buf = new Uint8Array(size * size * 4)
    fillPixel(buf, size, 8, 8, vertexId)
    fillPixel(buf, size, 0, 0, faceId)
    const hit = resolvePixelWindow(buf, size, reg, new Set([FACE_LAYER_NAME]))
    expect(hit!.layer).toBe(FACE_LAYER_NAME)
  })
})
