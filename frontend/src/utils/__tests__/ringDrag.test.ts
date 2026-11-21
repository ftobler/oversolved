// The rotation-ring drag law, on its own. The assembly pointer and the section
// rings both call this, so these are the cases that used to live inside the
// assembly adapter's tests: a quarter turn, unwrapping past a half turn, the
// 15-degree snap and its radius gate, and the datum.
import { describe, it, expect } from 'vitest'
import { beginRingDrag, moveRingDrag } from '@/utils/ringDrag'
import { RING_RADIUS } from '@/utils/gizmoPickGeometry'
import type { Ray } from '@/utils/gizmoMath'

const DEG = Math.PI / 180
const Z_AXIS: [number, number, number] = [0, 0, 1]
const X_REF: [number, number, number] = [1, 0, 0]

// A pointer on the Z ring at `deg` around the gizmo, sighted down -Z.
const armAt = (deg: number, radius = 5): Ray => {
  const a = deg * DEG
  return { origin: [Math.cos(a) * radius, Math.sin(a) * radius, 10], direction: [0, 0, -1] }
}

const grab = (at = armAt(0)) => {
  const drag = beginRingDrag(at, [0, 0, 0], Z_AXIS, X_REF)
  if (!drag) throw new Error('ring grab missed its plane')
  return drag
}

describe('beginRingDrag', () => {
  it('starts on the datum of the grabbed bearing, rounded to a quarter turn', () => {
    expect(grab(armAt(0)).datum).toBeCloseTo(0, 12)
    expect(grab(armAt(70)).datum).toBeCloseTo(Math.PI / 2, 12)
    // The signed angle wraps at half a turn, and the datum follows: 200 degrees
    // is read as -160 and rounds to -180.
    expect(grab(armAt(200)).datum).toBeCloseTo(-Math.PI, 12)
    expect(grab(armAt(0)).swing).toBe(0)
  })

  it('refuses a ray that never meets the ring plane', () => {
    // The ray runs inside the ring's own plane: no bearing is readable.
    expect(beginRingDrag({ origin: [0, 0, 0], direction: [1, 0, 0] }, [0, 0, 0], Z_AXIS, X_REF)).toBeNull()
  })
})

describe('moveRingDrag', () => {
  it('a quarter turn reads a quarter turn', () => {
    const drag = grab()
    expect(moveRingDrag(drag, armAt(90))!.swing).toBeCloseTo(Math.PI / 2, 12)
  })

  it('unwraps past a half turn instead of flipping sign', () => {
    const drag = grab()
    let last = 0
    for (const deg of [90, 170, 250, 330, 400]) {
      last = moveRingDrag(drag, armAt(deg))!.swing / DEG
      expect(last).toBeCloseTo(deg, 9)
    }
  })

  it('snaps to a 15 degree step inside the tolerance band', () => {
    const drag = grab()
    const moved = moveRingDrag(drag, armAt(88), 10)!
    expect(moved.swing / DEG).toBeCloseTo(90, 10)
    expect(moved.snapped).toBe(true)
  })

  it('between two bands the swing is handed back untouched', () => {
    const drag = grab()
    const moved = moveRingDrag(drag, armAt(82), 10)!
    expect(moved.swing / DEG).toBeCloseTo(82, 9)
    expect(moved.snapped).toBe(false)
  })

  it('pulling outside the ring disarms the snap, however close to a tick', () => {
    const drag = grab()
    const scale = 10
    const outside = RING_RADIUS * scale * 1.6
    const moved = moveRingDrag(drag, armAt(88, outside), scale)!
    expect(moved.snapArmed).toBe(false)
    expect(moved.swing / DEG).toBeCloseTo(88, 9)
    // A caller with no camera to measure keeps the feature the user asked for.
    expect(moveRingDrag(drag, armAt(88), undefined)!.snapArmed).toBe(true)
  })

  it('the accumulator carries the raw swing, not the snapped one', () => {
    const drag = grab()
    moveRingDrag(drag, armAt(88))  // snaps to 90, raw stays 88
    // 179 back from 88 is 181 on from 90: only the raw accumulation gets this.
    const moved = moveRingDrag(drag, armAt(269))!
    expect(moved.swing / DEG).toBeCloseTo(-90, 10)
  })

  it('a move whose ray never meets the ring plane leaves the swing alone', () => {
    const drag = grab()
    const before = drag.swing
    expect(moveRingDrag(drag, { origin: [0, 0, 0], direction: [1, 0, 0] })).toBeNull()
    expect(drag.swing).toBe(before)
  })
})
