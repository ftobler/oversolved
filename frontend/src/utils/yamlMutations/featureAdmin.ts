// Feature administration: the feature log's own writers (add, delete, reorder,
// rollback, suppression, visibility, rename, plane authoring and pick-field
// reordering). Kept apart from the part_style setters in partStyle.ts so a
// reader can tell a body's appearance from the document's structure.

import type { PartDoc, PartFeature } from '@/types/cad'
import { BUILTIN_FEATURE_IDS } from '@/utils/builtins'
import { findFeature, warn } from './helpers'
import { roundNumericFields, storedNumber, type FieldBag } from './featureDefs'
import { isValidVariableName } from '@/kernel/features/variable'
import { allConsumedSketchIds } from '@/utils/query/consumedSketches'
import { docVisibleFeatureIds, isPlaneVisibilityTarget } from '@/utils/featureVisibility'
import { isSketchClassFeature } from '@/utils/sketchClass'

export function applyAddSketch(doc: PartDoc, featureId: string, label?: string, plane?: string): void {
  if (!doc.features) doc.features = []
  const feature: PartFeature = { id: featureId, kind: 'sketch' }
  if (label) feature.label = label
  if (plane) feature.plane = plane  // pre-bound plane skips the pick step
  doc.features.push(feature)
  // A pre-bound plane is the first sketch's "inserted" moment too; hiding the
  // planes before the push would look for the wrong feature list.
  if (plane) hidePlanesIfFirstBoundSketch(doc, featureId)
}

export function applyDeleteFeature(doc: PartDoc, featureId: string): void {
  if (!doc.features) return
  if (BUILTIN_FEATURE_IDS.has(featureId)) return
  doc.features = doc.features.filter(f => f.id !== featureId)
}

/**
 * The reorder slot an anchor names: `before` X is X's own index (the move lands
 * directly above X), `after` X is the slot below it. Null when no anchor is
 * given or the anchor is not in the log; the value rule refuses an unknown id
 * by name before a drive step gets here.
 */
export function reorderAnchorIndex(doc: PartDoc, anchor: { before?: string; after?: string }): number | null {
  const id = anchor.before ?? anchor.after
  if (id === undefined) return null
  const at = (doc.features ?? []).findIndex(f => f.id === id)
  if (at < 0) return null
  return anchor.before !== undefined ? at : at + 1
}

/** Move a feature to sit directly above `beforeId` (add_plane's `before`). */
export function applyMoveFeatureBefore(doc: PartDoc, featureId: string, beforeId: string): void {
  const toIndex = reorderAnchorIndex(doc, { before: beforeId })
  if (toIndex === null) {
    warn(`applyMoveFeatureBefore: feature ${beforeId} not found`)
    return
  }
  applyReorderFeatures(doc, featureId, toIndex)
}

export function applyReorderFeatures(doc: PartDoc, featureId: string, toIndex: number): void {
  if (!doc.features) return
  if (BUILTIN_FEATURE_IDS.has(featureId)) return
  const fromIndex = doc.features.findIndex(f => f.id === featureId)
  if (fromIndex === -1) return
  // Ensure user features cannot be placed before built-ins.
  const clampedTo = Math.max(toIndex, BUILTIN_FEATURE_IDS.size)
  // Dropping on the feature itself or its immediate successor is a no-op.
  if (fromIndex === clampedTo || fromIndex + 1 === clampedTo) return
  const [feature] = doc.features.splice(fromIndex, 1)
  // After removal, if the original fromIndex was before the target,
  // everything shifted left by 1, so we insert at clampedTo - 1 to land
  // at the same effective position the user hovered over.
  const insertIndex = fromIndex < clampedTo ? clampedTo - 1 : clampedTo
  doc.features.splice(insertIndex, 0, feature)
}

// Persists where the user parked the rollback bar. "At the end of the stack"
// is the overwhelmingly common case and carries no information, so it is
// written as the absence of the key rather than as features.length -- that
// also keeps the field from going stale when features are appended later.
export function applySetRollback(doc: PartDoc, position: number | null): void {
  // Math.max(0, NaN) is NaN and a NaN bar would clamp nothing; a non-finite
  // position is rejected whole, leaving an already-parked bar where it is.
  if (position !== null && !Number.isFinite(position)) {
    warn('applySetRollback: ignoring non-finite position', position)
    return
  }
  const featureCount = doc.features?.length ?? 0
  if (position === null || position >= featureCount) {
    delete doc.rollback
    return
  }
  doc.rollback = Math.max(0, position)
}

