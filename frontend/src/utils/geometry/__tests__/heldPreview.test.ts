// The held-preview tracker is pure state: what a sketch renders between
// pointer-up and the fresh solve landing.
import { describe, it, expect } from 'vitest'
import { nextHeldPreview, sketchToDisplay, type HeldPreviewState } from '@/utils/geometry/heldPreview'

interface S { id: string }
const solved = (id: string): S => ({ id })

describe('nextHeldPreview', () => {
  it('returns the same state when neither input identity changed', () => {
    const a = solved('a')
    const state: HeldPreviewState<S> = { solved: a, preview: null, held: null }
    expect(nextHeldPreview(state, a, null)).toBe(state)
  })

  it('freezes the drag preview when the drag ends', () => {
    const a = solved('a')
    const p = solved('preview')
    const dragging: HeldPreviewState<S> = { solved: a, preview: p, held: null }
    expect(nextHeldPreview(dragging, a, null)).toEqual({ solved: a, preview: null, held: p })
  })

  it('drops the hold when a fresh solve arrives', () => {
    const a = solved('a')
    const p = solved('preview')
    const b = solved('b')
    const state: HeldPreviewState<S> = { solved: a, preview: null, held: p }
    expect(nextHeldPreview(state, b, null)).toEqual({ solved: b, preview: null, held: null })
  })

  it('keeps holding through an unrelated render', () => {
    const a = solved('a')
    const p = solved('preview')
    const state: HeldPreviewState<S> = { solved: a, preview: null, held: p }
    expect(nextHeldPreview(state, a, null)).toBe(state)
  })

  it('keeps holding while a new preview starts, until it ends', () => {
    const a = solved('a')
    const p = solved('p1')
    const q = solved('p2')
    const held: HeldPreviewState<S> = { solved: a, preview: null, held: p }
    const dragging = nextHeldPreview(held, a, q)
    expect(dragging).toEqual({ solved: a, preview: q, held: p })
    expect(nextHeldPreview(dragging, a, null)).toEqual({ solved: a, preview: null, held: q })
  })

  it('a preview without a prior drag end holds nothing', () => {
    const a = solved('a')
    const q = solved('q')
    const state: HeldPreviewState<S> = { solved: a, preview: null, held: null }
    expect(nextHeldPreview(state, a, q)).toEqual({ solved: a, preview: q, held: null })
  })
})

describe('sketchToDisplay', () => {
  const a = solved('a')
  const p = solved('p')
  const h = solved('h')

  it('prefers the live preview while dragging', () => {
    expect(sketchToDisplay(a, p, h, true)).toBe(p)
  })

  it('falls back to the hold while the first drag frame is pending', () => {
    expect(sketchToDisplay(a, null, h, true)).toBe(h)
  })

  it('falls back to the solve when a drag has neither preview nor hold', () => {
    expect(sketchToDisplay(a, null, null, true)).toBe(a)
  })

  it('shows the hold after the drag, and the solve once a fresh one lands', () => {
    expect(sketchToDisplay(a, null, h, false)).toBe(h)
    expect(sketchToDisplay(a, null, null, false)).toBe(a)
  })
})
