import { describe, it, expect } from 'vitest'
import { marksCoincide, axisCell, MARK_ABS_TOL, MARK_REL_TOL } from '../markPosition'
import { IdRegistry } from '../IdRegistry'

/**
 * The position index: what it buckets together, and when it lets go.
 *
 * Its whole job is to survive the one thing a one-pixel mark cannot -- being
 * overwritten -- so the lifecycle matters as much as the key. A stale entry
 * would co-locate a recycled id with whatever used to be at that spot, which
 * is a wrong pick rather than a missing one, and worse.
 */

describe('marksCoincide', () => {
  it('joins two derivations of one point that disagree by a float32 step', () => {
    // The pair this index exists for, taken from a solved tangency: the line
    // endpoint as the solver stored it, and the dock foot re-derived from the
    // same params. They are one point, they write one pixel, and they differ
    // in the last bit float32 has -- which is what an exact key splits on.
    expect(marksCoincide(
      7.9340643882751465, 5.224999904632568, 0,
      7.9340643882751465, 5.225000381469727, 0)).toBe(true)
  })

  it('holds the window open near zero, where relative alone closes it', () => {
    // A point constrained to the document origin solves to 1e-11, not to 0,
    // and the origin marker is a literal 0. Without an absolute floor the
    // relative window at that magnitude is 1e-17 and the two never meet.
    expect(marksCoincide(0, 0, 0, -4.35e-12, -4.04e-11, 0)).toBe(true)
  })

  it('keeps apart what a user could see apart', () => {
    // The window is a fraction of a pixel at any zoom that shows the
    // coordinate, so it can only ever join marks that already share one.
    expect(marksCoincide(10, 0, 0, 10 + 1e-3, 0, 0)).toBe(false)
    expect(marksCoincide(10, 0, 0, 10 + 1e-4, 0, 0)).toBe(false)
    expect(marksCoincide(10, 0, 0, 10 + 1e-9, 0, 0)).toBe(true)
  })

  it('scales the window with the magnitude, as float32 itself does', () => {
    // A fixed absolute window would be coarser than the storage step at small
    // coordinates and finer than it at large ones -- at x = 50 a one-step
    // disagreement is 3.8e-6, and anything absolute enough to be safe at the
    // origin would refuse it.
    for (const x of [0.5, 5, 50, 5000]) {
      expect(marksCoincide(x, 0, 0, x + x * MARK_REL_TOL * 0.5, 0, 0)).toBe(true)
      expect(marksCoincide(x, 0, 0, x + x * MARK_REL_TOL * 4, 0, 0)).toBe(false)
    }
  })

  it('is symmetric, so the answer does not depend on who is asked', () => {
    const a: [number, number, number] = [5.224999904632568, 0, 0]
    const b: [number, number, number] = [5.225000381469727, 0, 0]
    expect(marksCoincide(...a, ...b)).toBe(marksCoincide(...b, ...a))
  })

  it('separates the axes rather than summing them', () => {
    expect(marksCoincide(1, 2, 3, 3, 2, 1)).toBe(false)
    expect(marksCoincide(0, 0, 0, 0, 0, 1)).toBe(false)
  })

  it('treats the two zeroes as one place', () => {
    expect(marksCoincide(-0, -0, -0, 0, 0, 0)).toBe(true)
  })
})

describe('NaN feed (g4-H2: the layers must filter before this point)', () => {
  // These document WHY VertexIdLayer / useSketchIdRegistration reject non-finite
  // positions: fed a NaN, the index silently co-locates it with the origin.
  it('axisCell buckets NaN into the origin cell', () => {
    expect(axisCell(NaN)).toBe(0)
  })

  it('marksCoincide reads any NaN pair as coincident', () => {
    expect(marksCoincide(NaN, 0, 0, 0, 0, 0)).toBe(true)
    expect(marksCoincide(NaN, NaN, NaN, 5, 5, 5)).toBe(true)
  })

  it('a NaN mark, once published, answers every query near the origin', () => {
    const reg = new IdRegistry()
    const origin = reg.allocate('originMarker', 'origin')
    const bad = reg.allocate('sketchVertex', 'nan-vertex')
    reg.setMarkPosition(origin, 0, 0, 0)
    reg.setMarkPosition(bad, NaN, 0, 0)
    // This is the bug the layer filter prevents: the NaN mark is offered
    // alongside the origin.
    expect(reg.coincidentMarkIds(origin)).toContain(bad)
  })
})

describe('axisCell', () => {
  it('is monotone, so cell order is coordinate order', () => {
    const xs = [-1e6, -50, -1, -MARK_ABS_TOL * 2, 0, MARK_ABS_TOL * 2, 1, 50, 1e6]
    const cells = xs.map(axisCell)
    for (let i = 1; i < cells.length; i++) expect(cells[i]).toBeGreaterThan(cells[i - 1])
  })

  it('collapses the whole floor band into one cell', () => {
    expect(axisCell(0)).toBe(0)
    expect(axisCell(-0)).toBe(0)
    expect(axisCell(1e-11)).toBe(0)
    expect(axisCell(-1e-11)).toBe(0)
  })

  it('numbers the cells either side of the floor next to it, not away from it', () => {
    // The floor is a much wider cell than its neighbours, so contiguity is not
    // automatic -- and without it a neighbour probe falls off the band instead
    // of crossing it, which is the near-origin half of the bug.
    expect(axisCell(MARK_ABS_TOL * 1.0000001)).toBe(1)
    expect(axisCell(-MARK_ABS_TOL * 1.0000001)).toBe(-1)
  })

  it('puts coincident coordinates no further than one cell apart', () => {
    // The invariant the 27-cell probe rests on: a cell is wider than the
    // window, so nothing inside the window can be two cells away.
    for (const x of [1e-6, 0.5, 5.225, 50, 5000]) {
      for (const d of [MARK_REL_TOL, -MARK_REL_TOL, MARK_REL_TOL / 3]) {
        const y = x + x * d
        if (!marksCoincide(x, 0, 0, y, 0, 0)) continue
        expect(Math.abs(axisCell(x) - axisCell(y))).toBeLessThanOrEqual(1)
      }
    }
  })
})

