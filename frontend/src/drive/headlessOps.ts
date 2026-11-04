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

import type { PartDoc, BodyResult, AssemblyDoc, Transform3D } from '@/types/cad'
import type { SolveSchedulerState } from '@/session/SolveScheduler'
import { exportLocallyInspect, solveLocally, buildAndMeasureLocally, measureSolveFeatures, measureAssemblyLocally, exportAssemblyLocally, type FeatureMeasure, type LocalExportOptions } from '@/kernel/solveLocally'
import { KernelFault } from '@/kernel/errors'
import { compareMeasures, type MeasureRow } from '@/kernel/occ/measureTolerance'
import type { MeasureRecord } from '@/kernel/occ/measure'
import type { TranslationReference } from '@/translations/corpus'
import { selectByPredicate, validateSelector, type SelectResult } from '@/kernel/select'
import { BUILTIN_FEATURE_DEFAULTS } from '@/utils/builtins'
import { CURRENT_DOC_VERSION } from '@/persistence/docSchema'
import { createHeadlessPart, type HeadlessCheckpoint, type HeadlessPart } from '@/drive/headlessPart'
import { featureProblems, readSolveOutcomes, MISSING_VERDICT_STATUS, type FeatureProblem } from '@/drive/featureOutcome'
import { featureDeltaRows, touchedFeatureIds, type FeatureDelta } from '@/drive/featureDeltas'
import { featureFrames, type FeatureFrameMap } from '@/drive/featureFrames'
import { partSolvePayload } from '@/drive/solveWriteBack'
import { docHashOf } from '@/drive/docHash'
import type { CommandJournal } from '@/drive/journal'
import type { ScriptRunOutcome, ScriptStep } from '@/drive/scriptRunner'
import { createHeadlessAssembly, type AssemblyScriptStep, type InjectedBundle } from '@/drive/headlessAssembly'
import type { AssemblyBuildResponse, AssemblySolveStatus } from '@/kernel/solveAssembly'
import {
  instancePoses,
  mateFrames,
  mateProblems,
  partProblems,
  solveFailed,
  summarizeAssembly,
  type AssemblyPartProblem,
  type InstancePose,
  type MateFrame,
  type MateProblem,
} from '@/drive/assemblyOutcome'

// The app seeds a fresh document with the builtin features (useDocumentState);
// the headless drivers mirror that so commands that toggle plane/sketch
// visibility operate on the same document shape the browser does.
export function seedBuiltins(doc: PartDoc): PartDoc {
  if (!Array.isArray(doc.features) || doc.features.length === 0) {
    doc.features = BUILTIN_FEATURE_DEFAULTS.map(f => ({ ...f }))
  }
  return doc
}

/**
 * The empty document a headless driver starts from. It is stamped with the
 * loader's ladder version: the drive writes current documents, and a stamp
 * of 1 sent every reply back through the migration ladder on reload, which
 * rewrote the `$sk1` sketch refs to `@sk1` and moved a YAML round-tripped
 * docHash (din_clip F5, ANC101 F1).
 */
export function emptyDriveDoc(): PartDoc {
  return seedBuiltins({ version: CURRENT_DOC_VERSION, kind: 'part', features: [] })
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
  // Forwards the state each settled step left behind; the kernel worker uses it
  // to report a stalled solve without losing the accepted prefix.
  onStepSettled?: (checkpoint: HeadlessCheckpoint) => void
}

