// The headless operations the non-browser drivers share: build a document by
// running a script through one DocSession, measure it and export it. The node
// CLI and the MCP server call these, so the two external surfaces cannot
// drift; the caller bootstraps the kernel first (setOccLoader, setSketchSolver,
// setSketchTopology) and owns the file paths, which is the only place the two
// differ.
//
// Each call here is a fresh part and therefore a fresh session. That is the
// same one-session-per-operation shape the CLI has always had (one process per
// invocation); a driver that keeps the process alive (MCP) must serialize its
// calls, which its stdio loop does by construction.

import type { PartDoc, BodyResult } from '@/types/cad'
import type { SolveSchedulerState } from '@/session/SolveScheduler'
import { measureLocally, exportLocally, solveLocally, type LocalExportOptions } from '@/kernel/solveLocally'
import { compareMeasures, type MeasureRow } from '@/kernel/occ/measureTolerance'
import type { MeasureRecord } from '@/kernel/occ/measure'
import type { TranslationReference } from '@/translations/corpus'
import { selectByPredicate, type SelectResult, type Selector } from '@/kernel/select'
import { BUILTIN_FEATURE_DEFAULTS } from '@/utils/builtins'
import { createHeadlessPart, type HeadlessPart } from '@/drive/headlessPart'
import { partSolvePayload } from '@/drive/solveWriteBack'
import { docHashOf } from '@/drive/docHash'
import type { CommandJournal } from '@/drive/journal'
import type { ScriptRunOutcome, ScriptStep } from '@/drive/scriptRunner'

// The app seeds a fresh document with the builtin features (useDocumentState);
// the headless drivers mirror that so commands that toggle plane/sketch
// visibility operate on the same document shape the browser does.
export function seedBuiltins(doc: PartDoc): PartDoc {
  if (!Array.isArray(doc.features) || doc.features.length === 0) {
    doc.features = BUILTIN_FEATURE_DEFAULTS.map(f => ({ ...f }))
  }
  return doc
}

export interface HeadlessRunOptions {
  doc: PartDoc
  steps: readonly ScriptStep[]
  // The solve cache key; stable per document so incremental rebuilds apply.
  docId?: string
  // The solve file map for docs with import_step: file_id -> bytes.
  files?: ReadonlyMap<string, Uint8Array>
  // When given, every session mutation is journaled into it.
  journal?: CommandJournal
}

export interface HeadlessRunResult {
  ok: boolean
  outcome: ScriptRunOutcome
  doc: PartDoc | null
  docHash: string | null
  solve: SolveSchedulerState
  // The live part, for a caller that wants the session (the CLI records a
  // repro from its journal; most callers only read the fields above).
  part: HeadlessPart
}

/** Run a script through one headless session and report the end state. */
export async function runHeadless(opts: HeadlessRunOptions): Promise<HeadlessRunResult> {
  const part = createHeadlessPart({
    doc: opts.doc,
    docId: opts.docId,
    files: opts.files,
    journal: opts.journal,
  })
  const outcome = await part.run(opts.steps)
  const doc = part.getDoc()
  const solve = part.solve.state()
  return {
    ok: outcome.ok && solve.lastError === null,
    outcome,
    doc,
    docHash: doc ? docHashOf(doc) : null,
    solve,
    part,
  }
}

export interface HeadlessMeasureOptions {
  docId?: string
  files?: ReadonlyMap<string, Uint8Array>
}

/** Measure a document through the local kernel; null when OCC is unavailable. */
export async function measureHeadless(doc: PartDoc, opts: HeadlessMeasureOptions = {}): Promise<MeasureRecord | null> {
  return measureLocally(partSolvePayload(doc, opts.docId ?? 'headless'), opts.files)
}

export interface HeadlessCompareResult {
  ok: boolean
  pass: boolean
  rows: MeasureRow[]
  measures: MeasureRecord | null
  error?: string
}

/**
 * Measure a document and compare it against a reference at the reference's
 * tolerance and topology mode. `ok: false` only means the kernel is
 * unavailable or the document did not build (what `measureHeadless` reports
 * as null or throws); a failing row is data: `ok: true, pass: false`, so an
 * agent loop can read which measure diverged.
 */
export async function compareHeadless(
  doc: PartDoc,
  reference: TranslationReference,
  opts: HeadlessMeasureOptions = {},
): Promise<HeadlessCompareResult> {
  let measures: MeasureRecord | null
  try {
    measures = await measureHeadless(doc, opts)
  } catch (e) {
    return {
      ok: false,
      pass: false,
      rows: [],
      measures: null,
      error: e instanceof Error ? e.message : String(e),
    }
  }
  if (!measures) {
    return {
      ok: false,
      pass: false,
      rows: [],
      measures: null,
      error: 'local solver unavailable (OCC.js or the Rust solver is not provisioned)',
    }
  }
  const { pass, rows } = compareMeasures(measures, reference, {
    tolerance: reference.tolerance,
    topology: reference.topology,
  })
  return { ok: true, pass, rows, measures }
}

export interface HeadlessExportOptions extends LocalExportOptions {
  docId?: string
  files?: ReadonlyMap<string, Uint8Array>
}

/** Export a document through the local kernel; null when there is no solid. */
export async function exportHeadless(doc: PartDoc, opts: HeadlessExportOptions): Promise<Uint8Array | null> {
  const { docId, files, ...exportOpts } = opts
  return exportLocally(partSolvePayload(doc, docId ?? 'headless'), exportOpts, files)
}

export interface HeadlessSelectOptions {
  docId?: string
  files?: ReadonlyMap<string, Uint8Array>
}

/**
 * Select faces or edges by predicate over a document's solve output, returning
 * the query strings a click would have stored. Null when the kernel is
 * unavailable; throws SelectorError on an invalid expression or an empty match
 * (the caller surfaces that as `{ ok: false, error }`).
 */
export async function selectHeadless(
  doc: PartDoc,
  selector: Selector,
  opts: HeadlessSelectOptions = {},
): Promise<SelectResult | null> {
  const response = await solveLocally(partSolvePayload(doc, opts.docId ?? 'headless'), {
    ...(opts.files ? { files: opts.files } : {}),
  })
  if (!response) return null
  return selectByPredicate(selector, response.bodies as Record<string, BodyResult>)
}
