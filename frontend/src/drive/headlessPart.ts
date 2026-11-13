// The headless part session: one DocSession wired to the real in-process
// kernel, the part command table and (optionally) the mutation journal. The
// node CLI runs scripts and replays journals through this; one session per
// process is the v1 contract, because solveLocally's cross-solve checkpoint
// cache is single-writer module state (see the reentrancy guard there). Two
// sessions in one process would interleave their caches; split into two
// processes instead of isolating the globals.
//
// A `run` defers its solves: every mutation requests one through the deferred
// scheduler, and the run spends it at the flush points (a selector step, a
// command step, the end) instead of after every step. The browser adapter keeps
// its immediate scheduler; only this drive surface wraps one.

import type { PartDoc, Mutation, SketchData, BodyResult, BuildResponse } from '@/types/cad'
import {
  faceBoundaryFromBodies, freezeRowsForDelete, isFaceProjectionSource,
  projectionNotFrozenMessage, projectionsFreezingNothing,
  type FaceBoundaryBodyLike, type ProjectionMemberEntity,
} from '@/kernel/features/projectionMembers'
import { createDocSession, type DocSession } from '@/session/DocSession'
import type { SolveOptions, SolveSchedulerState } from '@/session/SolveScheduler'
import { cloneDocForUndo } from '@/utils/yamlMutations/undoSnapshot'
import { createWorkerSolveScheduler, type ReSolveFn } from '@/hooks/workerSolveScheduler'
import { createDeferredSolveScheduler, type DeferredSolveScheduler } from '@/drive/deferredSolveScheduler'
import { finalLiveBodyIds, measureSolveFeatures, solveLocally, type FeatureMeasure } from '@/kernel/solveLocally'
import { CommandRegistry } from '@/utils/core/commandSpec'
import type { CommandName } from '@/utils/core/commandNames'
import { PART_COMMAND_SPECS, getSketchState, type PartCommandContext } from '@/pages/commandEntries'
import { editorState } from '@/stores/editorState'
import { partSolvePayload, applySolveToDoc } from '@/drive/solveWriteBack'
import { journalSink, type CommandJournal } from '@/drive/journal'
import { runScript, type ScriptRunOutcome, type ScriptStep, type ScriptStepOutcome } from '@/drive/scriptRunner'
import { validateMutation } from '@/drive/mutationCatalog'
import { readSolveOutcomes, type FeatureNote, type FeatureOutcome } from '@/drive/featureOutcome'
import { featureFrames, type FeatureFrameMap, type FeatureFrameOptions } from '@/drive/featureFrames'
import { featureCurves, type FeatureCurveMap } from '@/drive/featureCurves'
import { authoredHashOf } from '@/drive/docHash'
import { seededIdSource, stepSeedFor } from '@/drive/seededIds'
import { resolveSelectionAids, usesSelectionAid } from '@/drive/selectionAids'
import { usesSettledSketchGeometry } from '@/drive/solveDependencies'
import { DxfImportError, dxfImportReply, parseDxfProfile, type DxfImportReply, type DxfProfile } from '@/utils/dxfImport'
import { lengthUnitOf } from '@/utils/lengthUnit'
import { setIdSource } from '@/utils/yamlMutations'

/** The most solves one headless flush may spend on the settle: the first on the
 *  requested document, then one per pass whose write-back installed fresh
 *  sketch geometry. The write-back now keeps a move only when it is at least
 *  half a storage step (the solver's own report), so an underconstrained sketch
 *  whose stored seed is a few grid steps off its solve advances by one step per
 *  pass instead of being swallowed whole by a float envelope; the closed outline
 *  fixture needs five. A cap hit is a precision caveat reported as a note,
 *  never a failed step. */
export const SETTLE_PASSES = 5

export interface HeadlessPartOptions {
  doc: PartDoc
  // The solve cache key; stable per document so incremental rebuilds apply.
  docId?: string
  // When given, every session mutation is journaled into it (and `run` can
  // hand back a repro); otherwise the session runs without a sink.
  journal?: CommandJournal
  // The solve file map for documents with import_step (file_id -> STEP bytes),
  // and the ids an import_dxf `file` step may name (file id -> DXF text).
  // Read-only for the session's lifetime, like the browser's file registry
  // snapshot is for one solve.
  files?: ReadonlyMap<string, Uint8Array>
  // Called after every settled step with the state that step left behind. A
  // worker host forwards this as a checkpoint: a solve that stalls in the next
  // step is terminated with the state in hand, so the accepted prefix is
  // reported instead of lost.
  onStepSettled?: (checkpoint: HeadlessCheckpoint) => void
}

