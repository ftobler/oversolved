import { describe, it, expect } from 'vitest'
import {
  IDLE_GESTURE,
  createClickGestureTracker,
  gestureDown,
  gestureMove,
  gestureUp,
  isStationaryPrimaryClick,
} from '@/utils/clickGesture'
import { CLICK_THRESHOLD_PX } from '@/components/Geometry3D/constants'

const OVER = CLICK_THRESHOLD_PX + 1
const UNDER = CLICK_THRESHOLD_PX - 1

describe('clickGesture reducers', () => {
  it('an untouched gesture is not a click', () => {
    expect(isStationaryPrimaryClick(IDLE_GESTURE)).toBe(false)
  })

  it('records the button and origin on pointer-down', () => {
    const s = gestureDown(2, 10, 20)
    expect(s.button).toBe(2)
    expect(s.origin).toEqual([10, 20])
    expect(s.wasDrag).toBe(false)
  })

  it('calls a stationary left press-release a click', () => {
    const s = gestureUp(gestureDown(0, 100, 100), 100 + UNDER, 100)
    expect(s.wasDrag).toBe(false)
    expect(isStationaryPrimaryClick(s)).toBe(true)
  })

  it('calls a left press-release past the threshold a drag', () => {
    const s = gestureUp(gestureDown(0, 100, 100), 100 + OVER, 100)
    expect(s.wasDrag).toBe(true)
    expect(isStationaryPrimaryClick(s)).toBe(false)
  })

  it('treats exactly the threshold as a drag, matching CLICK_THRESHOLD_PX semantics', () => {
    const s = gestureUp(gestureDown(0, 0, 0), CLICK_THRESHOLD_PX, 0)
    expect(s.wasDrag).toBe(true)
  })

  it('latches a drag that swings out and returns to its origin', () => {
    let s = gestureDown(0, 100, 100)
    s = gestureMove(s, 400, 400)
    s = gestureUp(s, 100, 100)
    expect(s.wasDrag).toBe(true)
    expect(isStationaryPrimaryClick(s)).toBe(false)
  })

  it('does not latch a drag from jitter below the threshold', () => {
    let s = gestureDown(0, 100, 100)
    s = gestureMove(s, 100 + UNDER, 100)
    s = gestureUp(s, 100, 100)
    expect(s.wasDrag).toBe(false)
  })

  it('rejects a non-left button even when it never moved', () => {
    // The camera runs on the right button, so this is the orbit-start case.
    expect(isStationaryPrimaryClick(gestureDown(2, 50, 50))).toBe(false)
    expect(isStationaryPrimaryClick(gestureUp(gestureDown(2, 50, 50), 50, 50))).toBe(false)
    expect(isStationaryPrimaryClick(gestureDown(1, 50, 50))).toBe(false)
  })

  it('keeps the verdict readable after pointer-up, when the click event arrives', () => {
    const s = gestureUp(gestureDown(0, 5, 5), 5, 5)
    expect(s.origin).toBeNull()
    expect(s.button).toBe(0)
  })

  it('resets to idle on a pointer-up with no matching pointer-down', () => {
    expect(gestureUp(IDLE_GESTURE, 9, 9)).toEqual(IDLE_GESTURE)
  })

  it('ignores moves outside a gesture', () => {
    expect(gestureMove(IDLE_GESTURE, 9, 9)).toEqual(IDLE_GESTURE)
  })
})

describe('createClickGestureTracker', () => {
  it('threads down/move/up through mutable state', () => {
    const t = createClickGestureTracker()
    expect(t.state).toEqual(IDLE_GESTURE)
    t.down(1, 0, 10, 10)
    t.move(1, 10 + OVER, 10)
    const closed = t.up(1, 10 + OVER, 10)
    expect(closed.wasDrag).toBe(true)
    expect(t.state).toBe(closed)
  })

  it('starts each gesture fresh, so a drag does not poison the next click', () => {
    const t = createClickGestureTracker()
    t.down(1, 0, 0, 0)
    t.move(1, 500, 500)
    t.up(1, 500, 500)
    t.down(1, 0, 7, 7)
    t.up(1, 7, 7)
    expect(isStationaryPrimaryClick(t.state)).toBe(true)
  })

  it('reset clears the verdict', () => {
    const t = createClickGestureTracker()
    t.down(1, 0, 1, 1)
    t.reset()
    expect(t.state).toEqual(IDLE_GESTURE)
  })

  it('ignores a move from a pointer that did not open the gesture', () => {
    const t = createClickGestureTracker()
    t.down(1, 0, 100, 100)
    // A second finger travelling while the first is held must not latch the
    // opener's tracker: the opener never moved, so its release is still a click.
    t.move(2, 400, 400)
    expect(t.state.wasDrag).toBe(false)
    const closed = t.up(1, 100, 100)
    expect(closed.wasDrag).toBe(false)
    expect(isStationaryPrimaryClick(closed)).toBe(true)
  })

  it('ignores a release from a pointer that did not open the gesture', () => {
    const t = createClickGestureTracker()
    t.down(1, 0, 100, 100)
    t.up(2, 400, 400)
    // The foreign release owns nothing: the opener's gesture is still open.
    expect(t.state.origin).toEqual([100, 100])
    expect(t.up(1, 100, 100).wasDrag).toBe(false)
  })
})