export function applySetFeatureSuppression(doc: PartDoc, featureId: string, suppressed: boolean): void {
  if (BUILTIN_FEATURE_IDS.has(featureId)) return
  const feature = findFeature(doc, featureId)
  if (!feature) return
  if (suppressed) {
    feature.suppressed = true
  } else {
    delete feature.suppressed
  }
}

export function applySetFeatureVisibility(doc: PartDoc, featureId: string, visible: boolean): void {
  const feature = findFeature(doc, featureId)
  if (!feature) return
  if (visible) {
    delete feature.visible
    spendAutoHideOnShow(doc, [feature])
  } else {
    feature.visible = false
  }
}

// A consumed sketch is hidden by the derived rule (utils/featureVisibility)
// whatever its flag says, so clearing the flag alone would leave the user's
// "show" doing nothing. Showing it spends the one-shot auto-hide: from here on
// `visible` is the user's setting, however many features consume the sketch.
// Unconsumed sketch-class features are left unstamped, so their first consume
// still hides.
function spendAutoHideOnShow(doc: PartDoc, shown: PartFeature[]): void {
  const consumed = allConsumedSketchIds(doc.features ?? [])
  for (const f of shown) {
    // A helix is sketch-class and carries the same one-shot flag. A consumed id
    // that is neither is a stale ref, and stamping it would write a key nothing
    // reads.
    if (isSketchClassFeature(f) && consumed.has(f.id)) f.auto_hidden = true
  }
}

export function applyRenameFeature(doc: PartDoc, featureId: string, label: string): void {
  const feature = findFeature(doc, featureId)
  if (!feature) return
  const trimmed = label.trim()
  // A variable's label is its reference name: enforce identifier validity and
  // uniqueness, silently rejecting an invalid or colliding rename (MVP: no UI
  // hint yet). An empty label is also rejected (variables must stay named).
  if (feature.kind === 'variable') {
    if (!isValidVariableName(trimmed)) return
    const collision = (doc.features ?? []).some(
      f => f.id !== featureId && f.kind === 'variable' && f.label === trimmed,
    )
    if (collision) return
    feature.label = trimmed
    return
  }
  if (trimmed) {
    feature.label = trimmed
  } else {
    delete feature.label
  }
}

// Toggle `visible` across every feature matching `predicate`: if any is currently
// visible, hide all (visible=false); otherwise show all (drop the override).
function toggleVisibility(doc: PartDoc, predicate: (f: PartFeature) => boolean): void {
  const targets = (doc.features ?? []).filter(predicate)
  // "Visible" as the user sees it: a consumed sketch counts as hidden even with
  // no flag. Reading the flag alone, a toggle over sketches that are all
  // auto-hidden would "hide" them again and change nothing on screen.
  const shown = docVisibleFeatureIds(doc.features ?? [])
  const anyVisible = targets.some(f => shown.has(f.id))
  for (const f of targets) {
    if (anyVisible) {
      f.visible = false
    } else {
      delete f.visible
    }
  }
  if (!anyVisible) spendAutoHideOnShow(doc, targets)
}

// The one "reference geometry on/off" bulk command: sketches, planes and
// helixes. The command name is historical and stays, so its key and every saved
// keybinding keep resolving.
export function applyToggleSketchPlaneVisibility(doc: PartDoc): void {
  toggleVisibility(doc, f => isSketchClassFeature(f) || f.kind === 'plane')
}

export function applyTogglePlaneVisibility(doc: PartDoc): void {
  toggleVisibility(doc, isPlaneVisibilityTarget)
}

// One-way bulk hide, the half `toggleVisibility` cannot be: showing anything is
// never wanted here. A plane the user hid stays hidden with its explicit flag.
export function hidePlanes(doc: PartDoc): void {
  for (const feature of doc.features ?? []) {
    if (isPlaneVisibilityTarget(feature)) feature.visible = false
  }
}

// The reference planes are only needed until the first sketch has one: after
// that they are clutter around the sketch being drawn. Only the first bind
// hides them, so a user who shows them again is never overruled by a second
// sketch. Called from the bind's own applier, so the hide shares its Mutation
// and its undo entry and undoing the bind brings the planes back.
export function hidePlanesIfFirstBoundSketch(doc: PartDoc, sketchId: string): void {
  const anotherBound = (doc.features ?? []).some(
    f => f.kind === 'sketch' && f.id !== sketchId && !!f.plane,
  )
  if (!anotherBound) hidePlanes(doc)
}

