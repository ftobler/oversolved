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
    expect(nextHeldPreview(state, a, null, false)).toBe(state)
  })

  it('freezes the drag preview when a committing drag ends', () => {
    const a = solved('a')
    const p = solved('preview')
    const dragging: HeldPreviewState<S> = { solved: a, preview: p, held: null }
    expect(nextHeldPreview(dragging, a, null, true)).toEqual({ solved: a, preview: null, held: p })
  })

  it('holds nothing when a drag ends without committing a mutation', () => {
    // A locked fully constrained circle (or a radius drag with no solved radius)
    // emits no mutation, so no re-solve is coming to replace a frozen preview.
    // Freezing it would leave the stale gate on forever; the geometry falls back
    // to `solved`, which is correct because nothing moved.
    const a = solved('a')
    const p = solved('preview')
    const dragging: HeldPreviewState<S> = { solved: a, preview: p, held: null }
    expect(nextHeldPreview(dragging, a, null, false)).toEqual({ solved: a, preview: null, held: null })
  })

  it('a no-commit end also drops an older hold the new gesture superseded', () => {
    const a = solved('a')
    const p = solved('p1')
    const q = solved('p2')
    const state: HeldPreviewState<S> = { solved: a, preview: q, held: p }
    expect(nextHeldPreview(state, a, null, false)).toEqual({ solved: a, preview: null, held: null })
  })

  it('drops the hold when a fresh solve arrives', () => {
    const a = solved('a')
    const p = solved('preview')
    const b = solved('b')
    const state: HeldPreviewState<S> = { solved: a, preview: null, held: p }
    expect(nextHeldPreview(state, b, null, true)).toEqual({ solved: b, preview: null, held: null })
  })

  it('keeps holding through an unrelated render', () => {
    const a = solved('a')
    const p = solved('preview')
    const state: HeldPreviewState<S> = { solved: a, preview: null, held: p }
    expect(nextHeldPreview(state, a, null, false)).toBe(state)
  })

  it('keeps holding while a new preview starts, until it ends', () => {
    const a = solved('a')
    const p = solved('p1')
    const q = solved('p2')
    const held: HeldPreviewState<S> = { solved: a, preview: null, held: p }
    const dragging = nextHeldPreview(held, a, q, false)
    expect(dragging).toEqual({ solved: a, preview: q, held: p })
    expect(nextHeldPreview(dragging, a, null, true)).toEqual({ solved: a, preview: null, held: q })
  })

  it('a preview without a prior drag end holds nothing', () => {
    const a = solved('a')
    const q = solved('q')
    const state: HeldPreviewState<S> = { solved: a, preview: null, held: null }
    expect(nextHeldPreview(state, a, q, false)).toEqual({ solved: a, preview: q, held: null })
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

  it('shows the solve right after a drag that committed nothing', () => {
    // The tracker's own no-commit branch leaves no hold, so the display falls
    // straight back to the solved sketch the gesture started from.
    const ended = nextHeldPreview({ solved: a, preview: p, held: null }, a, null, false)
    expect(sketchToDisplay(a, null, ended.held, false)).toBe(a)
  })
})
