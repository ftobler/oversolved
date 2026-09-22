import { describe, it, expect, beforeEach } from 'vitest'
import { collectEntitiesFromPixels } from '../collectEntitiesFromPixels'
import { IdRegistry } from '../IdRegistry'

function fillBuffer(pixels: [number, number, number, number][], w: number, h: number): Uint8Array {
  const buf = new Uint8Array(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const src = pixels[y * w + x]
      const i = (y * w + x) * 4
      if (src) {
        buf[i] = src[0]; buf[i + 1] = src[1]; buf[i + 2] = src[2]; buf[i + 3] = src[3]
      }
    }
  }
  return buf
}

describe('collectEntitiesFromPixels', () => {
  let registry: IdRegistry

  beforeEach(() => {
    registry = new IdRegistry()
  })

  it('returns empty for an all-zero buffer', () => {
    const buf = new Uint8Array(4 * 4 * 4)
    const result = collectEntitiesFromPixels(buf, 4, 4, registry)
    expect(result).toEqual([])
  })

  it('collects unique entities from a multi-pixel area', () => {
    const idA = registry.allocate('face', '@feat1/face/0')
    const idB = registry.allocate('edge', '@feat1/edge/1')

    // Encode: A takes top-left quad, B takes bottom-right.
    // RGB = idToRGB(id), 8-bit each color component (0-255).
    const vA = [(idA >> 16) & 0xFF, (idA >> 8) & 0xFF, idA & 0xFF]
    const vB = [(idB >> 16) & 0xFF, (idB >> 8) & 0xFF, idB & 0xFF]

    const pixels: [number, number, number, number][] = [
      [vA[0], vA[1], vA[2], 255], [vA[0], vA[1], vA[2], 255], [0, 0, 0, 0], [0, 0, 0, 0],
      [vA[0], vA[1], vA[2], 255], [vA[0], vA[1], vA[2], 255], [0, 0, 0, 0], [0, 0, 0, 0],
      [0, 0, 0, 0], [0, 0, 0, 0], [vB[0], vB[1], vB[2], 255], [0, 0, 0, 0],
      [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0],
    ]
    const buf = fillBuffer(pixels, 4, 4)

    const result = collectEntitiesFromPixels(buf, 4, 4, registry)
    expect(result).toHaveLength(2)
    expect(result).toContainEqual({ layer: 'face', entityKey: '@feat1/face/0' })
    expect(result).toContainEqual({ layer: 'edge', entityKey: '@feat1/edge/1' })
  })

  it('deduplicates the same entity appearing in multiple pixels', () => {
    const id = registry.allocate('face', 'face@1')
    const r = (id >> 16) & 0xFF
    const g = (id >> 8) & 0xFF
    const b = id & 0xFF
    const pixels: [number, number, number, number][] = [
      [r, g, b, 255], [r, g, b, 255],
      [r, g, b, 255], [r, g, b, 255],
    ]
    const buf = fillBuffer(pixels, 2, 2)
    const result = collectEntitiesFromPixels(buf, 2, 2, registry)
    expect(result).toHaveLength(1)
  })

  it('collapses two ids that decode to the same (layer, entityKey) pair', () => {
    // A query collision: same layer + entityKey, distinct pickKey -> distinct id.
    const idA = registry.allocate('face', '@feat/face', 'pickA')
    const idB = registry.allocate('face', '@feat/face', 'pickB')
    expect(idA).not.toBe(idB)

    const rgb = (id: number): [number, number, number] =>
      [(id >> 16) & 0xFF, (id >> 8) & 0xFF, id & 0xFF]
    const [ar, ag, ab] = rgb(idA)
    const [br, bg, bb] = rgb(idB)
    const pixels: [number, number, number, number][] = [
      [ar, ag, ab, 255], [br, bg, bb, 255],
      [ar, ag, ab, 255], [br, bg, bb, 255],
    ]
    const buf = fillBuffer(pixels, 2, 2)

    const result = collectEntitiesFromPixels(buf, 2, 2, registry)
    expect(result).toEqual([{ layer: 'face', entityKey: '@feat/face' }])
  })

  it('skips pixels with alpha=0', () => {
    const id = registry.allocate('face', 'face@1')
    const r = (id >> 16) & 0xFF
    const g = (id >> 8) & 0xFF
    const b = id & 0xFF
    const pixels: [number, number, number, number][] = [
      [r, g, b, 0], [r, g, b, 0],
      [r, g, b, 0], [r, g, b, 0],
    ]
    const buf = fillBuffer(pixels, 2, 2)
    const result = collectEntitiesFromPixels(buf, 2, 2, registry)
    expect(result).toHaveLength(0)
  })

  it('ignores an opaque pixel whose id is not in the registry', () => {
    // A stale ID buffer (a freed id still drawn) must not surface as a bogus
    // selection entry.
    const pixels: [number, number, number, number][] = [
      [0xFF, 0xFF, 0xFF, 255], [0, 0, 0, 0],
      [0, 0, 0, 0], [0, 0, 0, 0],
    ]
    const buf = fillBuffer(pixels, 2, 2)
    expect(collectEntitiesFromPixels(buf, 2, 2, registry)).toEqual([])
  })
})
