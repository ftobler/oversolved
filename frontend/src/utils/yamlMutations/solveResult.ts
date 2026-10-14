import type { PartDoc, PartConstraint } from '@/types/cad'
import { approxF32Equal } from '../transform3d'
import { CONSTRAINT_REF_FIELDS, refMatchesEntity, round } from './helpers'

function constraintReferencesAny(c: PartConstraint, removed: Set<string>): boolean {
  for (const key of CONSTRAINT_REF_FIELDS) {
    const raw = c[key]
    if (typeof raw === 'string') {
      for (const eid of removed) {
        if (refMatchesEntity(raw, eid)) return true
      }
    }
  }
  if (c.refs) {
    for (const raw of c.refs) {
      if (typeof raw === 'string') {
        for (const eid of removed) {
          if (refMatchesEntity(raw, eid)) return true
        }
      }
    }
  }
  return false
}

// The write-back has to keep the authored geometry recognisable to every
// consumer that compares doc content. The worker hands back the solved params
// decoded as float32 (wasm-kernel/codec.ts decodeOutput), while the sketch
// mutators persist round(v, 6) (helpers.ts), so two writers describe one
// geometry with different digits -- and in the band above ~4 the f32 quantum is
// wide enough that even 6dp rounding lands on the wrong side of it:
// round(f32(25.7)) is 25.700001, round(f32(63.4)) is 63.400002 and
// f32(100.000001) is 100 outright. A re-solve that moved nothing would then read
// as a change everywhere content is compared: useSolver's save identity guard
// mints a fresh doc object (so a save overlapping it stops clearing dirty),
// findFirstDirty's checkpoint hash goes stale (rebuilding the feature and
// everything after it), and docDiffersForSession manufactures a user edit out
// of a solve. So when the solved geometry agrees with what the feature already
// carries within the f32 envelope, the authored spelling is KEPT -- the digits
// the user's mutator wrote, not a fresh spelling of the same geometry.
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

// Whether the freshly solved geometry says the same thing as the one already in
// the document: same entity ids, same arity per entity, every component inside
// the f32 envelope of the matching component. The compare is per component and
// per entity, because a solve that moved one entity of ten moved something --
// and a different id set (a projected dimension, an added entity, one the solve
// dropped) is a shape change no amount of matching values can stand in for.
function sameGeometryWithinF32(
  existing: Record<string, number[]>,
  solved: Record<string, number[]>,
): boolean {
  const existingIds = Object.keys(existing)
  if (existingIds.length !== Object.keys(solved).length) return false
  for (const id of existingIds) {
    const before = existing[id]
    const after = solved[id]
    if (after === undefined || before.length !== after.length) return false
    for (let i = 0; i < before.length; i++) {
      if (!approxF32Equal(before[i], after[i])) return false
    }
  }
  return true
}

// Solved geometry adoption is the ONLY write-back the generic solve owns. The
// superfluous/projection_error flags and resolved kinds are solve-time facts and
// live in solveResults, so undo never fights an invisible re-delete.
export function applyGeometryToFeature(
  doc: PartDoc,
  featureId: string,
  geometry: Record<string, number[]>,
): void {
  const featureDef = (doc.features ?? []).find(f => f.id === featureId)
  if (!featureDef) return
  const existing = featureDef.initial
  // Keep the arrays the doc already holds, by reference: they may be shared with
  // the pre-solve doc the caller compares this clone against, so they must not
  // be rebuilt or rounded in place here. Only a solve that moved the geometry
  // outside the f32 envelope -- or changed which entities exist -- installs a
  // fresh map, rounded to the precision the mutators write.
  if (existing && sameGeometryWithinF32(existing, geometry)) return
  featureDef.initial = roundGeometry(geometry)
}

// The explicit cleanup command's handler: removes the projected entities and
// superfluous constraints the last solve flagged, then drops any constraint that
// references a removed entity so no dangling refs linger in the doc. Only
// source-carrying entities are eligible for removal (a flagged entity without a
// source is a plain sketch entity and is kept). Undo restores the whole doc.
export function applyRemoveDanglingContent(
  doc: PartDoc,
  perFeature: Record<string, { entities: string[]; constraints: string[] }>,
): void {
  for (const [featureId, { entities, constraints }] of Object.entries(perFeature)) {
    const feature = (doc.features ?? []).find(f => f.id === featureId)
    if (!feature) continue
    const flagged = new Set(entities)
    const toRemove = new Set(
      (feature.entities ?? [])
        .filter(e => e.source != null && flagged.has(e.id))
        .map(e => e.id),
    )
    if (feature.entities && toRemove.size > 0) {
      feature.entities = feature.entities.filter(e => !toRemove.has(e.id))
    }
    if (feature.constraints) {
      const superfluous = new Set(constraints)
      feature.constraints = feature.constraints.filter(
        c => !superfluous.has(c.id) && !constraintReferencesAny(c, toRemove),
      )
    }
  }
}

// Whether a cleanup plan would actually remove anything from the doc. The
// command is derived from the last solve's flags; the doc may have changed
// since, and an all-absent plan must not push a dead undo entry. Mirrors the
// handler's eligibility rules (source-carrying entities, listed constraints).
export function hasDanglingContentInDoc(
  doc: PartDoc,
  perFeature: Record<string, { entities: string[]; constraints: string[] }>,
): boolean {
  for (const [featureId, { entities, constraints }] of Object.entries(perFeature)) {
    const feature = (doc.features ?? []).find(f => f.id === featureId)
    if (!feature) continue
    if (entities.some(eid => (feature.entities ?? []).some(e => e.id === eid && e.source != null))) return true
    if (constraints.some(cid => (feature.constraints ?? []).some(c => c.id === cid))) return true
  }
  return false
}
