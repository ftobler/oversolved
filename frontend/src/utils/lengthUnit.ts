// One place that knows what a document's length unit means. Stored numbers are
// numbers in the document's own unit; only the millimetre-based file formats
// (STEP, STL, an imported STEP) need the factor. Pure, so the kernel, the
// measurement registry and the export dialog all read the same table.

import type { LengthUnit } from '@/types/cad'

/** The suffix beside a length readout and the choice label in the export
 *  dialog: SI millimetres, or the inch symbol. */
export const LENGTH_UNIT_LABEL: Record<LengthUnit, string> = { mm: 'mm', inch: 'in' }

/** The spelled-out unit, for prose such as the export dialog's confirmation
 *  toast; a readout keeps the short label. */
export const LENGTH_UNIT_NAME: Record<LengthUnit, string> = { mm: 'millimetres', inch: 'inches' }

/** Millimetres in one document unit. STEP and STL are written in millimetres. */
export const MM_PER_LENGTH_UNIT: Record<LengthUnit, number> = { mm: 1, inch: 25.4 }

export function isLengthUnit(value: unknown): value is LengthUnit {
  return value === 'mm' || value === 'inch'
}

/**
 * The factor a part document's geometry takes when it enters an assembly. An
 * assembly document has no length unit and keeps the millimetre frame, so its
 * mate offsets and instance transforms are millimetres; a part's stored numbers
 * are in its own unit. The factor is 1 for a millimetre part and 25.4 for an
 * inch part.
 */
export function partToAssemblyScale(doc: { length_unit?: unknown } | null | undefined): number {
  return MM_PER_LENGTH_UNIT[lengthUnitOf(doc?.length_unit)]
}

/**
 * The unit a raw document or solve spec carries. Absent is millimetres, which is
 * the format's default and what every document written before the field means.
 * A malformed value also reads as millimetres here; the loader is what refuses
 * it by name (`validatePart`), matching how `docVersion` reads a bad stamp.
 */
export function lengthUnitOf(value: unknown): LengthUnit {
  return value === 'inch' ? 'inch' : 'mm'
}

/**
 * The `import_step.scale` an import into this document needs. The STEP reader
 * normalises a file to millimetres, so an inch document divides by 25.4 to keep
 * the part's physical size and make its numbers inches. Millimetres needs no
 * authored scale (absence is the default), so this returns undefined rather than
 * writing a noisy 1.
 */
export function importScaleFor(unit: LengthUnit): number | undefined {
  return unit === 'inch' ? 1 / MM_PER_LENGTH_UNIT.inch : undefined
}
