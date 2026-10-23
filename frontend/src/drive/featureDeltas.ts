// The per-feature volume/bbox delta in a run reply. A total volume answers
// "what does the part weigh", not "what did this additive step contribute";
// the checkpoint measures the kernel already holds answer the second question
// without a second build. A failed, partial or warning feature has no row: its
// checkpoint may hold half-applied geometry, so any delta printed for it would
// be a number the solver never stood behind.
//
// A chained call must not repeat the whole history: a plane or an untouched
// sketch did not change because a later call added one feature. The reply
// keeps a row only when the feature's checkpoint differs from the input
// document's solve, or when the steps touched a feature that produces solids
// (so an edit that happens to leave the same volume still shows its zero
// contribution). `mode: 'all'` is the inspection opt-in that restores the
// whole history.

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

export interface FeatureDeltaOptions {
  // The input document's solve, when it could be measured. A feature whose
  // checkpoint matches it was not changed by this run.
  baseline?: readonly FeatureMeasure[] | null
  // Feature ids the steps created or named. Solid-producing entries get a row
  // even when their measure did not move, so a no-op edit is visible.
  touched?: ReadonlySet<string>
  // 'all' lists every clean feature (the inspection opt-in); 'changed' keeps
  // only what this run changed or touched. Omitting the whole options object
  // keeps the historical all-rows behaviour; runHeadless always states one.
  mode?: 'changed' | 'all'
}

const ZERO_BBOX = [0, 0, 0, 0, 0, 0]

// A feature that only authors reference geometry. Everything else puts a body
// in the checkpoint or changes one, and a touched one is worth reporting.
const NON_SOLID_KINDS: ReadonlySet<string> = new Set<string>(['origin', 'sketch', 'plane', 'variable', 'helix'])

export function isSolidProducingKind(kind: string): boolean {
  return !NON_SOLID_KINDS.has(kind)
}

function subtractBbox(after: number[] | null, before: number[] | null): number[] | null {
  if (after === null) return null
  const from = before ?? ZERO_BBOX
  return after.map((value, index) => value - from[index])
}

function closeNumber(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b))
}

function sameMeasure(after: FeatureMeasure, before: FeatureMeasure): boolean {
  if (!closeNumber(after.volume, before.volume)) return false
  if (after.bbox === null || before.bbox === null) return after.bbox === before.bbox
  return after.bbox.every((value, index) => closeNumber(value, before.bbox![index]))
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
  opts: FeatureDeltaOptions = {},
): FeatureDelta[] {
  const byId = new Map(measures.map(measure => [measure.id, measure]))
  const baseline = opts.baseline === undefined || opts.baseline === null
    ? null
    : new Map(opts.baseline.map(measure => [measure.id, measure]))
  const mode = opts.mode ?? 'all'
  const touched = opts.touched ?? new Set<string>()
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
      const kind = typeof feature.kind === 'string' ? feature.kind : 'unknown'
      if (mode === 'all' || includeRow(id, kind, measure)) {
        rows.push({
          id,
          kind,
          status: outcome.status,
          volume: measure.volume,
          bbox: measure.bbox,
          volumeDelta: measure.volume - previousVolume,
          bboxDelta: subtractBbox(measure.bbox, previousBbox),
        })
      }
    }
    previousVolume = measure.volume
    previousBbox = measure.bbox
  }
  return rows

  // A missing baseline means the run could not measure the input document, so
  // it cannot call anything unchanged; showing every clean row is the honest
  // fallback. Otherwise a feature is included when its checkpoint moved, when
  // it was added (no baseline row), or when the steps touched a solid feature.
  function includeRow(id: string, kind: string, measure: FeatureMeasure): boolean {
    if (baseline === null) return true
    const before = baseline.get(id)
    if (before === undefined) return true
    if (!sameMeasure(measure, before)) return true
    return touched.has(id) && isSolidProducingKind(kind)
  }
}

/** The feature ids the steps named or created; `add_*` and `set_*_field`
 *  mutations carry a featureId, and every handler reports what it created. */
export function touchedFeatureIds(steps: readonly unknown[], outcomeSteps: readonly unknown[]): Set<string> {
  const ids = new Set<string>()
  for (const step of steps) {
    if (typeof step !== 'object' || step === null) continue
    const mutation = (step as { mutation?: unknown }).mutation
    if (typeof mutation !== 'object' || mutation === null) continue
    const featureId = (mutation as { featureId?: unknown }).featureId
    if (typeof featureId === 'string' && featureId.length > 0) ids.add(featureId)
  }
  for (const outcome of outcomeSteps) {
    if (typeof outcome !== 'object' || outcome === null) continue
    const created = (outcome as { createdIds?: unknown }).createdIds
    if (!Array.isArray(created)) continue
    for (const id of created) if (typeof id === 'string' && id.length > 0) ids.add(id)
  }
  return ids
}
