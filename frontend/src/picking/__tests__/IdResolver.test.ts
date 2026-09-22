import { describe, it, expect, beforeEach } from 'vitest'
import { IdRegistry } from '../IdRegistry'
import { resolvePixelWindow, resolvePixelWindowAll } from '../IdResolver'
import { idToRGB } from '../idEncoding'

function makeWindow(size: number, fills: Array<{ x: number; y: number; id: number }>): Uint8Array {
  const buf = new Uint8Array(size * size * 4)
  for (const { x, y, id } of fills) {
    const [r, g, b] = idToRGB(id)
    const i = (y * size + x) * 4
    buf[i] = r
    buf[i + 1] = g
    buf[i + 2] = b
    buf[i + 3] = 255  // occupied
  }
  return buf
}

describe('resolvePixelWindow', () => {
  let reg: IdRegistry
  let faceA: number
  let faceB: number
  beforeEach(() => {
    reg = new IdRegistry()
    faceA = reg.allocate('face', 'face@A')
    faceB = reg.allocate('face', 'face@B')
  })

  it('returns null when the window is empty', () => {
    const buf = new Uint8Array(17 * 17 * 4)
    const hit = resolvePixelWindow(buf, 17, reg)
    expect(hit).toBeNull()
  })

  it('returns the only filled pixel', () => {
    const buf = makeWindow(17, [{ x: 8, y: 8, id: faceA }])  // center
    const hit = resolvePixelWindow(buf, 17, reg)
    expect(hit).not.toBeNull()
    expect(hit!.id).toBe(faceA)
    expect(hit!.entityKey).toBe('face@A')
    expect(hit!.distancePx).toBe(0)
  })

  it('returns the pixel nearest to center when multiple are filled', () => {
    const buf = makeWindow(17, [
      { x: 3, y: 3, id: faceA },    // far, but inside the reach
      { x: 10, y: 9, id: faceB },   // closer to center (8,8)
    ])
    const hit = resolvePixelWindow(buf, 17, reg)
    expect(hit!.id).toBe(faceB)
  })

  it('ignores pixels whose id is not in the registry', () => {
    const buf = makeWindow(17, [
      { x: 8, y: 8, id: 9999999 },  // unregistered, near center
      { x: 3, y: 3, id: faceA },    // registered, further out
    ])
    const hit = resolvePixelWindow(buf, 17, reg)
    expect(hit!.id).toBe(faceA)
  })

  it('ignores pixels with alpha=0 even if RGB encodes a valid id', () => {
    const buf = new Uint8Array(17 * 17 * 4)
    const [r, g, b] = idToRGB(faceA)
    const i = (8 * 17 + 8) * 4
    buf[i] = r; buf[i + 1] = g; buf[i + 2] = b
    buf[i + 3] = 0  // explicitly empty
    const hit = resolvePixelWindow(buf, 17, reg)
    expect(hit).toBeNull()
  })

  it('respects allowedLayers filter', () => {
    const edgeId = reg.allocate('edge', 'edge@A')
    const buf = makeWindow(17, [
      { x: 8, y: 8, id: edgeId },   // closer
      { x: 3, y: 3, id: faceA },    // farther
    ])
    const filtered = resolvePixelWindow(buf, 17, reg, new Set(['face']))
    expect(filtered!.id).toBe(faceA)
  })

  it('throws when the buffer is too small for the requested window', () => {
    const buf = new Uint8Array(4 * 4 * 4)
    expect(() => resolvePixelWindow(buf, 17, reg)).toThrow()
  })

  it('returns null for a non-positive window size instead of reading the buffer', () => {
    expect(resolvePixelWindow(new Uint8Array(0), 0, reg)).toBeNull()
    expect(resolvePixelWindow(new Uint8Array(0), -3, reg)).toBeNull()
  })

  // Two co-located marks can each win a pixel; the cluster they share must be
  // emitted once, not once per winning member.
  it('emits a co-located cluster once when two of its members are lit', () => {
    const a = reg.allocate('face', 'face@a')
    const b = reg.allocate('edge', 'edge@b')
    reg.setMarkPosition(a, 0, 0, 0)
    reg.setMarkPosition(b, 0, 0, 0)
    const buf = makeWindow(17, [{ x: 8, y: 8, id: a }, { x: 9, y: 8, id: b }])

    const hits = resolvePixelWindowAll(buf, 17, reg)

    expect(hits.map(h => h.id).sort((p, q) => p - q)).toEqual([a, b].sort((p, q) => p - q))
  })
})
