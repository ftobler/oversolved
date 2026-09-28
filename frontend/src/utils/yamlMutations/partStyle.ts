import type { PartDoc, PartFeature } from '@/types/cad'
import { BUILTIN_FEATURE_IDS } from '@/utils/builtins'
import { findFeature, warn } from './helpers'
import { isValidVariableName } from '@/kernel/features/variable'
import { allConsumedSketchIds } from '@/utils/query/consumedSketches'
import { docVisibleFeatureIds } from '@/utils/featureVisibility'

// ─── Part Style ───

export function applyRenamePart(doc: PartDoc, bodyId: string, name: string): void {
  const trimmed = name.trim()
  if (!trimmed) return
  if (!doc.part_style) doc.part_style = {}
  const current = doc.part_style[bodyId] ?? {}
  doc.part_style[bodyId] = { ...current, name: trimmed }
}

export function applySetBodyVisibility(doc: PartDoc, bodyId: string, visible: boolean): void {
  if (!doc.part_style) doc.part_style = {}
  const current = doc.part_style[bodyId] ?? {}
  doc.part_style[bodyId] = { ...current, visible }
}

export function applySetPartColor(doc: PartDoc, bodyId: string, color: string): void {
  const trimmed = color.trim()
  if (!trimmed) return
  if (!doc.part_style) doc.part_style = {}
  const current = doc.part_style[bodyId] ?? {}
  doc.part_style[bodyId] = { ...current, color: trimmed }
}

type ClampedStyleField = 'transparency' | 'metalness' | 'roughness' | 'transmission'

function setClampedStyleField(doc: PartDoc, bodyId: string, field: ClampedStyleField, value: number): void {
  // A non-finite opacity/metalness/roughness/transmission is not a slider
  // output; clamping NaN or Infinity would still persist an invalid material
  // value into the doc and survive every reload. Refuse the write and leave any
  // prior value untouched.
  if (!Number.isFinite(value)) {
    warn(`setClampedStyleField: refusing non-finite ${field}`, { bodyId, value })
    return
  }
  const clamped = Math.max(0, Math.min(1, value))
  if (!doc.part_style) doc.part_style = {}
  const current = doc.part_style[bodyId] ?? {}
  doc.part_style[bodyId] = { ...current, [field]: clamped }
}

export function applySetPartTransparency(doc: PartDoc, bodyId: string, transparency: number): void {
  setClampedStyleField(doc, bodyId, 'transparency', transparency)
}

export function applySetPartMetalness(doc: PartDoc, bodyId: string, metalness: number): void {
  setClampedStyleField(doc, bodyId, 'metalness', metalness)
}

export function applySetPartRoughness(doc: PartDoc, bodyId: string, roughness: number): void {
  setClampedStyleField(doc, bodyId, 'roughness', roughness)
}

export function applySetPartTransmission(doc: PartDoc, bodyId: string, transmission: number): void {
  setClampedStyleField(doc, bodyId, 'transmission', transmission)
}

// ─── Sketch admin ───

export function applyAddSketch(doc: PartDoc, featureId: string, label?: string, plane?: string): void {
  if (!doc.features) doc.features = []
  const feature: PartFeature = { id: featureId, kind: 'sketch' }
  if (label) feature.label = label
  if (plane) feature.plane = plane  // pre-bound plane skips the pick step
  doc.features.push(feature)
}

export function applyDeleteFeature(doc: PartDoc, featureId: string): void {
  if (!doc.features) return
  if (BUILTIN_FEATURE_IDS.has(featureId)) return
  doc.features = doc.features.filter(f => f.id !== featureId)
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
    spendOwedHideOnShow(doc, [feature])
  } else {
    feature.visible = false
  }
}

