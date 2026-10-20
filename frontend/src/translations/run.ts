/**
 * The translation runner: build one case through `measureLocally` (the same
 * path `compareHeadless` uses, so a corpus case and an agent's `compare` call
 * are measured identically), then compare its records against the reference at
 * the reference's own tolerance and topology mode.
 *
 * No STEP round trip and no upstream edit replay: those are oracle contracts.
 */

import { measureLocally } from '@/kernel/solveLocally'
import { compareMeasures, type MeasureRow } from '@/kernel/occ/measureTolerance'
import { partSpecFromText } from '@/utils/partExport'
import type { MeasureRecord } from '@/kernel/occ/measure'
import type { TranslationCase } from './corpus'

export interface TranslationRun {
  measures: MeasureRecord
  pass: boolean
  rows: MeasureRow[]
}

export async function runTranslationCase(translationCase: TranslationCase): Promise<TranslationRun> {
  // The case name is the doc id: a document switch resets solveLocally's
  // cross-solve cache, so cases never build on each other's checkpoints.
  const doc = partSpecFromText(translationCase.recipe)
  doc.id = translationCase.name
  const measures = await measureLocally(doc)
  if (measures === null) {
    throw new Error('translations: solveLocally returned null (OCC.js unavailable?)')
  }
  const { pass, rows } = compareMeasures(measures, translationCase.reference, {
    tolerance: translationCase.reference.tolerance,
    topology: translationCase.reference.topology,
  })
  return { measures, pass, rows }
}
