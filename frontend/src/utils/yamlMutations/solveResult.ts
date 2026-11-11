import type { PartDoc } from '@/types/cad'
import { round } from './helpers'

// The write-back has to keep the authored geometry recognisable to every
// consumer that compares doc content. The solver decides what it moved (its
// `entity_moved` report, with the tolerance knowledge living in the crate), so
// this module only asks a second, exact question per component: would writing
// the solved value change the stored bytes? `round(v) === e || v === e` is that
// question, not a tolerance. It covers the two cases the solver's report cannot:
// a projected entity, whose doc value is a rounded cache of a freshly re-derived
// projection, and a value that already sits on the document grid.
//
// The map is rebuilt with new arrays rather than rounded in place: it belongs to
// the solve result record, which the caller still renders from
// (unflattenGeometry) and still compares against the doc in useSolver's identity
// guard. Rounding a shared array under it would rewrite the solver's own numbers.
function roundGeometry(geometry: Record<string, number[]>): Record<string, number[]> {
  const rounded: Record<string, number[]> = {}
  for (const [key, values] of Object.entries(geometry)) {
    rounded[key] = values.map(v => round(v))
  }
  return rounded
}

// Solved geometry adoption is the ONLY write-back the generic solve owns. The
// superfluous/projection_error flags and resolved kinds are solve-time facts and
// live in solveResults, so undo never fights an invisible re-delete.
//
// `moved` is the solver's per-entity report: an entity absent from it was not
// moved by more than half a storage step, so the authored array is kept by
// reference. A projected entity is never kept that way even when the solver
// reports it unmoved (a projection is pinned, so it always is): its doc value
// is a rounded cache that the fresh projection may legitimately outgrow. An
// absent set means no report reached this call; every entity then has to pass
// the exact no-op test on its own.
//
// Returns whether it installed a fresh `initial`. The headless flush uses that
// as its settle signal: the install is the solve rounded to the document grid,
// and a solve seeded from it can land elsewhere, so the reply must be built
// from another solve of the stored document. A non-sketch feature and a solve
// that agreed with the authored spelling both report false.
export function applyGeometryToFeature(
  doc: PartDoc,
  featureId: string,
  geometry: Record<string, number[]>,
  moved?: ReadonlySet<string>,
): boolean {
  const featureDef = (doc.features ?? []).find(f => f.id === featureId)
  if (featureDef?.kind !== 'sketch') return false
  const existing = featureDef.initial
  // The id set is shape, not movement: an added, dropped or newly projected
  // entity installs the whole map, exactly as before.
  if (existing === undefined || Object.keys(existing).length !== Object.keys(geometry).length
    || Object.keys(geometry).some(id => existing[id] === undefined)) {
    featureDef.initial = roundGeometry(geometry)
    return true
  }
  // Held entities (targets of projection constraints) are pinned, so the solver
  // never reports them moved; their doc value is still a rounded cache of a
  // re-derived one, so they always take the exact no-op test instead.
  const projections = new Set(
    (featureDef.constraints ?? []).filter(c => c.kind === 'projection' && typeof c.target === 'string')
      .map(c => String(c.target).replace(/^\$/, '')),
  )
  const next: Record<string, number[]> = {}
  let installed = false
  for (const [id, after] of Object.entries(geometry)) {
    const before = existing[id]
    const keepByReport = before.length === after.length
      && moved !== undefined && !moved.has(id) && !projections.has(id)
    const sameBytes = before.length === after.length
      && after.every((v, i) => round(v) === before[i] || v === before[i])
    if (keepByReport || sameBytes) {
      next[id] = before
    } else {
      next[id] = after.map(v => round(v))
      installed = true
    }
  }
  if (!installed) return false
  featureDef.initial = next
  return true
}

// Whether a sketch solve may be baked into the document's `initial`.
//
// An overconstrained solve is a least-squares compromise, not the geometry the
// user asked for: baking it moves `fixed` geometry, reseeds the next solve from
// the compromise, and the headless settle closes on a document that keeps
// shifting. The render path still shows the best-effort solve with its culprit
// constraints painted; only the stored geometry keeps the last SATISFIED solve
// (or the authored seed on a cold solve). Underconstrained and fully
// constrained solves bake as they always did.
export function shouldBakeSketchGeometry(
  featureResult: { status?: string } | null | undefined,
): boolean {
  return featureResult?.status !== 'overconstrained'
}

// The explicit cleanup command's handler: removes the projected entities and
// superfluous constraints the last solve flagged, then drops any constraint that
// references a removed entity so no dangling refs linger in the doc. Only
// source-carrying entities are eligible for removal (a flagged entity without a
// source is a plain sketch entity and is kept). Undo restores the whole doc.
export function applyRemoveDanglingContent(
  doc: PartDoc,
  perFeature: Record<string, { projections: string[]; constraints: string[] }>,
): void {
  for (const [featureId, { projections, constraints }] of Object.entries(perFeature)) {
    const feature = (doc.features ?? []).find(f => f.id === featureId)
    if (feature?.kind !== 'sketch') continue
    const flagged = new Set(projections)
    if (feature.constraints) {
      const superfluous = new Set(constraints)
      feature.constraints = feature.constraints.filter(
        c => !(superfluous.has(c.id)) && !(flagged.has(c.id) && c.kind === 'projection'),
      )
    }
  }
}

// Whether a cleanup plan would actually remove anything from the doc. The
// command is derived from the last solve's flags; the doc may have changed
// since, and an all-absent plan must not push a dead undo entry. Mirrors the
// handler's eligibility rules (projection constraints, listed constraints).
export function hasDanglingContentInDoc(
  doc: PartDoc,
  perFeature: Record<string, { projections: string[]; constraints: string[] }>,
): boolean {
  for (const [featureId, { projections, constraints }] of Object.entries(perFeature)) {
    const feature = (doc.features ?? []).find(f => f.id === featureId)
    if (feature?.kind !== 'sketch') continue
    if (projections.some(cid => (feature.constraints ?? []).some(c => c.id === cid && c.kind === 'projection'))) return true
    if (constraints.some(cid => (feature.constraints ?? []).some(c => c.id === cid))) return true
  }
  return false
}
