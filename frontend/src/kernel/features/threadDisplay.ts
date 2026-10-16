// The cosmetic thread's display geometry: one helix per drill site, laid on the
// bore wall a hole's cut leaves behind.
//
// A cosmetic thread changes no geometry. What a solve reports is the thread's
// metadata plus these polylines, and the viewport draws them: the standard
// representation of a threaded hole without modelling the thread flank. The
// polylines reuse the helix feature's own frame math (features/helixMath.ts), so
// a thread and a helix feature at the same pitch, radius and axis sample
// identically.
//
// Pure: no OCC, no document.

import type { HelixFeatureDef, ThreadDisplayData, ThreadHelixData } from '@/types/cad'
import type { HelixReference } from './helixMath'
import { helixFrame, helixSamples, resolveHelixParams } from './helixMath'

export type Vec3 = [number, number, number]

// Points per turn in the display polyline, the same figure the helix feature
// uses: as fine as the mesher's own angular deflection without bloating the
// solve result.
const POINTS_PER_TURN = 24

/** One drill site's bore: where the thread helix runs and how far. */
export interface ThreadSite {
  center: Vec3
  axis: Vec3
  // The bore's radius: the wall the cosmetic helix rides on.
  radius: number
  // How far the bore runs along `axis` (the drilled depth, or the body's span
  // for a through hole).
  length: number
}

// The display shapes live in types/cad with the other solve-result payloads,
// so the store's result bag and this producer cannot drift.
export type ThreadHelix = ThreadHelixData
export type ThreadDisplay = ThreadDisplayData

/**
 * The display helices for `sites` at `pitch`, one per site. A site shorter than
 * one pitch keeps a single turn so the thread still reads as a thread; a
 * non-positive pitch or a degenerate axis is the caller's to refuse (the hole
 * leaf validates the spec), so this throws rather than emitting an empty line.
 */
export function threadHelices(sites: ThreadSite[], pitch: number): ThreadHelix[] {
  if (!Number.isFinite(pitch) || pitch <= 0) throw new Error('thread display: pitch must be positive')
  const out: ThreadHelix[] = []
  for (const site of sites) {
    const turns = Math.max(1, site.length / pitch)
    const def: HelixFeatureDef = {
      mode: 'pitch_turns', pitch, turns, hand: 'right', direction: 'normal',
      start_angle: 0, offset: 0,
    }
    const ref: HelixReference = {
      kind: 'circular_edge',
      axis: site.axis,
      origin: site.center,
      radius: site.radius,
      xAxis: undefined,
      extent: undefined,
    }
    const params = resolveHelixParams(def, ref)
    const frame = helixFrame(ref, params, def)
    out.push({
      center: site.center,
      axis: site.axis,
      radius: site.radius,
      pitch,
      turns: params.turns,
      points: helixSamples(frame, POINTS_PER_TURN),
    })
  }
  return out
}