export function applyAddPlane(doc: PartDoc, featureId: string, label?: string, definition?: Record<string, unknown>): void {
  // The definition is copied: a journaled add_plane replays its payload, and
  // rounding it in place would rewrite the record the journal still holds.
  const feature: PartFeature = {
    id: featureId,
    kind: 'plane',
    definition: definition ? { ...definition } : { mode: 'offset', plane: '@builtin_plane_front' },
  }
  // A plane's offset or angle is a solver-fed authored quantity like a feature
  // distance, so it crosses the same stored-precision boundary. The features
  // array is only opened once the add is known to apply, so a refusal leaves a
  // key-less document untouched.
  if (!roundNumericFields(feature.definition ?? {}, 'applyAddPlane')) return
  if (label) feature.label = label
  if (!doc.features) doc.features = []
  doc.features.push(feature)
}

export function applySetPlaneDefinitionField(
  doc: PartDoc,
  featureId: string,
  field: string,
  value: string | number,
): void {
  const feature = findFeature(doc, featureId)
  if (feature?.kind !== 'plane') return
  if (!feature.definition) feature.definition = {}
  // A numeric plane field is stored through the same boundary as a feature
  // scalar: gated for finiteness (a non-finite value would seed NaN into the
  // document and survive every reload) and rounded to the stored precision.
  const stored = typeof value === 'number' ? storedNumber(value) : value
  if (stored === null) {
    warn('applySetPlaneDefinitionField: refusing a non-finite number', { featureId, field, value })
    return
  }
  // The scalar value lands on the definition under the named field. The write
  // is scalar because the wire's value rule is scalar; origin_rotation's vector
  // spellings (origin, rotation_axis) exist only in the definition object an
  // add_plane authors, never through this setter.
  const definition = feature.definition as FieldBag
  definition[field] = stored
}

// ─── Pick field reorder ───

/** Rewrite a stored `string | string[]` ref field into the live array the
 *  reorder splices. Returns the array so the caller keeps a reference into the
 *  document; the field is left alone when it was already an array. A missing
 *  sub-def (a raw record naming the kind without it) returns undefined so the
 *  reorder no-ops instead of throwing. */
function normalizeStoredRefList(
  sub: { sketch?: string | string[]; path?: string | string[] } | undefined,
  field: 'sketch' | 'path',
): string[] | undefined {
  if (!sub) return undefined
  const current = sub[field]
  if (Array.isArray(current)) return current
  const list = typeof current === 'string' && current ? [current] : []
  sub[field] = list
  return list
}

export function applyReorderPickField(doc: PartDoc, featureId: string, field: string, fromIndex: number, toIndex: number): void {
  const feature = doc.features?.find(f => f.id === featureId)
  if (!feature) return

  // The payload reads stay optional: a raw record can name a kind without
  // carrying its def, and reordering must no-op on it, not throw.
  let arr: unknown[] | undefined
  switch (field) {
    case 'edges':
      if (feature.kind === 'fillet') arr = feature.fillet?.edges
      else if (feature.kind === 'chamfer') arr = feature.chamfer?.edges
      break
    case 'faces':
      if (feature.kind === 'shell') arr = feature.shell?.faces
      else if (feature.kind === 'move_face') arr = feature.move_face?.faces
      else if (feature.kind === 'delete_face') arr = feature.delete_face?.faces
      break
    case 'tools':
      if (feature.kind === 'boolean') arr = feature.boolean?.tools
      break
    case 'bodies':
      if (feature.kind === 'delete_body') arr = feature.delete_body?.bodies
      else if (feature.kind === 'transform') arr = feature.transform?.bodies
      else if (feature.kind === 'split') arr = feature.split?.bodies
      break
    case 'sketch':
      // A bare-string sketch ref (legacy docs, or hand-authored YAML) is
      // normalized in place into a one-element array first, so `arr` below
      // is a live reference into the document -- same as every other branch
      // -- rather than a throwaway copy the trailing splice would mutate
      // without the change ever reaching the feature.
      if (feature.kind === 'extrude') {
        arr = normalizeStoredRefList(feature.extrude, 'sketch')
      } else if (feature.kind === 'revolve') {
        arr = normalizeStoredRefList(feature.revolve, 'sketch')
      } else if (feature.kind === 'sweep') {
        arr = normalizeStoredRefList(feature.sweep, 'sketch')
      }
      break
    case 'path':
      // Same normalize-in-place rationale as 'sketch' above: a sweep path may
      // be stored as a bare string, and the splice needs a live array.
      if (feature.kind === 'sweep') {
        arr = normalizeStoredRefList(feature.sweep, 'path')
      }
      break
    default:
      return
  }

  if (!arr) return
  if (fromIndex < 0 || fromIndex >= arr.length || toIndex < 0 || toIndex >= arr.length) return
  const [moved] = arr.splice(fromIndex, 1)
  arr.splice(toIndex, 0, moved)
}
