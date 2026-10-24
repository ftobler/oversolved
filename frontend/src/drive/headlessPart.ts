// The headless part session: one DocSession wired to the real in-process
// kernel, the part command table and (optionally) the mutation journal. The
// node CLI runs scripts and replays journals through this; one session per
// process is the v1 contract, because solveLocally's cross-solve checkpoint
// cache is single-writer module state (see the reentrancy guard there). Two
// sessions in one process would interleave their caches; split into two
// processes instead of isolating the globals.

import type { PartDoc, Mutation, SketchData } from '@/types/cad'
import { createDocSession, type DocSession } from '@/session/DocSession'
import type { SolveOptions, SolveScheduler } from '@/session/SolveScheduler'
import { cloneDocForUndo } from '@/utils/yamlMutations/undoSnapshot'
import { createWorkerSolveScheduler, type ReSolveFn } from '@/hooks/workerSolveScheduler'
import { measureSolveFeatures, solveLocally, type FeatureMeasure } from '@/kernel/solveLocally'
import { CommandRegistry } from '@/utils/core/commandSpec'
import type { CommandName } from '@/utils/core/commandNames'
import { PART_COMMAND_SPECS, getSketchState, type PartCommandContext } from '@/pages/commandEntries'
import { editorState } from '@/stores/editorState'
import { partSolvePayload, applySolveToDoc } from '@/drive/solveWriteBack'
import { journalSink, type CommandJournal } from '@/drive/journal'
import { runScript, type ScriptRunOutcome, type ScriptStep } from '@/drive/scriptRunner'
import { validateMutation } from '@/drive/mutationCatalog'
import { readSolveOutcomes, type FeatureOutcome } from '@/drive/featureOutcome'
import { featureFrames, type FeatureFrameMap } from '@/drive/featureFrames'
import { docHashOf } from '@/drive/docHash'
import { seededIdSource, stepSeedFor } from '@/drive/seededIds'
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
}

export interface HeadlessPart {
  session: DocSession
  registry: CommandRegistry<PartCommandContext>
  solve: SolveScheduler<PartDoc>
  getDoc(): PartDoc | null
  // The body ids the last solve left live, in solve order; null until a solve
  // has run (an empty script has no live set of its own to report). The
  // document itself cannot answer this: part_style keeps an entry for a body a
  // boolean or join consumed (it only reconciles new ids in), so a summary
  // built from it lists dead bodies.
  bodyIds(): readonly string[] | null
  // The per-feature outcome of the last settle (status plus the kernel's own
  // exception/warning text). The CLI and MCP report every problem in here.
  solveOutcomes(): Record<string, FeatureOutcome>
  // The resolved frame of every sketch and plane feature in the last solve,
  // keyed by feature id. Null when no solve has run yet.
  featureFrames(): FeatureFrameMap | null
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
  const dirtyFacts = { dirty: false, saves: 0, savedHash: null as number | null }

  const reSolve: ReSolveFn = async (doc, solveOpts?: SolveOptions) => {
    outcomesBox.current = {}
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
    // part_style keys.
    bodiesBox.current = Object.keys(response.bodies ?? {})
  }

  const solve = createWorkerSolveScheduler(() => reSolve)

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
    if (steps.length === 0) {
      // An empty script is the "inspect this document" call: without a request
      // the reply carried generation 0 and no verdicts, so a passed document
      // was never actually solved.
      session.refreshSolve()
      await solve.idle()
      return { ok: true, steps: [] }
    }
    return runScript(
      steps,
      step => {
        // Seed each step from the settled document before it and the step
        // itself, and install the source before any handler runs, so internal
        // mints (add_rect, add_ngon, constraint ids) and every apply a command
        // dispatches follow the step. A journal records the seed; without one
        // the headless session still mints deterministically.
        const seed = stepSeedFor(docHashOf(docBox.current), step)
        if (opts.journal) opts.journal.beginStep(seed)
        else setIdSource(seededIdSource(seed))
        if ('command' in step) return registry.execute(step.command as CommandName, step.params)
        // The script carries untyped JSON; validate before the cast so a typo
        // is a named step failure and the doc stays as it was. The live doc lets
        // the value rules refuse a duplicate id or a delete target that names
        // nothing instead of reporting an ok that changed nothing.
        const validated = validateMutation(step.mutation, { doc: docBox.current })
        if (!validated.ok) return { ok: false, code: validated.error.code, message: validated.error.message }
        return session.execute(validated.mutation)
      },
      () => solve.idle(),
    )
  }

  return {
    session,
    registry,
    solve,
    getDoc: () => docBox.current,
    bodyIds: () => bodiesBox.current,
    solveOutcomes: () => outcomesBox.current,
    featureFrames: () => responseBox.current === null
      ? null
      : featureFrames(docBox.current, responseBox.current.result),
    // Derived rather than stored: the status view and the outcome view cannot
    // disagree about which features the last settle reached.
    solveStatuses: () => Object.fromEntries(
      Object.entries(outcomesBox.current).map(([id, outcome]) => [id, outcome.status]),
    ),
    featureMeasures: () => responseBox.current === null
      ? Promise.resolve(null)
      : measureSolveFeatures(responseBox.current),
    idle: () => solve.idle(),
    run,
  }
}

// Re-exported so the CLI imports one module for the whole headless story.
export { applySolveToDoc, partSolvePayload } from '@/drive/solveWriteBack'
export { getCommandJournal } from '@/drive/journal'
