// Stage 1 of the triad angle snap: the pure math the ring drag authors with.

import { describe, it, expect } from 'vitest'
import {
  SNAP_STEP_DEG,
  SNAP_TOLERANCE_DEG,
  snapSwing,
  datumAngle,
  snapTickAngles,
} from '@/utils/gizmoAngleSnap'

const deg = (d: number) => d * Math.PI / 180
const toDeg = (r: number) => r * 180 / Math.PI

describe('snapSwing', () => {
  it('pulls a swing inside the band onto the nearest multiple of the step', () => {
    const r = snapSwing(deg(29))
    expect(r.snapped).toBe(true)
    expect(toDeg(r.angle)).toBeCloseTo(30, 9)
    expect(r.step).toBe(2)
  })

  it('leaves a swing between two bands exactly where the user put it', () => {
    const r = snapSwing(deg(22))
    expect(r.snapped).toBe(false)
    expect(toDeg(r.angle)).toBeCloseTo(22, 9)
  })

  it('reports an untouched swing to the caller bit for bit', () => {
    // Stage 2 feeds this straight back into the drag, so free motion must not
    // pick up rounding on its way through.
    const swing = deg(22.375)
    expect(snapSwing(swing).angle).toBe(swing)
  })

  it('snaps a swing that is already on a step', () => {
    const r = snapSwing(deg(45))
    expect(r.snapped).toBe(true)
    expect(toDeg(r.angle)).toBeCloseTo(45, 9)
    expect(r.step).toBe(3)
  })

  it('treats a swing sitting exactly on the tolerance boundary as snapped', () => {
    const r = snapSwing(deg(SNAP_STEP_DEG - SNAP_TOLERANCE_DEG))
    expect(r.snapped).toBe(true)
    expect(toDeg(r.angle)).toBeCloseTo(SNAP_STEP_DEG, 9)
  })

  it('leaves a swing just outside the tolerance boundary free', () => {
    const r = snapSwing(deg(SNAP_STEP_DEG - SNAP_TOLERANCE_DEG - 0.01))
    expect(r.snapped).toBe(false)
  })

  it('snaps a zero swing, so a nudge that goes nowhere authors nothing', () => {
    const r = snapSwing(0)
    expect(r.snapped).toBe(true)
    expect(r.angle).toBe(0)
    expect(r.step).toBe(0)
  })

  it('snaps negative swings symmetrically', () => {
    const r = snapSwing(deg(-31))
    expect(r.snapped).toBe(true)
    expect(toDeg(r.angle)).toBeCloseTo(-30, 9)
    expect(r.step).toBe(-2)
  })

  it('leaves a negative swing between bands free', () => {
    expect(snapSwing(deg(-22)).snapped).toBe(false)
  })

  it('follows an unwrapped swing past a full turn instead of wrapping it', () => {
    // unwrapAngle keeps growing without bound, and the part receives the total,
    // so 719 deg must resolve to 720 deg and never fall back to 0.
    const r = snapSwing(deg(719))
    expect(r.snapped).toBe(true)
    expect(toDeg(r.angle)).toBeCloseTo(720, 6)
    expect(r.step).toBe(48)
  })

  it('keeps a free swing past a full turn at its full magnitude', () => {
    const r = snapSwing(deg(725))
    expect(r.snapped).toBe(false)
    expect(toDeg(r.angle)).toBeCloseTo(725, 9)
  })

  it('follows an unwrapped negative swing past a full turn', () => {
    const r = snapSwing(deg(-406))
    expect(r.snapped).toBe(true)
    expect(toDeg(r.angle)).toBeCloseTo(-405, 6)
    expect(r.step).toBe(-27)
  })
})

describe('datumAngle', () => {
  it('rounds an arbitrary grab bearing down to the nearest quarter turn', () => {
    expect(toDeg(datumAngle(deg(20)))).toBeCloseTo(0, 9)
    expect(toDeg(datumAngle(deg(100)))).toBeCloseTo(90, 9)
  })

  it('rounds a bearing up when the next quarter is the nearer one', () => {
    expect(toDeg(datumAngle(deg(200)))).toBeCloseTo(180, 9)
    expect(toDeg(datumAngle(deg(260)))).toBeCloseTo(270, 9)
  })

  it('carries a bearing in the last quarter to a full turn rather than back to zero', () => {
    // The datum is a bearing the dial draws, and cos/sin do not care that it
    // reads 360; leaving it unwrapped keeps it adjacent to the swing it pairs with.
    expect(toDeg(datumAngle(deg(320)))).toBeCloseTo(360, 9)
  })

  it('resolves a grab exactly between two quarters upward', () => {
    expect(toDeg(datumAngle(deg(45)))).toBeCloseTo(90, 9)
    expect(toDeg(datumAngle(deg(-45)))).toBeCloseTo(0, 9)
  })

  it('handles negative bearings, which atan2 hands us for half the ring', () => {
    expect(toDeg(datumAngle(deg(-100)))).toBeCloseTo(-90, 9)
    expect(toDeg(datumAngle(deg(-170)))).toBeCloseTo(-180, 9)
  })

  it('always lands on a tick, since a quarter turn is a whole number of steps', () => {
    for (const bearing of [17, 88, 191, 274, -63, -212]) {
      const stepped = toDeg(datumAngle(deg(bearing))) / SNAP_STEP_DEG
      expect(stepped).toBeCloseTo(Math.round(stepped), 9)
    }
  })
})

describe('snapTickAngles', () => {
  it('covers the full circle once at the snap step', () => {
    const ticks = snapTickAngles()
    expect(ticks).toHaveLength(360 / SNAP_STEP_DEG)
    expect(toDeg(ticks[0])).toBeCloseTo(0, 9)
    expect(toDeg(ticks[1])).toBeCloseTo(SNAP_STEP_DEG, 9)
    expect(toDeg(ticks[ticks.length - 1])).toBeCloseTo(360 - SNAP_STEP_DEG, 9)
  })

  it('does not repeat the zero tick at the far end', () => {
    expect(snapTickAngles().every(a => a < Math.PI * 2)).toBe(true)
  })

  it('hands out a fresh array, so a renderer cannot corrupt the shared one', () => {
    expect(snapTickAngles()).not.toBe(snapTickAngles())
    expect(snapTickAngles()).toEqual(snapTickAngles())
  })
})
