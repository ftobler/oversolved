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
import { exportLocally, solveLocally, buildAndMeasureLocally, measureSolveFeatures, type FeatureMeasure, type LocalExportOptions } from '@/kernel/solveLocally'
import { KernelFault } from '@/kernel/errors'
import { compareMeasures, type MeasureRow } from '@/kernel/occ/measureTolerance'
import type { MeasureRecord } from '@/kernel/occ/measure'
import type { TranslationReference } from '@/translations/corpus'
import { selectByPredicate, type SelectResult, type Selector } from '@/kernel/select'
import { BUILTIN_FEATURE_DEFAULTS } from '@/utils/builtins'
import { createHeadlessPart, type HeadlessPart } from '@/drive/headlessPart'
import { featureProblems, readSolveOutcomes, MISSING_VERDICT_STATUS, type FeatureProblem } from '@/drive/featureOutcome'
import { featureDeltaRows, touchedFeatureIds, type FeatureDelta } from '@/drive/featureDeltas'
import { featureFrames, type FeatureFrameMap } from '@/drive/featureFrames'
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
  // 'all' restores the whole feature history in featureDeltas; the default
  // reports only what this call changed. The inspection opt-in.
  featureDeltas?: 'all'
}

export interface HeadlessRunResult {
  ok: boolean
  outcome: ScriptRunOutcome
  doc: PartDoc | null
  docHash: string | null
  solve: SolveSchedulerState
  // The live body ids of the final solve; null when the script ran no solve (an
  // empty step list), in which case the reply falls back to the document's
  // part_style keys.
  bodies: readonly string[] | null
  // The features the solve did not finish cleanly, in feature log order. This
  // is always present: an empty list is the clean-build answer.
  features: FeatureProblem[]
  // Volume and bbox for the features this run changed or touched, with the
  // change from the previous checkpoint. Null when the final solve exposed no
  // measurable checkpoints (no kernel); a failed feature has no row, but its
  // checkpoint still sets the baseline for the next clean one.
  featureDeltas: FeatureDelta[] | null
  // The resolved {origin, x_axis, y_axis, normal} of every sketch and add_plane
  // feature the final solve reached. Null when no solve ran; a feature whose
  // solve threw or that was suppressed has no frame.
  frames: FeatureFrameMap | null
  // The live part, for a caller that wants the session (the CLI records a
  // repro from its journal; most callers only read the fields above).
  part: HeadlessPart
}

/**
 * Run a script through one headless session and report the end state. An empty
 * script still solves the starting document, so it is the "inspect this
 * document" call.
 */
export async function runHeadless(opts: HeadlessRunOptions): Promise<HeadlessRunResult> {
  // The delta filter compares the final checkpoints against the document the
  // run started on. Measuring it through the same kernel keeps the comparison
  // real (a raw, un-baked doc measures its authored features, not its stale
  // `initial`); the solve is the one the first step's build restores from, so a
  // chain by docHash is not a second full build. 'all' does not filter, so it
  // skips this entirely.
  const baseline = opts.featureDeltas === 'all' ? null : await measureBaselineFeatures(opts)
  const part = createHeadlessPart({
    doc: opts.doc,
    docId: opts.docId,
    files: opts.files,
    journal: opts.journal,
  })
  const outcome = await part.run(opts.steps)
  const doc = part.getDoc()
  const solve = part.solve.state()
  let measures: Awaited<ReturnType<HeadlessPart['featureMeasures']>> = null
  let measureFault: string | null = null
  if (part.bodyIds() !== null) {
    try {
      measures = await part.featureMeasures()
    } catch (e) {
      // The solve itself succeeded, but measuring its checkpoints reads the same
      // kernel. A trap there is the same failed-kernel answer, not an internal
      // error that loses the rest of the reply.
      if (!(e instanceof KernelFault)) throw e
      measureFault = e.message
    }
  }
  const features = doc ? featureProblems(doc, part.solveOutcomes()) : []
  // A missing verdict means the settle did not answer for a feature at all;
  // that is a failed run, unlike a feature that answered `exception` (data the
  // caller reads from `features`). Without this the wedged-kernel reply was
  // ok:true with an empty result.
  const missingVerdict = features.some(problem => problem.status === MISSING_VERDICT_STATUS)
  return {
    ok: outcome.ok && solve.lastError === null && !missingVerdict && measureFault === null,
    outcome,
    doc,
    docHash: doc ? docHashOf(doc) : null,
    solve: measureFault === null ? solve : { ...solve, lastError: measureFault },
    bodies: part.bodyIds(),
    features,
    featureDeltas: doc !== null && measures !== null
      ? featureDeltaRows(doc, measures, part.solveOutcomes(), {
          baseline,
          touched: touchedFeatureIds(opts.steps, outcome.steps),
          mode: opts.featureDeltas === 'all' ? 'all' : 'changed',
        })
      : null,
    frames: part.featureFrames(),
    part,
  }
}