/** The state one step left, the unit a stalled solve can report. The solve may
 *  still be owed (a deferred run flushes at the end), so `bodies` and `solve`
 *  describe the last flush and only the document and outcomes are this step's. */
export interface HeadlessCheckpoint {
  doc: PartDoc
  // The live body ids of the last settle, before the next step's solve.
  bodies: readonly string[] | null
  solve: SolveSchedulerState
  // The step outcomes recorded so far, the refused tail included.
  steps: readonly ScriptStepOutcome[]
}

/**
 * Turn an `import_dxf` step into the mutation the session applies: a `file` id
 * becomes the text it names, and either spelling is parsed with its layer
 * filter so a bad file or an unknown layer is a named step failure with the
 * document untouched. The mutation the session applies carries `content`, never
 * `file`: undo and journal replay then need no file map. The parse also yields
 * the layer rows the step replies with.
 */
function resolveDxfFile(
  mutation: Mutation,
  files: ReadonlyMap<string, Uint8Array> | undefined,
  doc: PartDoc | null,
): { ok: true; mutation: Mutation; reply: DxfImportReply | null } | { ok: false; code: string; message: string } {
  if (mutation.type !== 'import_dxf') return { ok: true, mutation, reply: null }
  const fileId = mutation.file
  let content = mutation.content ?? ''
  if (fileId !== undefined) {
    const bytes = files?.get(fileId)
    if (bytes === undefined) {
      const available = [...(files?.keys() ?? [])].sort()
      return {
        ok: false,
        code: 'unknown-target',
        message: `file ${JSON.stringify(fileId)} is not in this call's files map; available: `
          + `${available.join(', ') || 'none'}. Pass its bytes with the run call's \`files\` argument.`,
      }
    }
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      return {
        ok: false,
        code: 'invalid-mutation',
        message: `file ${JSON.stringify(fileId)} is not UTF-8 text; a DXF profile must be UTF-8 encoded`,
      }
    }
  }
  let profile: DxfProfile
  try {
    profile = parseDxfProfile(content, lengthUnitOf(doc?.length_unit), {
      layers: mutation.layers,
    })
  } catch (e) {
    if (e instanceof DxfImportError) return { ok: false, code: 'invalid-mutation', message: e.message }
    throw e
  }
  const { file: _file, ...rest } = mutation
  return { ok: true, mutation: { ...rest, content }, reply: dxfImportReply(profile) }
}

export interface HeadlessPart {
  session: DocSession
  registry: CommandRegistry<PartCommandContext>
  // Deferred for the run: `request` records the solve owed, `flush` spends it.
  solve: DeferredSolveScheduler<PartDoc>
  getDoc(): PartDoc | null
  // The body ids the last solve holds with a shape, from its last feature
  // checkpoint's body store, in solve order; null until a solve has run (an
  // empty script has no live set of its own to report). Not the response's
  // render map: a body whose tessellation failed is still solved and measured,
  // and the two replies must name the same live set. The document itself cannot
  // answer this either: part_style keeps an entry for a body a boolean or join
  // consumed (it only reconciles new ids in), so a summary built from it lists
  // dead bodies.
  bodyIds(): readonly string[] | null
  // The per-feature outcome of the last settle (status plus the kernel's own
  // exception/warning text). The CLI and MCP report every problem in here.
  solveOutcomes(): Record<string, FeatureOutcome>
  // Whether a settle was attempted for the document this session now holds.
  // Set when reSolve is entered, not when it completes: a faulted settle still
  // answered nothing for its features, which is a problem to report. Reset at
  // the start of every run; a refused-only run leaves it false, because the run
  // loop itself never forces a solve (runHeadless asks for the input document's
  // verdict after such a script).
  solveAttempted(): boolean
  // The resolved frame of every sketch and plane feature in the last solve,
  // keyed by feature id. Null when no solve has run yet. The options filter the
  // map the way a run reply does; without them every resolved frame is listed.
  featureFrames(opts?: FeatureFrameOptions): FeatureFrameMap | null
  // The resolved start, end and climb axis of every helix, keyed by feature id.
  // Null when the last settle produced no response (no kernel).
  featureCurves(): FeatureCurveMap | null
  // The status-only view of solveOutcomes, for the repro test's sidecar
  // expectations.
  solveStatuses(): Record<string, string>
  // A note to add to the reply when the last solve never settled: the sketches
  // whose write-back kept moving through the pass cap. Null when the last solve
  // settled (the normal case) or no solve ran.
  settleNote(): FeatureNote | null
  // Per-feature volume and bbox of the last solve's checkpoints, in feature
  // order. Null when the last solve never produced a measurable state (no
  // kernel, or nothing solved yet).
  featureMeasures(): Promise<FeatureMeasure[] | null>
  idle(): Promise<void>
  run(steps: readonly ScriptStep[]): Promise<ScriptRunOutcome>
}

