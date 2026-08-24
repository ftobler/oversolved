import type { PartDoc, PartConstraint } from '@/types/cad'
import { CONSTRAINT_REF_FIELDS, refMatchesEntity } from './helpers'

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
  featureDef.initial = geometry
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
