// The authoring-time orientation capture: which pose facts become authored
// mate params when a pick completes the reference pair. This is the editor's
// half of the no-seed-state contract with the solver (mate_residuals.rs):
// orientation the user can see must reach the solver as document data.

import { describe, expect, it } from 'vitest'
import type { AnchorPose } from '@/kernel/partBundle'
import type { AnchorTable } from '@/utils/anchorGizmos'
import { captureMateOrientationPatch } from '@/utils/mateCapture'

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
})