/** A face projection is the one add whose input lives in the last solved body. */
function isFaceProjectionStep(mutation: unknown): boolean {
  if (typeof mutation !== 'object' || mutation === null) return false
  const step = mutation as { type?: unknown; source?: unknown }
  return step.type === 'add_projected_entity'
    && typeof step.source === 'string'
    && isFaceProjectionSource(step.source)
}


/** Fill a drive `delete` of a face projection with the member rows the last
 *  solve derived, the headless twin of the editor's freeze payload. Without it a
 *  script that deletes the constraint silently discards the wire. */
function withProjectionFreeze(
  mutation: Mutation,
  doc: PartDoc | null,
  result: BuildResponse['result'] | undefined,
): { mutation: Mutation; frozenNothing?: string[] } {
  if (mutation.type !== 'delete' || mutation.materialize !== undefined || doc === null) {
    // An explicit payload wins: a caller (or a recorded journal entry) that
    // already says what to materialize owns those bytes.
    return { mutation }
  }
  const features = new Set<string>()
  for (const target of mutation.targets) {
    if (!target.startsWith('constraint:')) continue
    const parts = target.split(':')
    if (parts[1] !== undefined && parts[2] !== undefined) features.add(parts[1])
  }
  const rows: ProjectionMemberEntity[] = []
  const empty: string[] = []
  for (const featureId of features) {
    const feature = (doc.features ?? []).find(candidate => candidate.id === featureId)
    if (feature?.kind !== 'sketch') continue
    const reports = (result?.[featureId] as {
      projection_members?: Record<string, { entities: ProjectionMemberEntity[]; orphans?: string[] }>
    } | undefined)?.projection_members
    const found = freezeRowsForDelete(featureId, feature, mutation.targets, reports)
    if (found !== undefined) rows.push(...found)
    empty.push(...projectionsFreezingNothing(featureId, feature, mutation.targets, reports))
  }
  const frozen = rows.length > 0 ? { ...mutation, materialize: rows } : mutation
  return empty.length > 0 ? { mutation: frozen, frozenNothing: empty } : { mutation: frozen }
}

