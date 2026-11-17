import type { PartDoc } from '@/types/cad'
import { warn } from './helpers'

// ─── Part Style ───

export function applyRenamePart(doc: PartDoc, partId: string, name: string): void {
  const trimmed = name.trim()
  if (!trimmed) return
  if (!doc.part_style) doc.part_style = {}
  const current = doc.part_style[partId] ?? {}
  doc.part_style[partId] = { ...current, name: trimmed }
}

export function applySetPartVisibility(doc: PartDoc, partId: string, visible: boolean): void {
  if (!doc.part_style) doc.part_style = {}
  const current = doc.part_style[partId] ?? {}
  doc.part_style[partId] = { ...current, visible }
}

export function applySetPartColor(doc: PartDoc, partId: string, color: string): void {
  const trimmed = color.trim()
  if (!trimmed) return
  if (!doc.part_style) doc.part_style = {}
  const current = doc.part_style[partId] ?? {}
  doc.part_style[partId] = { ...current, color: trimmed }
}

type ClampedStyleField = 'transparency' | 'metalness' | 'roughness' | 'transmission'

function setClampedStyleField(doc: PartDoc, partId: string, field: ClampedStyleField, value: number): void {
  // A non-finite opacity/metalness/roughness/transmission is not a slider
  // output; clamping NaN or Infinity would still persist an invalid material
  // value into the doc and survive every reload. Refuse the write and leave any
  // prior value untouched.
  if (!Number.isFinite(value)) {
    warn(`setClampedStyleField: refusing non-finite ${field}`, { bodyId: partId, value })
    return
  }
  const clamped = Math.max(0, Math.min(1, value))
  if (!doc.part_style) doc.part_style = {}
  const current = doc.part_style[partId] ?? {}
  doc.part_style[partId] = { ...current, [field]: clamped }
}

export function applySetPartTransparency(doc: PartDoc, partId: string, transparency: number): void {
  setClampedStyleField(doc, partId, 'transparency', transparency)
}

export function applySetPartMetalness(doc: PartDoc, partId: string, metalness: number): void {
  setClampedStyleField(doc, partId, 'metalness', metalness)
}

export function applySetPartRoughness(doc: PartDoc, partId: string, roughness: number): void {
  setClampedStyleField(doc, partId, 'roughness', roughness)
}

export function applySetPartTransmission(doc: PartDoc, partId: string, transmission: number): void {
  setClampedStyleField(doc, partId, 'transmission', transmission)
}
