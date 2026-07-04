import type { PartDoc, PartFeature } from '@/types/cad'
import { BUILTIN_FEATURE_IDS } from '@/utils/builtins'
import { findFeature } from './helpers'
import { isValidVariableName } from '@/kernel/features/variable'

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

export function applyAddSketch(doc: PartDoc, featureId: string, label?: string): void {
  if (!doc.features) doc.features = []
  const feature: PartFeature = { id: featureId, kind: 'sketch' }
  if (label) feature.label = label
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
  } else {
    feature.visible = false
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
  const anyVisible = targets.some(f => f.visible !== false)
  for (const f of targets) {
    if (anyVisible) {
      f.visible = false
    } else {
      delete f.visible
    }
  }
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
    case 'sketch':
      if (feature.extrude?.sketch !== undefined) {
        arr = Array.isArray(feature.extrude.sketch) ? feature.extrude.sketch : feature.extrude.sketch ? [feature.extrude.sketch] : []
      } else if (feature.revolve?.sketch !== undefined) {
        arr = Array.isArray(feature.revolve.sketch) ? feature.revolve.sketch : feature.revolve.sketch ? [feature.revolve.sketch] : []
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
