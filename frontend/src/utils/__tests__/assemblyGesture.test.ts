// The pure drag lifecycle: one machine owns the opening pointer, the phase, the
// click tracker, the source and the moved flag. These tests drive the
// transitions by hand, with no DOM, so the two viewport bugs it fixes (a foreign
// release committing a drag, and one abandonment route leaking the click
// tracker) are pinned at the level where the invariant lives.

import { describe, it, expect } from 'vitest'
import { createAssemblyGestureMachine, type PointerRef } from '@/utils/assemblyGesture'
import { IDLE_GESTURE } from '@/utils/clickGesture'

const primary: PointerRef = { id: 1, button: 0 }
const other: PointerRef = { id: 2, button: 0 }

describe('assembly gesture machine', () => {
  it('records the first pointer and ignores a second while one is down', () => {
    const m = createAssemblyGestureMachine()

    expect(m.pointerDown(primary, 0, 0)).toBe(true)
    expect(m.pointerDown(other, 0, 0)).toBe(false)
    expect(m.phase).toBe('down')

    // The late second pointer's release owns nothing and leaves the first's
    // gesture open.
    expect(m.pointerUp(other, 0, 0)).toEqual({ owned: false, source: null, moved: false })
    expect(m.pointerUp(primary, 0, 0)).toEqual({ owned: true, source: null, moved: false })
    expect(m.phase).toBe('idle')
  })

  it('opens only for the pointer that is already recorded', () => {
    const m = createAssemblyGestureMachine()

    // Capture runs before the wrapper records the opener, so the first open with
    // no opener is accepted.
    expect(m.open('gizmo', primary)).toBe(true)
    // Once an opener exists, only that pointer may open.
    m.pointerDown(primary, 0, 0)
    expect(m.open('body', other)).toBe(false)
    expect(m.source).toBe('gizmo')
  })

  it('a non-primary release is inert and the primary release still ends it', () => {
    const m = createAssemblyGestureMachine()

    m.pointerDown(primary, 0, 0)
    m.open('body', primary)
    m.markMoved()

    // The right button cannot end a left drag.
    expect(m.pointerUp({ id: primary.id, button: 2 }, 0, 0)).toEqual({ owned: false, source: null, moved: false })
    expect(m.phase).toBe('dragging')
    expect(m.isActive()).toBe(true)

    // The opening button still commits the same gesture.
    expect(m.pointerUp(primary, 0, 0)).toEqual({ owned: true, source: 'body', moved: true })
    expect(m.phase).toBe('idle')
    expect(m.isActive()).toBe(false)
  })

  it('markMoved flips down to dragging', () => {
    const m = createAssemblyGestureMachine()

    m.pointerDown(primary, 0, 0)
    expect(m.phase).toBe('down')
    m.markMoved()
    expect(m.phase).toBe('dragging')
    expect(m.moved).toBe(true)
  })

  it('one cancel resets the click tracker, the opener, the source and the moved flag', () => {
    const m = createAssemblyGestureMachine()

    m.pointerDown(primary, 5, 5)
    m.open('gizmo', primary)
    m.markMoved()
    m.cancel()

    expect(m.phase).toBe('idle')
    expect(m.isActive()).toBe(false)
    expect(m.source).toBeNull()
    expect(m.moved).toBe(false)
    expect(m.clickState).toEqual(IDLE_GESTURE)

    // A release after cancel owns nothing: the stale down is gone with the rest.
    expect(m.pointerUp(primary, 5, 5)).toEqual({ owned: false, source: null, moved: false })
  })

  it('pointerCancel cancels only for the opener and reports it', () => {
    const m = createAssemblyGestureMachine()

    m.pointerDown(primary, 0, 0)
    m.open('body', primary)

    expect(m.pointerCancel(other)).toBe(false)
    expect(m.isActive()).toBe(true)

    expect(m.pointerCancel(primary)).toBe(true)
    expect(m.isActive()).toBe(false)
    expect(m.phase).toBe('idle')
  })

  it('canOpen accepts the opener and any pointer before one is recorded', () => {
    const m = createAssemblyGestureMachine()

    // Capture runs before the opener is recorded, so the first call is open.
    expect(m.canOpen(primary)).toBe(true)

    m.pointerDown(primary, 0, 0)
    expect(m.canOpen(primary)).toBe(true)
    expect(m.canOpen(other)).toBe(false)
  })

  it('tracks click travel through the pointerMove transition', () => {
    const m = createAssemblyGestureMachine()

    m.pointerDown(primary, 0, 0)
    m.pointerMove(primary, 1, 1)
    expect(m.clickState.wasDrag).toBe(false)
    m.pointerMove(primary, 40, 40)
    expect(m.clickState.wasDrag).toBe(true)
  })

  it('a second pointer move does not latch the opener click tracker', () => {
    const m = createAssemblyGestureMachine()

    m.pointerDown(primary, 0, 0)
    // The second touch travels far, but the opener never moved: the opener's
    // release must still read as a stationary click.
    m.pointerMove(other, 400, 400)
    expect(m.clickState.wasDrag).toBe(false)

    expect(m.pointerUp(primary, 0, 0)).toEqual({ owned: true, source: null, moved: false })
    expect(m.clickState.wasDrag).toBe(false)
  })
})
