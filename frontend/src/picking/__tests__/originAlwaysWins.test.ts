import { describe, it, expect, beforeEach } from 'vitest'
import { IdRegistry } from '../IdRegistry'
import { resolvePixelWindow } from '../IdResolver'
import { idToRGB } from '../idEncoding'
import { FACE_LAYER_NAME } from '../FaceIdLayer'
import { ORIGIN_LAYER_NAME, PLANE_LAYER_NAME } from '../IdPipeline'

/**
 * The origin marker layer has priority=60 and depthTest=false. At the GPU
 * level that means a pixel written by the origin layer always sits in the
 * ID buffer regardless of B-rep depth. At the resolver level the buffer
 * just contains the origin's id, so the pick returns the origin even when
 * a face would have hit at the same world point.
 */

function fillPixel(buf: Uint8Array, size: number, x: number, y: number, id: number): void {
  const [r, g, b] = idToRGB(id)
  const i = (y * size + x) * 4
  buf[i] = r
  buf[i + 1] = g
  buf[i + 2] = b
  buf[i + 3] = 255
}

describe('origin layer always wins where it draws (CPU stand-in for GPU layering)', () => {
  let reg: IdRegistry
  let originId: number
  let faceId: number
  let planeId: number
  beforeEach(() => {
    reg = new IdRegistry()
    faceId   = reg.allocate(FACE_LAYER_NAME, 'face@A')
    planeId  = reg.allocate(PLANE_LAYER_NAME, '@builtin_plane_top')
    originId = reg.allocate(ORIGIN_LAYER_NAME, '@builtin_origin')
  })

  it('cursor over the origin pixel returns the origin even when a face is behind it', () => {
    const size = 17
    const buf = new Uint8Array(size * size * 4)
    // GPU end state: face layer wrote at (8,8), then origin layer overwrote
    // it (priority+depthTest=false).
    fillPixel(buf, size, 8, 8, originId)
    const hit = resolvePixelWindow(buf, size, reg)
    expect(hit!.layer).toBe(ORIGIN_LAYER_NAME)
    expect(hit!.entityKey).toBe('@builtin_origin')
  })

  it('cursor over the origin pixel returns the origin even when a plane is behind it', () => {
    const size = 17
    const buf = new Uint8Array(size * size * 4)
    fillPixel(buf, size, 8, 8, originId)
    const hit = resolvePixelWindow(buf, size, reg)
    expect(hit!.layer).toBe(ORIGIN_LAYER_NAME)
    expect(hit!.entityKey).toBe('@builtin_origin')
    // Sanity: planeId allocation is reachable separately.
    expect(reg.lookup(planeId)).toBeDefined()
  })

  it('with tool filter for face-only, origin pixel is ignored', () => {
    const size = 17
    const buf = new Uint8Array(size * size * 4)
    fillPixel(buf, size, 8, 8, originId)
    fillPixel(buf, size, 0, 0, faceId)
    const hit = resolvePixelWindow(buf, size, reg, new Set([FACE_LAYER_NAME]))
    expect(hit!.layer).toBe(FACE_LAYER_NAME)
  })
})
