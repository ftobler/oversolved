// Stage 7: the pixel window decodes to EVERY entity it covers, not just the
// winner. The singleton resolver is redefined as this list's first element, so
// these tests also guard that the legacy one-hit contract did not move.

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
    buf[i + 3] = 255
  }
  return buf
}

const PRIORITY = { face: 10, edge: 20, vertex: 30 }

describe('resolvePixelWindowAll', () => {
  let reg: IdRegistry
  let faceA: number, faceB: number, faceC: number
  let edgeA: number, edgeB: number
  let vertA: number

  beforeEach(() => {
    reg = new IdRegistry()
    faceA = reg.allocate('face', 'face@A')
    faceB = reg.allocate('face', 'face@B')
    faceC = reg.allocate('face', 'face@C')
    edgeA = reg.allocate('edge', 'edge@A')
    edgeB = reg.allocate('edge', 'edge@B')
    vertA = reg.allocate('vertex', 'vert@A')
  })

  it('returns an empty list for an empty window', () => {
    expect(resolvePixelWindowAll(new Uint8Array(17 * 17 * 4), 17, reg)).toEqual([])
  })

  it('a box corner resolves to every entity meeting there, priority then distance', () => {
    // The classic corner: 3 faces, 2 edges and the vertex all within one window.
    const buf = makeWindow(17, [
      { x: 8, y: 8, id: vertA },   // dead center
      { x: 9, y: 8, id: edgeA },   // 1 px out
      { x: 8, y: 5, id: edgeB },   // 3 px out
      { x: 6, y: 8, id: faceA },   // 2 px out
      { x: 8, y: 12, id: faceB },  // 4 px out
      { x: 0, y: 0, id: faceC },   // far corner
    ])
    const hits = resolvePixelWindowAll(buf, 17, reg, undefined, PRIORITY)
    expect(hits.map(h => h.entityKey)).toEqual([
      'vert@A',                    // vertex layer wins on priority
      'edge@A', 'edge@B',          // then edges, nearest first
      'face@A', 'face@B', 'face@C',  // then faces, nearest first
    ])
  })

  it('reports each entity once, at its nearest covered pixel', () => {
    const buf = makeWindow(17, [
      { x: 8, y: 12, id: faceA },  // 4 px
      { x: 8, y: 10, id: faceA },  // 2 px, same entity, nearer
    ])
    const hits = resolvePixelWindowAll(buf, 17, reg, undefined, PRIORITY)
    expect(hits).toHaveLength(1)
    expect(hits[0].distancePx).toBe(2)
  })

  it('honours the allowed-layer filter', () => {
    const buf = makeWindow(17, [
      { x: 8, y: 8, id: vertA },
      { x: 9, y: 8, id: faceA },
    ])
    const hits = resolvePixelWindowAll(buf, 17, reg, new Set(['face']), PRIORITY)
    expect(hits.map(h => h.entityKey)).toEqual(['face@A'])
  })

  it('skips ids the registry no longer knows', () => {
    const buf = makeWindow(17, [
      { x: 8, y: 8, id: 9999999 },
      { x: 9, y: 8, id: faceA },
    ])
    const hits = resolvePixelWindowAll(buf, 17, reg, undefined, PRIORITY)
    expect(hits.map(h => h.entityKey)).toEqual(['face@A'])
  })

  it('the singleton resolver is exactly the first candidate', () => {
    const buf = makeWindow(17, [
      { x: 8, y: 8, id: faceA },   // nearest, but lowest-priority layer
      { x: 12, y: 8, id: edgeA },
      { x: 14, y: 8, id: vertA },
    ])
    const all = resolvePixelWindowAll(buf, 17, reg, undefined, PRIORITY)
    const one = resolvePixelWindow(buf, 17, reg, undefined, PRIORITY)
    expect(one).toEqual(all[0])
    expect(one!.entityKey).toBe('vert@A')
  })

  it('breaks a distance tie toward whoever reached it first, not whoever appeared first', () => {
    // faceA shows up early but far, and only ties faceB at the very end. The
    // single-hit resolver has always answered faceB here; `[0]` must agree.
    const buf = makeWindow(17, [
      { x: 0, y: 0, id: faceA },   // scanned first, 11.3 px out
      { x: 8, y: 6, id: faceB },   // 2 px out
      { x: 8, y: 10, id: faceA },  // 2 px out, but scanned later
    ])
    const all = resolvePixelWindowAll(buf, 17, reg, undefined, PRIORITY)
    expect(all[0].entityKey).toBe('face@B')
    expect(resolvePixelWindow(buf, 17, reg, undefined, PRIORITY)).toEqual(all[0])
  })

  it('non-corner hits still yield exactly one candidate', () => {
    const buf = makeWindow(17, [{ x: 8, y: 8, id: faceA }])
    expect(resolvePixelWindowAll(buf, 17, reg, undefined, PRIORITY)).toHaveLength(1)
  })
})
