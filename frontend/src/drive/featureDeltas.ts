// The per-feature volume/bbox delta in a run reply. A total volume answers
// "what does the part weigh", not "what did this additive step contribute";
// the checkpoint measures the kernel already holds answer the second question
// without a second build. A failed, partial or warning feature has no row: its
// checkpoint may hold half-applied geometry, so any delta printed for it would
// be a number the solver never stood behind.

import type { PartDoc } from '@/types/cad'
import type { FeatureMeasure } from '@/kernel/solveLocally'
import { isFeatureProblem, type FeatureOutcome } from '@/drive/featureOutcome'

export interface FeatureDelta {
  id: string
  kind: string
  status: string
  // Cumulative volume and bbox of the live bodies after this feature.
  volume: number
  bbox: number[] | null
  // Change from the previous checkpoint. The first body starts from zero, so
  // its bbox delta is its bbox; a zero baseline is the honest "from nothing".
  volumeDelta: number
  bboxDelta: number[] | null
}

const ZERO_BBOX = [0, 0, 0, 0, 0, 0]

function subtractBbox(after: number[] | null, before: number[] | null): number[] | null {
  if (after === null) return null
  const from = before ?? ZERO_BBOX
  return after.map((value, index) => value - from[index])
}

/**
 * Zip the checkpoint measures with the document's feature order and the solve
 * verdicts. Only a clean feature gets a row; a problem feature's checkpoint is
 * still the baseline for the next clean one, so later deltas describe the real
 * geometry rather than pretending the failure left nothing behind.
 */
export function featureDeltaRows(
  doc: PartDoc,
  measures: readonly FeatureMeasure[],
  outcomes: Record<string, FeatureOutcome>,
): FeatureDelta[] {
  const byId = new Map(measures.map(measure => [measure.id, measure]))
  const rows: FeatureDelta[] = []
  let previousVolume = 0
  let previousBbox: number[] | null = null
  for (const feature of doc.features ?? []) {
    const id = typeof feature.id === 'string' ? feature.id : ''
    if (id === '') continue
    const measure = byId.get(id)
    if (measure === undefined) continue
    const outcome = outcomes[id]
    const clean = outcome !== undefined && !isFeatureProblem(outcome)
    if (clean) {
      rows.push({
        id,
        kind: typeof feature.kind === 'string' ? feature.kind : 'unknown',
        status: outcome.status,
        volume: measure.volume,
        bbox: measure.bbox,
        volumeDelta: measure.volume - previousVolume,
        bboxDelta: subtractBbox(measure.bbox, previousBbox),
      })
    }
    previousVolume = measure.volume
    previousBbox = measure.bbox
  }
  return rows
}
