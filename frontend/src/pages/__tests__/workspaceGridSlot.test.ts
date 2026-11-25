import { describe, it, expect } from 'vitest'
import { gridSlotAt, type GridTileRect } from '../workspaceGridSlot'

// Three columns of 100x80 tiles with a 20px gutter. Index i is the tile that
// would hold a workspace in reading order; slots are insertion indices between
// those tiles (the dragged tile is not among the rects).
function grid(count = 8): GridTileRect[] {
  return Array.from({ length: count }, (_, i) => ({
    left: (i % 3) * 120,
    top: Math.floor(i / 3) * 100,
    width: 100,
    height: 80,
  }))
}

describe('gridSlotAt', () => {
  it('inserts at the start before the first tile', () => {
    expect(gridSlotAt(grid(), { x: 10, y: 10 })).toBe(0)
  })

  it('inserts between tiles in a row', () => {
    expect(gridSlotAt(grid(), { x: 110, y: 40 })).toBe(1)
    expect(gridSlotAt(grid(), { x: 230, y: 40 })).toBe(2)
  })

  it('inserts at the end of a row', () => {
    expect(gridSlotAt(grid(), { x: 350, y: 40 })).toBe(3)
    expect(gridSlotAt(grid(), { x: 350, y: 140 })).toBe(6)
  })

  it('inserts across a row boundary in the second row', () => {
    expect(gridSlotAt(grid(), { x: 110, y: 140 })).toBe(4)
  })

  it('inserts after the last tile when the pointer is past the grid', () => {
    expect(gridSlotAt(grid(), { x: 240, y: 240 })).toBe(8)
  })

  it('has exactly one slot for an empty grid', () => {
    expect(gridSlotAt([], { x: 40, y: 40 })).toBe(0)
  })
})
