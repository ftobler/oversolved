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

import type { PartDoc, Mutation, SketchData, BodyResult } from '@/types/cad'
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
import { readSolveOutcomes, type FeatureOutcome } from '@/drive/featureOutcome'
import { featureFrames, type FeatureFrameMap, type FeatureFrameOptions } from '@/drive/featureFrames'
import { featureCurves, type FeatureCurveMap } from '@/drive/featureCurves'
import { authoredHashOf } from '@/drive/docHash'
import { seededIdSource, stepSeedFor } from '@/drive/seededIds'
import { resolveSelectionAids, usesSelectionAid } from '@/drive/selectionAids'
import { usesSettledSketchGeometry } from '@/drive/solveDependencies'
import { setIdSource } from '@/utils/yamlMutations'

export interface HeadlessPartOptions {
  doc: PartDoc
  // The solve cache key; stable per document so incremental rebuilds apply.
  docId?: string
  // When given, every session mutation is journaled into it (and `run` can
  // hand back a repro); otherwise the session runs without a sink.
  journal?: CommandJournal
  // The solve file map for documents with import_step: file_id -> STEP bytes.
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
  // the start of every run, so a refused-only script (no mutation landed, no
  // solve requested) is the one false case.
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
  // Per-feature volume and bbox of the last solve's checkpoints, in feature
  // order. Null when the last solve never produced a measurable state (no
  // kernel, or nothing solved yet).
  featureMeasures(): Promise<FeatureMeasure[] | null>
  idle(): Promise<void>
  run(steps: readonly ScriptStep[]): Promise<ScriptRunOutcome>
}

export function createHeadlessPart(opts: HeadlessPartOptions): HeadlessPart {
  const docId = opts.docId ?? 'headless'
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
  const solvedBox = { current: false }
  const dirtyFacts = { dirty: false, saves: 0, savedHash: null as number | null }

  const reSolve: ReSolveFn = async (doc, solveOpts?: SolveOptions) => {
    // Before the call, not after: a faulted or stalled solve still attempted an
    // answer for this document, and the cutoff decides whether the reply may
    // name the missing verdicts at all.
    solvedBox.current = true
    outcomesBox.current = {}
    // The body set belongs to the response being replaced: a faulted re-solve
    // must not leave the previous document's live set to be reported as this
    // one's.
    bodiesBox.current = null
    // A failed or faulted solve must not leave the previous response standing:
    // featureMeasures and featureFrames read it against the CURRENT document, so
    // pairing the old frames with a document edited since would report a plane
    // that solve never reached.
    responseBox.current = null
    const payload = partSolvePayload(doc, docId)
    const response = await solveLocally(payload, {
      rollbackPosition: payload.rollback_position,
      ...(opts.files ? { files: opts.files } : {}),
      ...(solveOpts?.bypassCache ? { bypassCache: true } : {}),
      ...(solveOpts?.validate ? { validate: true } : {}),
    })
    if (!response) throw new Error('Local solver unavailable (OCC.js failed to load)')
    // The same doc write-back the browser adapter applies: bake solved geometry
    // and reconcile part_style. The journal ignores it: its hashes were taken
    // synchronously around the apply, before this write-back landed.
    docBox.current = applySolveToDoc(doc, response)
    outcomesBox.current = readSolveOutcomes(response.result)
    responseBox.current = response
    // The live body set of this solve, recorded before any later feature or
    // write-back: this is what the reply summary reports, not the accumulated
    // part_style keys and not the render map (which drops a body whose
    // tessellation failed while the solve still holds it).
    bodiesBox.current = finalLiveBodyIds(response)
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
          const needsBodies = usesSelectionAid(step.mutation)
          if (needsBodies || usesSettledSketchGeometry(step.mutation)) {
            if (solve.owed()) {
              await solve.flush()
            } else if (needsBodies && responseBox.current === null) {
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
          const validated = validateMutation(resolved.mutation, { doc: docBox.current })
          if (!validated.ok) return { ok: false, code: validated.error.code, message: validated.error.message }
          return session.execute(validated.mutation)
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
      // is a no-op there and it stays unsolved.
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
