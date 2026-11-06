// The authoring-time orientation capture: which pose facts become authored
// mate params when a pick completes the reference pair. This is the editor's
// half of the no-seed-state contract with the solver (mate_residuals.rs):
// orientation the user can see must reach the solver as document data.

import { describe, expect, it } from 'vitest'
import type { AnchorPose } from '@/kernel/partBundle'
import type { MateRef } from '@/types/cad'
import type { AnchorDescriptorTable, AnchorTable } from '@/utils/anchorGizmos'
import { captureMateOrientationPatch, measureMateRoll } from '@/utils/mateCapture'

const A = { part: 'pa', anchor: 'top' }
const B = { part: 'pb', anchor: 'bottom' }

function table(poseA: Partial<AnchorPose>, poseB: Partial<AnchorPose>): AnchorTable {
  return {
    pa: { top: { kind: 'plane', point: [0, 0, 0], axis: [0, 0, 1], x_axis: [0, 1, 0], ...poseA } },
    pb: { bottom: { kind: 'plane', point: [0, 0, 5], axis: [0, 0, 1], x_axis: [0, 1, 0], ...poseB } },
  }
}

describe('captureMateOrientationPatch', () => {
  it('captures flip=true and a 180 roll for a face-to-face weld', () => {
    // Part B flipped 180 about X to mate face-to-face: axis opposed, canonical
    // frame vector opposed. The authored params must reproduce this pose.
    const t = table({}, { axis: [0, 0, -1], x_axis: [0, -1, 0] })
    expect(captureMateOrientationPatch({ kind: 'fixed' }, A, B, t)).toEqual({ flip: true, angle: 180 })
  })

  it('captures the current roll for aligned axes and leaves flip unset', () => {
    const s = Math.sin(Math.PI / 6)
    const c = Math.cos(Math.PI / 6)
    // B's frame rolled 30 degrees about the shared +Z axis.
    const t = table({}, { x_axis: [-s, c, 0] })
    expect(captureMateOrientationPatch({ kind: 'fixed' }, A, B, t)).toEqual({ flip: undefined, angle: 30 })
  })

  it('normalises a negative captured roll into the editor\'s [0, 360) form', () => {
    const s = Math.sin(Math.PI / 6)
    const c = Math.cos(Math.PI / 6)
    // B rolled -30 degrees about the shared +Z axis. rollAboutAxisDeg reports
    // atan2's -30; the box only ever shows [0, 360), so the capture must agree
    // with it or a picked mate reads differently from a clicked one.
    const t = table({}, { x_axis: [s, c, 0] })
    expect(captureMateOrientationPatch({ kind: 'fixed' }, A, B, t)).toEqual({
      flip: undefined, angle: 330,
    })
  })

  it('resolves an identical pose to the empty defaults, deleting stale keys', () => {
    // flip/angle come back undefined so updateMate strips them: an untouched
    // pair carries no params, and a re-pick clears a previously captured pair.
    const patch = captureMateOrientationPatch({ kind: 'fixed' }, A, B, table({}, {}))
    expect(patch).toEqual({ flip: undefined, angle: undefined })
    // The keys must be PRESENT (set to undefined): updateMate only deletes
    // keys the patch names, and a re-pick must clear a stale captured pair.
    expect(patch && 'flip' in patch && 'angle' in patch).toBe(true)
  })

  it('captures flip but no angle for a roll-free axis mate', () => {
    const t = table({}, { axis: [0, 0, -1] })
    const patch = captureMateOrientationPatch({ kind: 'rotating' }, A, B, t)
    expect(patch).toEqual({ flip: true })
    expect(patch && 'angle' in patch).toBe(false)
  })

  it('resets the angle rather than measuring against a missing frame', () => {
    const t = table({ x_axis: undefined }, {})
    expect(captureMateOrientationPatch({ kind: 'sliding' }, A, B, t)).toEqual({
      flip: undefined, angle: undefined,
    })
  })

  it('captures nothing for kinds without an authored orientation', () => {
    expect(captureMateOrientationPatch({ kind: 'spherical' }, A, B, table({}, {}))).toBeNull()
    expect(captureMateOrientationPatch({ kind: 'tangential' }, A, B, table({}, {}))).toBeNull()
  })

  it('captures nothing while the pair is incomplete or unresolvable', () => {
    const t = table({}, {})
    expect(captureMateOrientationPatch({ kind: 'fixed' }, A, { part: '', anchor: '' }, t)).toBeNull()
    expect(captureMateOrientationPatch({ kind: 'fixed' }, A, undefined, t)).toBeNull()
    expect(captureMateOrientationPatch({ kind: 'fixed' }, A, { part: 'gone', anchor: 'x' }, t)).toBeNull()
  })

  it('re-finds a stale ref by descriptor so re-aiming still measures the real pose', () => {
    // Re-aiming one field of an existing mate leaves the other field untouched.
    // If that other ref's persisted id went stale after a geom_hash move, the
    // capture must still resolve it through the descriptor table; without one it
    // silently keeps the old orientation.
    const s = Math.sin(Math.PI / 6)
    const c = Math.cos(Math.PI / 6)
    const t = table({}, { x_axis: [-s, c, 0] })
    const descriptors: AnchorDescriptorTable = {
      pa: { top: { geom_hash: '@gdf|moved', kind: 'plane', created_by: 'f1', point: [0, 0, 0] } },
    }
    const staleA: MateRef = { part: 'pa', anchor: 'a_stale', anchor_descriptor: descriptors.pa.top }
    expect(captureMateOrientationPatch({ kind: 'fixed' }, staleA, B, t)).toBeNull()
    expect(captureMateOrientationPatch({ kind: 'fixed' }, staleA, B, t, descriptors)).toEqual({
      flip: undefined, angle: 30,
    })
  })
})

/** B's canonical frame rolled `deg` degrees about the shared +Z axis. */
function rolled(deg: number): AnchorTable {
  const r = (deg * Math.PI) / 180
  return table({}, { x_axis: [-Math.sin(r), Math.cos(r), 0] })
}

describe('measureMateRoll', () => {
  it('measures a rotating seed roll while the capture patch stays flip only', () => {
    const t = rolled(80)
    expect(captureMateOrientationPatch({ kind: 'rotating' }, A, B, t)).toEqual({ flip: undefined })
    expect(measureMateRoll(A, B, t)).toBe(80)
  })

  it('reports in the limit coordinate, (-180, 180], not the angle form', () => {
    expect(measureMateRoll(A, B, rolled(-10))).toBe(-10)
    const zero = measureMateRoll(A, B, rolled(0))
    expect(zero).toBe(0)
    expect(Object.is(zero, -0)).toBe(false)
    // The half turn is spelled +180, the closed end of the limit range.
    expect(measureMateRoll(A, B, table({}, { x_axis: [0, -1, 0] }))).toBe(180)
  })

  it('rounds before folding, so a hair below zero reports 0', () => {
    const roll = measureMateRoll(A, B, rolled(-1e-7))
    expect(roll).toBe(0)
    expect(Object.is(roll, -0)).toBe(false)
  })

  it('measures nothing without a posed frame or a resolvable pair', () => {
    expect(measureMateRoll(A, B, table({ x_axis: undefined }, {}))).toBeNull()
    expect(measureMateRoll(A, B, table({}, { x_axis: undefined }))).toBeNull()
    expect(measureMateRoll(A, { part: '', anchor: '' }, rolled(30))).toBeNull()
    expect(measureMateRoll(A, { part: 'gone', anchor: 'x' }, rolled(30))).toBeNull()
  })
})
