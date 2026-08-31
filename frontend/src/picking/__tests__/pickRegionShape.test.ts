import { describe, it, expect, beforeEach } from 'vitest'
import { IdRegistry } from '../IdRegistry'
import { resolvePixelWindow, resolvePixelWindowAll } from '../IdResolver'
import { idToRGB } from '../idEncoding'

/**
 * The shape of the catch region, which nothing pinned before: every other
 * resolver test places pixels and asserts who wins, so both the reach and its
 * direction-dependence were free to drift.
 *
 * The window is read as a square because that is the only shape a pixel blit
 * has. The reach it stands for is a radius, and the two are not the same
 * region: the square's corners sit 11.3 px out where its sides sit 8. Left
 * ungated that difference is visible by hand -- the same point answers from
 * half again as far when approached diagonally.
 */

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

const SIZE = 17
const CENTER = (SIZE - 1) / 2  // 8

describe('pick region shape', () => {
  let reg: IdRegistry
  let faceA: number
  let faceB: number
  beforeEach(() => {
    reg = new IdRegistry()
    faceA = reg.allocate('face', 'face@A')
    faceB = reg.allocate('face', 'face@B')
  })

  it('admits exactly the pixels inside the inscribed disc', () => {
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const buf = makeWindow(SIZE, [{ x, y, id: faceA }])
        const caught = resolvePixelWindow(buf, SIZE, reg) !== null
        const inside = Math.hypot(x - CENTER, y - CENTER) <= CENTER
        expect({ x, y, caught }).toEqual({ x, y, caught: inside })
      }
    }
  })

  it('never reaches further in one direction than another', () => {
    // How far a lone pixel can sit along each of the eight compass directions
    // and still be caught, measured in true pixel distance rather than steps.
    const reach = (sx: number, sy: number): number => {
      let best = 0
      for (let k = 1; k <= CENTER; k++) {
        const x = CENTER + sx * k
        const y = CENTER + sy * k
        if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) break
        const buf = makeWindow(SIZE, [{ x, y, id: faceA }])
        if (resolvePixelWindow(buf, SIZE, reg) === null) break
        best = Math.hypot(sx * k, sy * k)
      }
      return best
    }
    expect(reach(1, 0)).toBe(CENTER)
    expect(reach(-1, 0)).toBe(CENTER)
    expect(reach(0, 1)).toBe(CENTER)
    expect(reach(0, -1)).toBe(CENTER)
    // A diagonal cannot land exactly on the boundary (5 steps is 7.07, 6 is
    // 8.49), so it stops at the last step inside it -- never beyond, which is
    // the anisotropy this guards.
    for (const [sx, sy] of [[1, 1], [-1, 1], [1, -1], [-1, -1]] as const) {
      expect(reach(sx, sy)).toBeCloseTo(Math.hypot(5, 5), 10)
      expect(reach(sx, sy)).toBeLessThanOrEqual(CENTER)
    }
  })

  it('discards a corner pixel entirely rather than ranking it last', () => {
    // The no-op half of the cutoff: an entity present only in a corner is not
    // demoted, it is absent, so it cannot answer a click that found nothing
    // else either.
    const corner = makeWindow(SIZE, [{ x: 0, y: 0, id: faceA }])
    expect(resolvePixelWindow(corner, SIZE, reg)).toBeNull()
    expect(resolvePixelWindowAll(corner, SIZE, reg)).toEqual([])

    // ...while everything inside the disc still collects as before.
    const mixed = makeWindow(SIZE, [
      { x: 0, y: 0, id: faceA },        // corner, 11.31 px out: dropped
      { x: 3, y: 3, id: faceB },        // 7.07 px out: kept
    ])
    expect(resolvePixelWindowAll(mixed, SIZE, reg).map(h => h.entityKey)).toEqual(['face@B'])
  })

  it('an entity keeps its in-disc pixels when only some of them are out', () => {
    const buf = makeWindow(SIZE, [
      { x: 0, y: 0, id: faceA },   // out of range
      { x: 8, y: 11, id: faceA },  // 3 px out, in range
    ])
    const hits = resolvePixelWindowAll(buf, SIZE, reg)
    expect(hits).toHaveLength(1)
    expect(hits[0].distancePx).toBe(3)
  })
})