export interface HeadlessRunResult {
  ok: boolean
  // Whether a settle was attempted for the document this reply describes: set
  // when the solve starts, reset per run. False is a refused-only script, the
  // one case where an empty `features` list is honest; a faulted settle is
  // true, because it attempted the answer and failed to give one.
  solved: boolean
  outcome: ScriptRunOutcome
  doc: PartDoc | null
  docHash: string | null
  solve: SolveSchedulerState
  // The live body ids of the last settle; null when no settle ran or the last
  // one left no response (a faulted kernel), in which case the reply falls back
  // to the document's part_style keys only when no step stopped the script.
  bodies: readonly string[] | null
  // The features the solve did not finish cleanly, in feature log order. This
  // is always present: an empty list is the clean-build answer, and a run that
  // never settled has no verdicts to report, so it is empty there too.
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
    ...(opts.onStepSettled && { onStepSettled: opts.onStepSettled }),
  })
  const outcome = await part.run(opts.steps)
  const solved = part.solveAttempted()
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
  const features = doc !== null && solved ? featureProblems(doc, part.solveOutcomes()) : []
  // A missing verdict means the settle did not answer for a feature at all;
  // that is a failed run, unlike a feature that answered `exception` (data the
  // caller reads from `features`). Without this the wedged-kernel reply was
  // ok:true with an empty result. Only a settle that was attempted can have
  // missing verdicts: a refused-only script never asked, so it has none.
  const missingVerdict = features.some(problem => problem.status === MISSING_VERDICT_STATUS)
  return {
    ok: outcome.ok && solve.lastError === null && !missingVerdict && measureFault === null,
    solved,
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
// solve back: the baseline measurement reads the document it was handed. The
// run itself settles (and bakes) the doc once before its first step when that
// step names a selector, so the journal's baseline hash is that settled doc in
// that case; replay is unaffected because each entry carries its seed.
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

export interface HeadlessExport {
  // Null when the build left no solid to serialise.
  bytes: Uint8Array | null
  // The features the export build did not finish cleanly, in feature log
  // order; the same list a run or measure reply carries.
  features: FeatureProblem[]
  // An export's ok is stricter than a run's: the file is the answer, so any
  // failed, partial or warned feature makes it a different model than the
  // document describes. It stays separate from the file itself: the caller
  // still gets the bytes, and the reply says they are not the whole story.
  ok: boolean
}

/** Export a document through the local kernel; null when the kernel is unavailable. */
export async function exportHeadless(doc: PartDoc, opts: HeadlessExportOptions): Promise<HeadlessExport | null> {
  const { docId, files, ...exportOpts } = opts
  const outcome = await exportLocallyInspect(partSolvePayload(doc, docId ?? 'headless'), exportOpts, files)
  if (outcome === null) return null
  const features = featureProblems(doc, readSolveOutcomes(outcome.response.result))
  // No file is not a successful export: ok names the outcome the caller acts
  // on, and callers keep their own bytes guard for the message.
  return { bytes: outcome.bytes, features, ok: outcome.bytes !== null && features.length === 0 }
}

export interface HeadlessSelectOptions {
  docId?: string
  files?: ReadonlyMap<string, Uint8Array>
}

/**
 * Select faces or edges by predicate over a document's solve output, returning
 * the query strings a click would have stored. Null when the kernel is
 * unavailable; throws SelectorError on an invalid expression or an empty match
 * (the caller surfaces that as `{ ok: false, error }`). The selector is
 * validated here, at the headless boundary, so every caller gets the same
 * grammar and the letter axis sugar even when it skipped the MCP check.
 */
export async function selectHeadless(
  doc: PartDoc,
  selectorRaw: unknown,
  opts: HeadlessSelectOptions = {},
): Promise<SelectResult | null> {
  const selector = validateSelector(selectorRaw)
  const response = await solveLocally(partSolvePayload(doc, opts.docId ?? 'headless'), {
    ...(opts.files ? { files: opts.files } : {}),
  })
  if (!response) return null
  return selectByPredicate(selector, response.bodies as Record<string, BodyResult>)
}

// ─── assembly ───

/** The state every assembly reply shares: the solve, its problem lists and the
 *  solved poses. */
export interface AssemblyState {
  solve: AssemblySolveStatus
  mates: MateProblem[]
  parts: AssemblyPartProblem[]
  instances: InstancePose[]
  mateFrames: Record<string, MateFrame>
  summary: string
}

function assemblyState(
  doc: AssemblyDoc,
  response: AssemblyBuildResponse,
  outcomes: Record<string, { features: FeatureProblem[]; error?: string }>,
  docHashes: ReadonlyMap<string, string>,
): AssemblyState {
  const mates = mateProblems(doc, response.status)
  const parts = partProblems(doc, outcomes, docHashes)
  return {
    solve: response.status,
    mates,
    parts,
    instances: instancePoses(doc, response.transforms),
    mateFrames: mateFrames(doc, response),
    summary: summarizeAssembly(doc, response.status, mates, parts),
  }
}

/** The binding as part specs plus hashes, the shape measure/export need. */
function assemblySpecs(
  doc: AssemblyDoc,
  parts: ReadonlyMap<string, PartDoc>,
  transforms: Record<string, Transform3D>,
): { handle: string; spec: Record<string, unknown>; transform: Transform3D }[] {
  return (doc.features ?? [])
    .filter(f => f.kind === 'part_instance' && f.instance)
    .map((f) => {
      const instance = f.instance!
      const partDoc = parts.get(instance.doc_id)
      if (!partDoc) throw new Error(`part "${instance.doc_id}" is not bound`)
      return {
        handle: instance.handle,
        spec: partSolvePayload(partDoc, instance.doc_id),
        transform: transforms[instance.handle] ?? instance.transform,
      }
    })
}

function docHashesOf(parts: ReadonlyMap<string, PartDoc>): Map<string, string> {
  return new Map([...parts].map(([docId, partDoc]) => [docId, docHashOf(partDoc)]))
}

export interface HeadlessAssemblyRunOptions {
  doc: AssemblyDoc
  parts: ReadonlyMap<string, PartDoc>
  steps: readonly AssemblyScriptStep[]
  files?: ReadonlyMap<string, Uint8Array>
  // Solve the starting document in a throwaway session so the reply can list
  // only the poses the script moved. A separate session, because a pre-solve on
  // the run's own session would change what a later fixed toggle bakes.
  baseline?: boolean
  // Test seam, never set across the kernel worker boundary: build a part bundle
  // without OCC.
  bundleSource?: (docId: string, partDoc: PartDoc) => Promise<InjectedBundle | null>
}

export interface HeadlessAssemblyRunResult extends AssemblyState {
  ok: boolean
  // The starting document's solved poses; null unless `baseline` was asked.
  baselineInstances: InstancePose[] | null
  outcome: ScriptRunOutcome
  doc: AssemblyDoc
  // The binding after the run. A STEP import grows it, so the reply's composite
  // handle and the part problem hashes must read this, not the input map.
  binding: Record<string, PartDoc>
  session: ReturnType<typeof createHeadlessAssembly>
}

/**
 * Run an assembly script through one headless session and report the end state.
 * `ok` means every step applied and the final solve ran; a stale mate, a part
 * build problem or an overconstrained verdict are data in `mates`/`parts` and
 * the summary (D12).
 */
export async function runAssemblyHeadless(opts: HeadlessAssemblyRunOptions): Promise<HeadlessAssemblyRunResult> {
  let baselineInstances: InstancePose[] | null = null
  if (opts.baseline === true) {
    // A starting document that does not solve (a stale mate the script repairs)
    // has no baseline; the run itself still reports its own solve.
    try {
      const start = createHeadlessAssembly({
        doc: opts.doc,
        parts: opts.parts,
        ...(opts.files && { files: opts.files }),
        ...(opts.bundleSource && { bundleSource: opts.bundleSource }),
      })
      baselineInstances = instancePoses(opts.doc, (await start.solve()).transforms)
    } catch {
      baselineInstances = null
    }
  }
  const session = createHeadlessAssembly({
    doc: opts.doc,
    parts: opts.parts,
    ...(opts.files && { files: opts.files }),
    ...(opts.bundleSource && { bundleSource: opts.bundleSource }),
  })
  const outcome = await session.run(opts.steps)
  const doc = session.getDoc()
  const response = session.lastSolve()
  if (response === null) throw new Error('the assembly run did not solve')
  const binding = session.boundParts()
  const state = assemblyState(doc, response, session.partOutcomes(), docHashesOf(new Map(Object.entries(binding))))
  return {
    ok: outcome.ok && !solveFailed(response.status),
    outcome,
    doc,
    binding,
    session,
    baselineInstances,
    ...state,
  }
}

export interface HeadlessAssemblyMeasure {
  ok: boolean
  measures: MeasureRecord
  state: AssemblyState
}

/**
 * Solve and measure an assembly. Each distinct part doc is built once and
 * placed per instance, and the per-body ids are `<handle>/<bodyId>`.
 */
export async function measureAssemblyHeadless(
  doc: AssemblyDoc,
  parts: ReadonlyMap<string, PartDoc>,
  opts: { files?: ReadonlyMap<string, Uint8Array> } = {},
): Promise<HeadlessAssemblyMeasure | null> {
  const session = createHeadlessAssembly({ doc, parts, ...(opts.files && { files: opts.files }) })
  const response = await session.solve()
  const measures = await measureAssemblyLocally(assemblySpecs(doc, parts, response.transforms), opts.files)
  if (measures === null) return null
  return {
    ok: !solveFailed(response.status),
    measures,
    state: assemblyState(doc, response, session.partOutcomes(), docHashesOf(parts)),
  }
}

export interface HeadlessAssemblyCompare {
  ok: boolean
  pass: boolean
  rows: MeasureRow[]
  measures: MeasureRecord | null
  state: AssemblyState | null
  error?: string
}

/** Measure an assembly and compare it at the reference's tolerance. A failing
 *  row is data; only an unavailable or unsolved kernel is `ok: false`. */
export async function compareAssemblyHeadless(
  doc: AssemblyDoc,
  parts: ReadonlyMap<string, PartDoc>,
  reference: TranslationReference,
  opts: { files?: ReadonlyMap<string, Uint8Array> } = {},
): Promise<HeadlessAssemblyCompare> {
  let measured: HeadlessAssemblyMeasure | null
  try {
    measured = await measureAssemblyHeadless(doc, parts, opts)
  } catch (e) {
    return { ok: false, pass: false, rows: [], measures: null, state: null, error: e instanceof Error ? e.message : String(e) }
  }
  if (!measured) {
    return {
      ok: false, pass: false, rows: [], measures: null, state: null,
      error: 'local solver unavailable (OCC.js or the Rust solver is not provisioned)',
    }
  }
  if (!measured.ok) {
    return {
      ok: false, pass: false, rows: [], measures: measured.measures, state: measured.state,
      error: measured.state.solve.error ?? 'the assembly solve did not run',
    }
  }
  const { pass, rows } = compareMeasures(measured.measures, reference, {
    tolerance: reference.tolerance,
    topology: reference.topology,
  })
  return { ok: true, pass, rows, measures: measured.measures, state: measured.state }
}

export interface HeadlessAssemblyExportOptions extends LocalExportOptions {
  files?: ReadonlyMap<string, Uint8Array>
}

export interface HeadlessAssemblyExport extends AssemblyState {
  // Null when the placed parts produced no solid.
  bytes: Uint8Array | null
  // False when the solve did not run, or when a mate or a bound part reported
  // a problem: the file then holds seed or best-effort poses, not the solved
  // assembly the reply describes. The bytes are still returned.
  ok: boolean
}

/**
 * Export an assembly's placed compound through OCC. Null when the kernel is
 * unavailable. The reply carries the same solve, mate and part verdicts a
 * measure reply does, so a failed solve is never reported as a clean file.
 */
export async function exportAssemblyHeadless(
  doc: AssemblyDoc,
  parts: ReadonlyMap<string, PartDoc>,
  opts: HeadlessAssemblyExportOptions,
): Promise<HeadlessAssemblyExport | null> {
  const session = createHeadlessAssembly({ doc, parts, ...(opts.files && { files: opts.files }) })
  const response = await session.solve()
  const state = assemblyState(doc, response, session.partOutcomes(), docHashesOf(parts))
  const { files, ...exportOpts } = opts
  const bytes = await exportAssemblyLocally(assemblySpecs(doc, parts, response.transforms), exportOpts, files)
  return {
    bytes,
    ok: bytes !== null
      && !solveFailed(response.status)
      && state.mates.length === 0
      && state.parts.length === 0,
    ...state,
  }
}
