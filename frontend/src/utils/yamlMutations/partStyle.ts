import type { PartDoc } from '@/types/cad'
import { warn } from './helpers'

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
