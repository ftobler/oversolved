import { describe, it, expect } from 'vitest'
import { clampMenuPosition, MENU_MARGIN } from '@/components/dialogs/menuPosition'

// The menu is drawn from the click point, so every edge case is a position
// question: keep the anchor while it fits, flip the axis that does not, and pin
// to the margin when the menu is larger than the room on either side.

const viewport = { width: 1000, height: 800 }
const size = { width: 200, height: 300 }

describe('clampMenuPosition', () => {
  it('keeps the click point when the menu fits', () => {
    expect(clampMenuPosition([100, 120], size, viewport)).toEqual([100, 120])
  })

  it('flips above the click point when there is no room below', () => {
    // 700 + 300 overflows the 800px viewport, and 700 - 300 is inside.
    expect(clampMenuPosition([100, 700], size, viewport)).toEqual([100, 400])
  })

  it('flips left of the click point when there is no room right', () => {
    expect(clampMenuPosition([900, 100], size, viewport)).toEqual([700, 100])
  })

  it('flips both axes when both edges are close', () => {
    expect(clampMenuPosition([900, 700], size, viewport)).toEqual([700, 400])
  })

  it('clamps to the margin when the menu fits on neither side', () => {
    // A menu taller than the viewport cannot be shown whole; the leading edge
    // wins and the overflow falls off the far side.
    const tall = { width: 200, height: 900 }
    expect(clampMenuPosition([100, 500], tall, viewport)).toEqual([100, MENU_MARGIN])
  })

  it('honours a caller-supplied margin', () => {
    expect(clampMenuPosition([0, 0], size, viewport, 0)).toEqual([0, 0])
    expect(clampMenuPosition([990, 790], size, viewport, 0)).toEqual([790, 490])
  })
})
