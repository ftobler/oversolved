import { describe, it, expect } from 'vitest'
import { dropCueEdges, slotAt } from '@/components/layout/featureDropSlot'

// The list rows laid out with a gap between them, like `.feature-item` with its
// 2px block margins. The gap is the dead band the native drop used to leave; the
// slot rule must read the row rects, never the gap.
function rows(count: number, gap = 4, height = 40) {
  return Array.from({ length: count }, (_, i) => ({ top: i * (height + gap), height }))
}

describe('slotAt', () => {
  const fiveRows = rows(5)

  it('maps each row half to the slot above or below it', () => {
    for (let i = 0; i < fiveRows.length; i++) {
      const { top, height } = fiveRows[i]
      expect(slotAt(fiveRows, top + height / 4, 0)).toBe(i)
      expect(slotAt(fiveRows, top + (height * 3) / 4, 0)).toBe(i + 1)
    }
  })

  it('maps a gap between two rows to the next row index', () => {
    for (let i = 0; i < fiveRows.length - 1; i++) {
      const gapY = fiveRows[i].top + fiveRows[i].height + 2
      expect(slotAt(fiveRows, gapY, 0)).toBe(i + 1)
    }
  })

  it('maps the band a rollback bar occupies to the slot between its rows', () => {
    // The bar is drawn in the gap between rows, so the band is the same gap the
    // bar sits in. It must resolve to the slot between the two rows.
    const upper = fiveRows[2]
    const barY = upper.top + upper.height + 2
    expect(slotAt(fiveRows, barY, 0)).toBe(3)
  })

  it('maps below the last row to the end and above the first to minSlot', () => {
    expect(slotAt(fiveRows, 10_000, 0)).toBe(fiveRows.length)
    expect(slotAt(fiveRows, -10, 0)).toBe(0)
  })

  it('clamps a pointer over a built-in row to the first user slot', () => {
    for (let i = 0; i < 4; i++) {
      expect(slotAt(fiveRows, fiveRows[i].top + 10, 4)).toBe(4)
    }
    // The first user row's own upper half is the first user slot too.
    expect(slotAt(fiveRows, fiveRows[4].top + 10, 4)).toBe(4)
    expect(slotAt(fiveRows, fiveRows[4].top + 30, 4)).toBe(5)
  })
})

describe('dropCueEdges', () => {
  it('marks both edges of a plain insertion gap', () => {
    expect(dropCueEdges(2, 6, 0, 4)).toEqual({ top: 2, bottom: 1 })
  })

  it('marks the tail as the last row bottom', () => {
    expect(dropCueEdges(6, 6, 0, 4)).toEqual({ top: null, bottom: 5 })
  })

  it('draws one edge at the rollback slot, on the side the feature lands', () => {
    // Dragged down into the bar slot: the feature lands above the bar.
    expect(dropCueEdges(3, 6, 3, 1)).toEqual({ top: null, bottom: 2 })
    // Dragged up into the bar slot: the feature lands below the bar.
    expect(dropCueEdges(3, 6, 3, 5)).toEqual({ top: 3, bottom: null })
  })

  it('draws no edge for the bar\'s own drag: the moving bar is the cue', () => {
    // A negative draggedIndex means the rollback bar, not a feature row, is
    // being dragged. Its preview slot is shown by the bar itself, so the gap
    // must not also get the old two-line edge highlight.
    for (const slot of [0, 1, 3, 6]) {
      expect(dropCueEdges(slot, 6, 3, -1)).toEqual({ top: null, bottom: null })
    }
  })
})
