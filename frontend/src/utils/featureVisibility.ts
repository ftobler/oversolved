// Which sketches and planes the part editor draws.
//
// A sketch a solid feature consumes is hidden: once the body exists its profile
// wires are clutter inside it. The hide is DERIVED from consumption here, never
// written into the document. It used to be a flag the profile pick wrote, and a
// document whose consumer arrived any other way (saved while auto-hide was off,
// 2026-06-13 to 2026-08-29, imported, hand-edited) kept drawing its sketch next
// to the body. Deriving it also means a sketch no feature consumes any more
// (profile un-picked, consumer deleted) comes back on its own.
//
// The auto-hide is a one-shot per sketch: when the user shows a consumed sketch
// the show stamps `auto_hidden` (yamlMutations/partStyle), and from then on the
// `visible` flag alone decides, however many features consume the sketch.
//
// Pure on purpose: the viewport only reads the resulting id set, so the rule is
// tested without mounting it.

import type { PartFeature } from '@/types/cad'
import { allConsumedSketchIds, consumedSketchIds } from '@/utils/query/consumedSketches'

/**
 * Whether `feature` is one of the reference planes the bulk plane toggle works
 * on. It lives here so the toggle, the first-sketch hide, and the plane-pick
 * display rule all read one target set. A builtin id counts even if a document
 * mistyped its kind: the id is what the viewport draws a reference plane for.
 * The origin is not a plane and stays out.
 */
export function isPlaneVisibilityTarget(feature: PartFeature): boolean {
  if (feature.id === 'Origin') return false
  if (feature.kind === 'plane') return true
  return feature.id === 'Top' || feature.id === 'Front' || feature.id === 'Right'
}

/** Whether the document itself shows `feature`, before any editor override. */
function shownInDoc(feature: PartFeature, consumed: ReadonlySet<string>): boolean {
  if (feature.visible === false) return false
  // Consumed, and the user has not shown it since: the auto-hide applies. Only
  // a sketch carries the one-shot flag; for anything else it can never be spent.
  const autoHiddenSpent = feature.kind === 'sketch' && feature.auto_hidden === true
  return !(consumed.has(feature.id) && !autoHiddenSpent)
}

/**
 * The ids the document shows, with no editor open. The bulk sketch/plane
 * toggle asks here too, so "is anything visible" means what the user sees.
 */
export function docVisibleFeatureIds(features: PartFeature[]): Set<string> {
  const consumed = allConsumedSketchIds(features)
  return new Set(features.filter(f => shownInDoc(f, consumed)).map(f => f.id))
}

export interface EditVisibility {
  // The feature whose editor is open, if any.
  editingFeatureId?: string | null
  // Ids the open edit forces on screen (the sketch being edited).
  forcedVisible?: Iterable<string>
  // A sketch's plane pick field is armed. The first sketch hides the reference
  // planes by a document write, but picking a plane for a later sketch (or a
  // re-pick) needs them drawn: a hidden plane has no geometry to click. Derived
  // here, never written, so the field closing puts them straight back.
  planePickArmed?: boolean
}

/**
 * The ids the part editor draws. On top of the document rule, an open editor
 * keeps its own geometry on screen: the sketch being edited, and the sketches
 * the open consumer picks its profiles from. The latter is a deliberate choice:
 * while an extrude's editor is open its profile sketch stays drawn so the next
 * profile pick from the same sketch is still possible and the picked region
 * stays visible as the selection. It is hidden again the moment the editor
 * closes, whether by OK or Cancel.
 */
export function visibleFeatureIds(features: PartFeature[], edit: EditVisibility = {}): Set<string> {
  const out = docVisibleFeatureIds(features)
  if (edit.planePickArmed) {
    for (const feature of features) {
      if (isPlaneVisibilityTarget(feature)) out.add(feature.id)
    }
  }
  for (const id of edit.forcedVisible ?? []) out.add(id)
  const edited = edit.editingFeatureId ? features.find(f => f.id === edit.editingFeatureId) : undefined
  if (edited) for (const id of consumedSketchIds(edited, features)) out.add(id)
  return out
}
