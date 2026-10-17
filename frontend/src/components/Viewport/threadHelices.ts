// The cosmetic-thread display: the helices a hole solve reports, one polyline
// per drilled bore. A cosmetic thread is not a pickable reference (the hole is),
// so unlike the helix feature's curve this registers nothing on the pick layer.
//
// The selection part is pure and separate (threadHelices.ts) so the viewport's
// data wiring is testable without a canvas.

import type { SketchData } from '@/types/cad'

export interface ThreadCurve {
  featureId: string
  points: [number, number, number][]
}

/** The thread helices to draw for the given (already visibility-filtered)
 *  features, or [] when none carries one. */
export function collectThreadCurves(
  features: readonly { id: string; kind?: string }[],
  solveResults: Readonly<Record<string, SketchData>> | undefined,
): ThreadCurve[] {
  if (!solveResults) return []
  const out: ThreadCurve[] = []
  for (const feature of features) {
    if (feature.kind !== 'hole') continue
    const thread = solveResults[feature.id]?.thread
    if (!thread || !Array.isArray(thread.helices)) continue
    for (const helix of thread.helices) {
      if (!Array.isArray(helix.points) || helix.points.length < 2) continue
      out.push({ featureId: feature.id, points: helix.points as [number, number, number][] })
    }
  }
  return out
}