describe('IdRegistry mark positions', () => {
  it('reports nothing for an id that marks no point', () => {
    const reg = new IdRegistry()
    const id = reg.allocate('face', 'face@A')
    expect(reg.coincidentMarkIds(id)).toEqual([])
  })

  it('reports a lone mark as itself alone', () => {
    const reg = new IdRegistry()
    const id = reg.allocate('sketchVertex', 'v1')
    reg.setMarkPosition(id, 1, 1, 0)
    expect(reg.coincidentMarkIds(id)).toEqual([id])
  })

  it('groups co-located marks in registration order, from either end', () => {
    const reg = new IdRegistry()
    const a = reg.allocate('sketchVertex', 'a')
    const b = reg.allocate('sketchVertex', 'b')
    const c = reg.allocate('originMarker', 'c')
    for (const id of [a, b, c]) reg.setMarkPosition(id, 2, 3, 0)
    expect(reg.coincidentMarkIds(a)).toEqual([a, b, c])
    expect(reg.coincidentMarkIds(c)).toEqual([a, b, c])
  })

  it('groups marks that only nearly agree, from either end', () => {
    // The real pair, through the registry: a solved endpoint and the dock foot
    // re-derived from it. Whichever one the caller holds, the other is in the
    // answer -- which is the property the pixel cannot supply, since only one
    // of the two survives being drawn.
    const reg = new IdRegistry()
    const vertex = reg.allocate('sketchVertex', 'vertex:S1:L1:end')
    const dock = reg.allocate('sketchVertex', 'dock:S1:c_tangent')
    reg.setMarkPosition(vertex, 7.9340643882751465, 5.224999904632568, 0)
    reg.setMarkPosition(dock, 7.934064194956269, 5.225000198183635, 0)
    expect(reg.coincidentMarkIds(vertex)).toEqual([vertex, dock])
    expect(reg.coincidentMarkIds(dock)).toEqual([vertex, dock])
  })

  it('answers a chain with the whole chain, whichever link is asked', () => {
    // A tolerance is not transitive: a-b and b-c can both be inside the window
    // with a-c outside it. A single-hop query would then answer differently
    // depending on which mark won the pixel, and which mark wins the pixel is
    // exactly what this index refuses to let matter.
    const reg = new IdRegistry()
    const step = 5 * MARK_REL_TOL * 0.6
    const ids = [0, 1, 2].map(i => reg.allocate('sketchVertex', `v${i}`))
    ids.forEach((id, i) => reg.setMarkPosition(id, 5 + i * step, 0, 0))
    expect(marksCoincide(5, 0, 0, 5 + 2 * step, 0, 0)).toBe(false)  // the ends are not a pair
    for (const id of ids) expect(reg.coincidentMarkIds(id)).toEqual(ids)
  })

  it('moves a mark rather than listing it in two places', () => {
    const reg = new IdRegistry()
    const a = reg.allocate('sketchVertex', 'a')
    const b = reg.allocate('sketchVertex', 'b')
    reg.setMarkPosition(a, 0, 0, 0)
    reg.setMarkPosition(b, 0, 0, 0)
    reg.setMarkPosition(a, 9, 9, 0)
    expect(reg.coincidentMarkIds(a)).toEqual([a])
    expect(reg.coincidentMarkIds(b)).toEqual([b])
  })

  it('keeps a mark where it was when the position is unchanged', () => {
    // Re-registration is the common case (any solve re-registers the body), and
    // re-publishing an unchanged position must not renumber it behind the marks
    // that were registered after it.
    const reg = new IdRegistry()
    const a = reg.allocate('sketchVertex', 'a')
    const b = reg.allocate('sketchVertex', 'b')
    reg.setMarkPosition(a, 4, 4, 0)
    reg.setMarkPosition(b, 4, 4, 0)
    reg.setMarkPosition(a, 4, 4, 0)
    expect(reg.coincidentMarkIds(b)).toEqual([a, b])
  })

  it('drops a freed mark immediately, before the id can be recycled', () => {
    // Not at bumpCycle like the byId record: a freed id is about to be handed
    // to a re-registered primitive somewhere else, and a stale entry would
    // co-locate it with whatever used to be here.
    const reg = new IdRegistry()
    const a = reg.allocate('sketchVertex', 'a')
    const b = reg.allocate('sketchVertex', 'b')
    reg.setMarkPosition(a, 4, 4, 0)
    reg.setMarkPosition(b, 4, 4, 0)
    reg.free(a)
    expect(reg.coincidentMarkIds(b)).toEqual([b])
    expect(reg.coincidentMarkIds(a)).toEqual([])
    reg.bumpCycle()
    const recycled = reg.allocate('sketchVertex', 'elsewhere')
    expect(reg.coincidentMarkIds(recycled)).toEqual([])
  })

  it('forgets every position on clear', () => {
    const reg = new IdRegistry()
    const a = reg.allocate('sketchVertex', 'a')
    reg.setMarkPosition(a, 1, 0, 0)
    reg.clear()
    expect(reg.coincidentMarkIds(a)).toEqual([])
  })
})
