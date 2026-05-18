import type { PartDoc, PartFeature, PartStyleEntry } from '@/types/cad'
import { findFeature } from './helpers'

const BUILTIN_FEATURE_IDS = new Set(['Origin', 'Top', 'Front', 'Right'])

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
  if (!doc.part_style[bodyId]) doc.part_style[bodyId] = {} as PartStyleEntry
  doc.part_style[bodyId].visible = visible
}

export function applySetPartColor(doc: PartDoc, bodyId: string, color: string): void {
  const trimmed = color.trim()
  if (!trimmed) return
  if (!doc.part_style) doc.part_style = {}
  const current = doc.part_style[bodyId] ?? {}
  doc.part_style[bodyId] = { ...current, color: trimmed }
}

export function applySetPartTransparency(doc: PartDoc, bodyId: string, transparency: number): void {
  const clamped = Math.max(0, Math.min(1, transparency))
  if (!doc.part_style) doc.part_style = {}
  const current = doc.part_style[bodyId] ?? {}
  doc.part_style[bodyId] = { ...current, transparency: clamped }
}

export function applySetPartMetalness(doc: PartDoc, bodyId: string, metalness: number): void {
  const clamped = Math.max(0, Math.min(1, metalness))
  if (!doc.part_style) doc.part_style = {}
  const current = doc.part_style[bodyId] ?? {}
  doc.part_style[bodyId] = { ...current, metalness: clamped }
}

export function applySetPartRoughness(doc: PartDoc, bodyId: string, roughness: number): void {
  const clamped = Math.max(0, Math.min(1, roughness))
  if (!doc.part_style) doc.part_style = {}
  const current = doc.part_style[bodyId] ?? {}
  doc.part_style[bodyId] = { ...current, roughness: clamped }
}

export function applySetPartTransmission(doc: PartDoc, bodyId: string, transmission: number): void {
  const clamped = Math.max(0, Math.min(1, transmission))
  if (!doc.part_style) doc.part_style = {}
  const current = doc.part_style[bodyId] ?? {}
  doc.part_style[bodyId] = { ...current, transmission: clamped }
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
    // Per-feature eye-icon toggle: keep auto_hidden_by as override signal,
    // preventing future auto-hides (feature 223).
  } else {
    feature.visible = false
  }
}

export function applyRenameFeature(doc: PartDoc, featureId: string, label: string): void {
  const feature = findFeature(doc, featureId)
  if (!feature) return
  if (label.trim()) {
    feature.label = label.trim()
  } else {
    delete feature.label
  }
}

export function applyToggleSketchPlaneVisibility(doc: PartDoc): void {
  const targets = (doc.features ?? []).filter(
    f => (f.kind === 'sketch' || f.kind === 'plane')
  )
  const anyVisible = targets.some(f => f.visible !== false)
  for (const f of targets) {
    if (anyVisible) {
      f.visible = false
    } else {
      delete f.visible
      delete f.auto_hidden_by  // user override wins (feature 223)
    }
  }
}

export function applyTogglePlaneVisibility(doc: PartDoc): void {
  const targets = (doc.features ?? []).filter(f => {
    if (f.id === 'Origin') return false
    if (f.kind === 'plane') return true
    if (f.id === 'Top' || f.id === 'Front' || f.id === 'Right') return true
    return false
  })
  const anyVisible = targets.some(f => f.visible !== false)
  for (const f of targets) {
    if (anyVisible) {
      f.visible = false
    } else {
      delete f.visible
    }
  }
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