export function createHeadlessPart(opts: HeadlessPartOptions): HeadlessPart {
  const docId = opts.docId ?? 'headless'
  // The ids this call's files map supplies, fixed for the session's lifetime
  // like the bytes themselves: an import_dxf `file` step may only name one.
  const fileIds = opts.files === undefined ? null : new Set(opts.files.keys())
  const docBox: { current: PartDoc | null } = { current: opts.doc }
  const solveResultsBox: { current: Record<string, SketchData> } = { current: {} }
  // What the last settle published per feature, by id: the browser adapter
  // fills the session's SketchData map here, and headlessly the kernel's own
  // answer is what a caller checking a document against the user's view needs,
  // so it is kept whole instead of reduced to a result object. Cleared before
  // each solve so a failed rebuild cannot leave the previous outcome standing
  // as if it described the current document.
  const outcomesBox: { current: Record<string, FeatureOutcome> } = { current: {} }
  const bodiesBox: { current: string[] | null } = { current: null }
  const responseBox: { current: Awaited<ReturnType<typeof solveLocally>> } = { current: null }
  const settleNoteBox: { current: FeatureNote | null } = { current: null }
  const solvedBox = { current: false }
  const dirtyFacts = { dirty: false, saves: 0, savedHash: null as number | null }

  const reSolve: ReSolveFn = async (doc, solveOpts?: SolveOptions) => {
    // Before the call, not after: a faulted or stalled solve still attempted an
    // answer for this document, and the cutoff decides whether the reply may
    // name the missing verdicts at all.
    solvedBox.current = true
    outcomesBox.current = {}
    settleNoteBox.current = null
    // The body set belongs to the response being replaced: a faulted re-solve
    // must not leave the previous document's live set to be reported as this
    // one's.
    bodiesBox.current = null
    // A failed or faulted solve must not leave the previous response standing:
    // featureMeasures and featureFrames read it against the CURRENT document, so
    // pairing the old frames with a document edited since would report a plane
    // that solve never reached.
    responseBox.current = null
    // The reply must describe the document its docHash names, and the write-back
    // can install the solve rounded to the 1e-6 document grid. A sketch solved
    // from that stored seed can land elsewhere (underconstrained, it keeps the
    // grid offset), so the first pass's numbers would describe a document that
    // no longer exists. Settle: solve, write back, and while the write-back
    // installed fresh sketch geometry, solve the written document again. The
    // passes are one scheduler request, so the kernel worker's stall budget
    // covers them exactly as it covers a single solve: a stall is reported by
    // the host as a solve-timeout with the last settled-step checkpoint, not as
    // a refused step. Only the last pass is published.
    let current = doc
    let response: NonNullable<Awaited<ReturnType<typeof solveLocally>>> | null = null
    let stillMoving: string[] = []
    for (let pass = 0; pass < SETTLE_PASSES; pass++) {
      const payload = partSolvePayload(current, docId)
      const solved = await solveLocally(payload, {
        rollbackPosition: payload.rollback_position,
        ...(opts.files ? { files: opts.files } : {}),
        // Only the first pass discards the cache; every settle pass is the
        // incremental build the moved sketch triggers, restoring everything
        // upstream of it from the checkpoint.
        ...(pass === 0 && solveOpts?.bypassCache ? { bypassCache: true } : {}),
        ...(solveOpts?.validate ? { validate: true } : {}),
      })
      if (!solved) throw new Error('Local solver unavailable (OCC.js failed to load)')
      response = solved
      // The same write-back the browser adapter applies: bake solved geometry
      // and reconcile part_style. The journal ignores it: its hashes were taken
      // synchronously around the apply, before this write-back landed.
      const written = applySolveToDoc(current, solved)
      current = written.doc
      stillMoving = written.movedFeatureIds
      if (!written.geometryMoved) break
    }
    if (response === null) throw new Error('Local solver unavailable (OCC.js failed to load)')
    docBox.current = current
    outcomesBox.current = readSolveOutcomes(response.result)
    responseBox.current = response
    // The live body set of this solve, recorded before any later feature or
    // write-back: this is what the reply summary reports, not the accumulated
    // part_style keys and not the render map (which drops a body whose
    // tessellation failed while the solve still holds it).
    bodiesBox.current = finalLiveBodyIds(response)
    if (stillMoving.length > 0) {
      // The cap was hit with the write-back still installing geometry. Report
      // the sketches in feature order; the note alone acknowledges the gap.
      const order = new Map((current.features ?? []).map((feature, index) => [feature.id, index]))
      settleNoteBox.current = {
        ids: [...stillMoving].sort((a, b) => (order.get(a) ?? -1) - (order.get(b) ?? -1)),
        text: `solved sketch geometry did not settle on the document grid after ${SETTLE_PASSES} passes; `
          + 'this reply may differ from a re-solve of its docHash at the 1e-6 level',
      }
    }
  }

  const solve = createDeferredSolveScheduler(createWorkerSolveScheduler(() => reSolve))

  const session = createDocSession({
    cloneDoc: cloneDocForUndo,
    doc: {
      get: () => docBox.current,
      set: next => { docBox.current = next },
    },
    solve,
    solveResults: {
      get: () => solveResultsBox.current,
      set: next => { solveResultsBox.current = next },
    },
    editorFacts: () => {
      const state = editorState.getState()
      return { editingFeatureId: state.editingFeatureId, rollbackPosition: state.rollbackPosition }
    },
    dirtyFacts: () => dirtyFacts,
    docId,
    // A face projection is added with the members the last solve derived from
    // the solved bodies; the headless host answers from its own response box.
    projectionBoundary: faceBoundaryFromBodies(
      () => responseBox.current?.bodies as Record<string, FaceBoundaryBodyLike> | undefined,
    ),
    ...(opts.journal && { journal: journalSink(opts.journal) }),
  })

  // Command-driven adds take the first free `${kind}_<n>` in the live document,
  // not a counter that restarts with each `run` call: a script split across
  // calls can then never mint `extrude_1` twice. Scripts that need exact ids
  // use explicit mutation steps instead.
  const nextFeatureId = (kind: string): { id: string; label: string } => {
    const held = new Set((docBox.current?.features ?? []).map(f => f.id))
    let n = 1
    while (held.has(`${kind}_${n}`)) n++
    return { id: `${kind}_${n}`, label: `${kind} ${n}` }
  }

  const context: PartCommandContext = {
    editor: 'part',
    session,
    state: getSketchState,
    undo: () => { session.undo() },
    redo: () => { session.redo() },
    deleteSelectedFeatures: () => {
      // The page handler folds a mixed sketch and 3D selection through several
      // stores; v1 has no headless equivalent, so it refuses rather than
      // silently reporting an ok that deleted nothing.
      return { ok: false, code: 'unsupported', message: 'delete_selected is not supported headlessly yet; use mutation steps' }
    },
    toggleSketchPlaneVisibility: () => { session.execute({ type: 'toggle_sketch_plane_visibility' }) },
    togglePlaneVisibility: () => { session.execute({ type: 'toggle_plane_visibility' }) },
    addFeature: (kind, extra) => {
      const next = nextFeatureId(kind)
      return session.execute({
        type: `add_${kind}`,
        featureId: next.id,
        label: next.label,
        ...extra,
      } as Mutation)
    },
    showMessage: (payload) => {
      console.error(`[drive] ${payload.title}: ${payload.message}`)
    },
  }

  const registry = new CommandRegistry<PartCommandContext>(() => context)
  for (const spec of PART_COMMAND_SPECS) registry.register(spec)

  const run = async (steps: readonly ScriptStep[]): Promise<ScriptRunOutcome> => {
    // This call's own answer, not the session's history: a previous call that
    // solved must not make a refused-only script look solved.
    solvedBox.current = false
    if (steps.length === 0) {
      // An empty script is the "inspect this document" call: without a request
      // the reply carried generation 0 and no verdicts, so a passed document
      // was never actually solved. `refreshSolve` queues it and `flush` spends
      // it through the base scheduler.
      session.refreshSolve()
      await solve.flush()
      return { ok: true, steps: [] }
    }
    try {
      return await runScript(
        steps,
        async step => {
          // Seed each step from the authored document before it and the step
          // itself, and install the source before any handler runs, so internal
          // mints (add_rect, add_ngon, constraint ids) and every apply a command
          // dispatches follow the step. The authored hash ignores the solve
          // write-back, so the seed cannot tell a deferred document from a
          // settled one: the same step mints the same ids under any chunking.
          const seed = stepSeedFor(authoredHashOf(docBox.current ?? opts.doc), step)
          if (opts.journal) opts.journal.beginStep(seed)
          else setIdSource(seededIdSource(seed))
          if ('command' in step) {
            // A command is registry code, not a validated mutation: it may read
            // solved bodies or ask for a solve itself, so it starts from the
            // settled document. Narrowing this needs a test per command family.
            if (solve.owed()) await solve.flush()
            return registry.execute(step.command as CommandName, step.params)
          }
          // A selector pick names geometry the last solve produced, and some
          // mutation handlers read the solved `initial` (a mirror, an offset, a
          // relative move, a dock). Both resolve against the settled document:
          // a solve still owed is spent first, and a run that starts from an
          // unsolved document (a fresh doc, or a chained docHash whose reply
          // carried no bodies) solves once before its first selector step.
          let bodies = responseBox.current?.bodies as Record<string, BodyResult> | undefined
          // A face projection needs the last solve's body mesh to derive its
          // member ids, exactly like a selector pick needs it to resolve. A
          // delete of one needs the settled face too, so its freeze rows are
          // the current members, not the previous solve's.
          const needsBodies = usesSelectionAid(step.mutation) || isFaceProjectionStep(step.mutation)
          const needsSettled = usesSettledSketchGeometry(step.mutation, docBox.current)
          if (needsBodies || needsSettled) {
            if (solve.owed()) {
              await solve.flush()
            } else if ((needsBodies || needsSettled) && responseBox.current === null) {
              session.refreshSolve()
              await solve.flush()
            }
            bodies = responseBox.current?.bodies as Record<string, BodyResult> | undefined
          }
          const resolved = resolveSelectionAids(step.mutation, bodies ?? null)
          if (!resolved.ok) return { ok: false, code: resolved.code, message: resolved.message }
          // The script carries untyped JSON; validate before the cast so a typo
          // is a named step failure and the doc stays as it was. The live doc lets
          // the value rules refuse a duplicate id or a delete target that names
          // nothing instead of reporting an ok that changed nothing.
          const validated = validateMutation(resolved.mutation, { doc: docBox.current, fileIds })
          if (!validated.ok) return { ok: false, code: validated.error.code, message: validated.error.message }
          // A `file` is resolved after the boundary checked the id against this
          // call's map, and before the session: the journal and undo see the same
          // content an inline step would have carried. The same parse supplies
          // the layer rows the step reply reports.
          const importable = resolveDxfFile(validated.mutation, opts.files, docBox.current)
          if (!importable.ok) return { ok: false, code: importable.code, message: importable.message }
          const frozen = withProjectionFreeze(importable.mutation, docBox.current, responseBox.current?.result)
          const applied = session.execute(frozen.mutation)
          const noted = frozen.frozenNothing !== undefined && applied.ok
            ? { ...applied, note: projectionNotFrozenMessage(frozen.frozenNothing) }
            : applied
          // A refused filter is a no-op: the step says no-change instead of
          // reporting layer rows for an import that did not happen.
          return importable.reply !== null && noted.ok && noted.noOp !== true
            ? { ...noted, ...importable.reply }
            : noted
        },
        async (outcomes: readonly ScriptStepOutcome[]) => {
          // A deferred request is not pending yet, so this only drains a solve
          // the step flushed itself; the checkpoint describes the document the
          // step left, and a stall in the next step reports that prefix.
          await solve.idle()
          const doc = docBox.current
          if (doc === null) return
          opts.onStepSettled?.({
            doc,
            bodies: bodiesBox.current,
            solve: solve.state(),
            // A snapshot: the runner keeps pushing onto its own array, and a
            // consumer that holds this checkpoint must not see later steps.
            steps: [...outcomes],
          })
        },
      )
    } finally {
      // Every reply is built from a settled document; a solve still owed would
      // report the authored state. A refused-only script owes nothing, so this
      // is a no-op there; the run caller decides whether to ask for the input
      // document's verdict (runHeadless does).
      if (solve.owed()) await solve.flush()
    }
  }

  return {
    session,
    registry,
    solve,
    getDoc: () => docBox.current,
    bodyIds: () => bodiesBox.current,
    solveOutcomes: () => outcomesBox.current,
    solveAttempted: () => solvedBox.current,
    featureFrames: opts => responseBox.current === null
      ? null
      : featureFrames(docBox.current, responseBox.current.result, opts),
    featureCurves: () => responseBox.current === null
      ? null
      : featureCurves(docBox.current, responseBox.current.result),
    // Derived rather than stored: the status view and the outcome view cannot
    // disagree about which features the last settle reached.
    solveStatuses: () => Object.fromEntries(
      Object.entries(outcomesBox.current).map(([id, outcome]) => [id, outcome.status]),
    ),
    settleNote: () => settleNoteBox.current,
    featureMeasures: () => responseBox.current === null
      ? Promise.resolve(null)
      : measureSolveFeatures(responseBox.current),
    // The headless settle: replay calls this between entries and expects the
    // document baked for the next one, so it spends an owed solve first. The
    // run loop awaits `solve.idle` directly and keeps its deferral.
    idle: async () => {
      await solve.flush()
      await solve.idle()
    },
    run,
  }
}

// Re-exported so the CLI imports one module for the whole headless story.
export { applySolveToDoc, partSolvePayload } from '@/drive/solveWriteBack'
export { getCommandJournal } from '@/drive/journal'