// The input document's per-feature checkpoints, measured without writing the
// solve back: the run must author on the document it was handed, and the
// journal's baseline hash is that same pre-solve doc. Null when the kernel is
// unavailable or the measurement cannot be trusted.
async function measureBaselineFeatures(opts: HeadlessRunOptions): Promise<FeatureMeasure[] | null> {
  try {
    const payload = partSolvePayload(opts.doc, opts.docId ?? 'headless')
    const response = await solveLocally(payload, {
      rollbackPosition: payload.rollback_position,
      ...(opts.files ? { files: opts.files } : {}),
    })
    return response === null ? null : await measureSolveFeatures(response)
  } catch {
    return null
  }
}

export interface HeadlessMeasureOptions {
  docId?: string
  files?: ReadonlyMap<string, Uint8Array>
}

export interface HeadlessMeasure {
  // False when the settle left a feature without a verdict, the same condition
  // that makes a `run` reply ok:false.
  ok: boolean
  measures: MeasureRecord
  // The same problem list a `run` reply carries: measuring builds every
  // feature, so a bore that cut nothing is already known here.
  features: FeatureProblem[]
  // The resolved frames of every sketch and add_plane feature, the same map a
  // run reply carries.
  frames: FeatureFrameMap
}

/** Measure a document through the local kernel; null when OCC is unavailable. */
export async function measureHeadless(doc: PartDoc, opts: HeadlessMeasureOptions = {}): Promise<HeadlessMeasure | null> {
  const built = await buildAndMeasureLocally(partSolvePayload(doc, opts.docId ?? 'headless'), opts.files)
  if (built === null) return null
  const features = featureProblems(doc, readSolveOutcomes(built.response.result))
  return {
    ok: !features.some(problem => problem.status === MISSING_VERDICT_STATUS),
    measures: built.measures,
    features,
    frames: featureFrames(doc, built.response.result),
  }
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
  let measured: HeadlessMeasure | null
  try {
    measured = await measureHeadless(doc, opts)
  } catch (e) {
    return {
      ok: false,
      pass: false,
      rows: [],
      measures: null,
      error: e instanceof Error ? e.message : String(e),
    }
  }
  if (!measured) {
    return {
      ok: false,
      pass: false,
      rows: [],
      measures: null,
      error: 'local solver unavailable (OCC.js or the Rust solver is not provisioned)',
    }
  }
  if (!measured.ok) {
    // A settle that answered nothing must not flow into a comparison: an empty
    // measure can look like a perfect match against an empty reference.
    const missing = measured.features
      .filter(problem => problem.status === MISSING_VERDICT_STATUS)
      .map(problem => problem.id)
      .join(', ')
    return {
      ok: false,
      pass: false,
      rows: [],
      measures: measured.measures,
      error: missing === '' ? 'the solve did not finish cleanly' : `no verdict from the solve for: ${missing}`,
    }
  }
  const measures = measured.measures
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
