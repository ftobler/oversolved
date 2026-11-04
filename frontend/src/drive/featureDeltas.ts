// The per-feature volume/bbox delta in a run reply. A total volume answers
// "what does the part weigh", not "what did this additive step contribute";
// the checkpoint measures the kernel already holds answer the second question
// without a second build. A failed or partial feature has no row: its
// checkpoint may hold half-applied geometry, so any delta printed for it would
// be a number the solver never stood behind. A feature that built but warned
// does get a row, carrying the kernel's `warning`, so the volume of a partial
// tool list is readable without a second `measure` call.
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
import { isBuiltOutcome, type FeatureOutcome } from '@/drive/featureOutcome'

export interface FeatureDelta {
  id: string
  kind: string
  status: string
  // The kernel's own note when the feature built but fell back or skipped
  // something, e.g. "array ca1 has 5 instances, the boolean uses 4".
  warning?: string
  // Cumulative volume and bbox of ALL the live bodies after this feature, not
  // the volume of the body it touched (ppp0105 read it as one body's).
  volume: number
  bbox: number[] | null
  // Change from the previous checkpoint. The first body starts from zero, so
  // its bbox delta is its bbox; a zero baseline is the honest "from nothing".
  volumeDelta: number
  bboxDelta: number[] | null
  // A hole's drill side as the kernel resolved it (FeatureOutcome.direction).
  direction?: 'normal' | 'reverse'
  // A body this feature changed and that body's own volume after it. The name
  // is the feature's own reported body when that one changed, otherwise the
  // one body whose volume moved; a rigid transform or mirror still names its
  // body though the volume comparison cannot see it. Several changed bodies
  // leave this off and set `changedBodyCount` instead, so a disjoint array does
  // not single out its untouched source.
  body?: string
  bodyVolume?: number
  // How many live bodies changed, set only when more than one did. Not the
  // model's live-body count, which `run` reports as the summary's `bodies`.
  changedBodyCount?: number
}

export interface FeatureDeltaOptions {
  // The input document's solve, when it could be measured. A feature whose
  // checkpoint matches it was not changed by this run.
  baseline?: readonly FeatureMeasure[] | null
  // Feature ids the steps created or named. Solid-producing entries get a row
  // even when their measure did not move, so a no-op edit is visible.
  touched?: ReadonlySet<string>
  // 'all' lists every built feature (the inspection opt-in); 'changed' keeps
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

// Live bodies whose own volume moved, a new id counting as changed. A body the
// feature removed is not live and is not counted: the row describes what the
// checkpoint still holds.
function changedBodyIds(
  bodies: Record<string, number>,
  previousBodies: Record<string, number>,
): string[] {
  const changed: string[] = []
  for (const [id, volume] of Object.entries(bodies)) {
    const before = previousBodies[id]
    if (before === undefined || !closeNumber(volume, before)) changed.push(id)
  }
  return changed
}

// The body fields a row can carry, chosen from the measured change rather than
// from the kernel's identity anchor. `body_id` stays a feature's stable anchor
// (a disjoint array deliberately keeps the source's id), so it only names the
// row when that body itself changed.
function bodyFields(
  kind: string,
  bodyId: string | undefined,
  bodies: Record<string, number> | undefined,
  changed: readonly string[],
): Pick<FeatureDelta, 'body' | 'bodyVolume' | 'changedBodyCount'> {
  if (bodies === undefined) return {}
  const count = changed.length > 1 ? { changedBodyCount: changed.length } : {}
  if (bodyId !== undefined && changed.includes(bodyId)) {
    const volume = bodies[bodyId]
    if (volume !== undefined) return { body: bodyId, bodyVolume: volume, ...count }
  }
  if (changed.length === 1) {
    const only = changed[0]
    const volume = bodies[only]
    if (volume !== undefined) return { body: only, bodyVolume: volume }
  }
  if (changed.length > 1) return count
  // A rigid move replaces a body's shape or placement without necessarily
  // changing its volume, so the comparison above cannot see it. This exception
  // is what keeps a transform or mirror described.
  if ((kind === 'transform' || kind === 'mirror') && bodyId !== undefined) {
    const volume = bodies[bodyId]
    if (volume !== undefined) return { body: bodyId, bodyVolume: volume }
  }
  return {}
}

/**
 * Zip the checkpoint measures with the document's feature order and the solve
 * verdicts. Only a feature the kernel built gets a row; a problem feature's
 * checkpoint is still the baseline for the next built one, so later deltas
 * describe the real geometry rather than pretending the failure left nothing
 * behind. A warning is carried on the row it belongs to, not used to drop it.
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
  // The previous checkpoint's body map moves with the volume and bbox above,
  // including past a failed feature: its half-applied bodies are the baseline
  // the next clean row is measured from.
  let previousBodies: Record<string, number> = {}
  for (const feature of doc.features ?? []) {
    const id = typeof feature.id === 'string' ? feature.id : ''
    if (id === '') continue
    const measure = byId.get(id)
    if (measure === undefined) continue
    const outcome = outcomes[id]
    const built = outcome !== undefined && isBuiltOutcome(outcome)
    if (built) {
      const kind = typeof feature.kind === 'string' ? feature.kind : 'unknown'
      const volumeDelta = measure.volume - previousVolume
      const bboxDelta = subtractBbox(measure.bbox, previousBbox)
      if (mode === 'all' || includeRow(id, kind, measure, volumeDelta, bboxDelta)) {
        const bodyId = isSolidProducingKind(kind) ? outcome.bodyId : undefined
        const changed = measure.bodies === undefined ? [] : changedBodyIds(measure.bodies, previousBodies)
        rows.push({
          id,
          kind,
          status: outcome.status,
          volume: measure.volume,
          bbox: measure.bbox,
          volumeDelta,
          bboxDelta,
          ...(outcome.warning !== undefined && { warning: outcome.warning }),
          ...(outcome.direction !== undefined && { direction: outcome.direction }),
          ...bodyFields(kind, bodyId, measure.bodies, changed),
        })
      }
    }
    previousVolume = measure.volume
    previousBbox = measure.bbox
    previousBodies = measure.bodies ?? {}
  }
  return rows

  // A missing baseline means the run could not measure the input document, so
  // it cannot call anything unchanged; showing every built row is the honest
  // fallback. Otherwise a feature is included when its checkpoint moved, when
  // it was added (no baseline row), or when the steps touched a solid feature.
  // An existing reference feature (sketch, plane) whose own delta is zero is
  // left out: its cumulative checkpoint moves with every upstream edit, so a
  // variable edit listed each downstream sketch as a zero row (bearing notes).
  // A newly added one keeps its row, which is how a run sees what it added.
  function includeRow(
    id: string,
    kind: string,
    measure: FeatureMeasure,
    volumeDelta: number,
    bboxDelta: number[] | null,
  ): boolean {
    if (baseline === null) return true
    const before = baseline.get(id)
    if (before === undefined) return true
    if (!isSolidProducingKind(kind) && closeNumber(volumeDelta, 0)
      && (bboxDelta === null || bboxDelta.every(value => closeNumber(value, 0)))) return false
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