// A consumed sketch no pick ever hid is hidden by the derived rule
// (utils/featureVisibility) whatever its flag says, so clearing the flag alone
// would leave the user's "show" doing nothing. Showing it spends the one-shot
// the pick would have spent: from here on `visible` is the user's setting.
// Unconsumed sketches are left unstamped, so their first consume still hides.
function spendOwedHideOnShow(doc: PartDoc, shown: PartFeature[]): void {
  const consumed = allConsumedSketchIds(doc.features ?? [])
  for (const f of shown) {
    if (consumed.has(f.id)) f.auto_hidden = true
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
  // "Visible" as the user sees it: a consumed sketch the derived rule hides
  // counts as hidden even with no flag. Reading the flag alone, a toggle over
  // sketches that are all derived-hidden would "hide" them again and change
  // nothing on screen.
  const shown = docVisibleFeatureIds(doc.features ?? [])
  const anyVisible = targets.some(f => shown.has(f.id))
  for (const f of targets) {
    if (anyVisible) {
      f.visible = false
    } else {
      delete f.visible
    }
  }
  if (!anyVisible) spendOwedHideOnShow(doc, targets)
}

export function applyToggleSketchPlaneVisibility(doc: PartDoc): void {
  toggleVisibility(doc, f => f.kind === 'sketch' || f.kind === 'plane')
}

export function applyTogglePlaneVisibility(doc: PartDoc): void {
  toggleVisibility(doc, f => {
    if (f.id === 'Origin') return false
    if (f.kind === 'plane') return true
    if (f.id === 'Top' || f.id === 'Front' || f.id === 'Right') return true
    return false
  })
}

export function applyAddPlane(doc: PartDoc, featureId: string, label?: string, definition?: Record<string, unknown>): void {
  if (!doc.features) doc.features = []
  const feature: PartFeature = { id: featureId, kind: 'plane', definition: definition ?? { mode: 'offset', plane: '@builtin_plane_front' } }
  if (label) feature.label = label
  doc.features.push(feature)
}

export function applySetPlaneDefinitionField(
  doc: PartDoc,
  featureId: string,
  field: string,
  value: string | number,
): void {
  const feature = findFeature(doc, featureId)
  if (!feature) return
  if (!feature.definition) feature.definition = {}
  // A numeric plane field is persisted verbatim; a non-finite value would seed
  // NaN into the document and survive every reload, so reject it at the gate.
  if (typeof value === 'number' && !Number.isFinite(value)) {
    warn('applySetPlaneDefinitionField: ignoring non-finite value', { featureId, field, value })
    return
  }
  ;(feature.definition as Record<string, string | number>)[field] = value
}

// ─── Pick field reorder ───

export function applyReorderPickField(doc: PartDoc, featureId: string, field: string, fromIndex: number, toIndex: number): void {
  const feature = doc.features?.find(f => f.id === featureId)
  if (!feature) return

  let arr: unknown[] | undefined
  switch (field) {
    case 'edges':
      arr = feature.fillet?.edges ?? feature.chamfer?.edges
      break
    case 'tools':
      arr = feature.boolean?.tools
      break
    case 'bodies':
      arr = feature.delete_body?.bodies ?? feature.transform?.bodies
      break
    case 'sketch':
      // A bare-string sketch ref (legacy docs, or hand-authored YAML) is
      // normalized in place into a one-element array first, so `arr` below
      // is a live reference into the document -- same as every other branch
      // -- rather than a throwaway copy the trailing splice would mutate
      // without the change ever reaching the feature.
      if (feature.extrude?.sketch !== undefined) {
        if (!Array.isArray(feature.extrude.sketch)) {
          feature.extrude.sketch = feature.extrude.sketch ? [feature.extrude.sketch] : []
        }
        arr = feature.extrude.sketch
      } else if (feature.revolve?.sketch !== undefined) {
        if (!Array.isArray(feature.revolve.sketch)) {
          feature.revolve.sketch = feature.revolve.sketch ? [feature.revolve.sketch] : []
        }
        arr = feature.revolve.sketch
      } else if (feature.sweep?.sketch !== undefined) {
        if (!Array.isArray(feature.sweep.sketch)) {
          feature.sweep.sketch = feature.sweep.sketch ? [feature.sweep.sketch] : []
        }
        arr = feature.sweep.sketch
      }
      break
    case 'path':
      // Same normalize-in-place rationale as 'sketch' above: a sweep path may
      // be stored as a bare string, and the splice needs a live array.
      if (feature.sweep?.path !== undefined) {
        if (!Array.isArray(feature.sweep.path)) {
          feature.sweep.path = feature.sweep.path ? [feature.sweep.path] : []
        }
        arr = feature.sweep.path
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
