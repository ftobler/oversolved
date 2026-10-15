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
import { solveLocally } from '@/kernel/solveLocally'
import { CommandRegistry } from '@/utils/core/commandSpec'
import type { CommandName } from '@/utils/core/commandNames'
import { PART_COMMAND_SPECS, getSketchState, type PartCommandContext } from '@/pages/commandEntries'
import { editorState } from '@/stores/editorState'
import { partSolvePayload, applySolveToDoc } from '@/drive/solveWriteBack'
import { journalSink, type CommandJournal } from '@/drive/journal'
import { runScript, type ScriptRunOutcome, type ScriptStep } from '@/drive/scriptRunner'

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
  idle(): Promise<void>
  run(steps: readonly ScriptStep[]): Promise<ScriptRunOutcome>
}

export function createHeadlessPart(opts: HeadlessPartOptions): HeadlessPart {
  const docId = opts.docId ?? 'headless'
  const docBox: { current: PartDoc | null } = { current: opts.doc }
  const solveResultsBox: { current: Record<string, SketchData> } = { current: {} }
  const dirtyFacts = { dirty: false, saves: 0, savedHash: null as number | null }

  const reSolve: ReSolveFn = async (doc, solveOpts?: SolveOptions) => {
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

  // Deterministic feature ids for command-driven adds; scripts that need exact
  // ids use explicit mutation steps instead.
  let featureCounter = 0
  const nextFeatureId = (kind: string): string => `${kind}_${++featureCounter}`

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
    addFeature: (kind, extra) => session.execute({
      type: `add_${kind}`,
      featureId: nextFeatureId(kind),
      label: `${kind} ${featureCounter}`,
      ...extra,
    } as Mutation),
    showMessage: (payload) => {
      console.error(`[drive] ${payload.title}: ${payload.message}`)
    },
  }

  const registry = new CommandRegistry<PartCommandContext>(() => context)
  for (const spec of PART_COMMAND_SPECS) registry.register(spec)

  const run = (steps: readonly ScriptStep[]): Promise<ScriptRunOutcome> =>
    runScript(
      steps,
      step => {
        if ('command' in step) return registry.execute(step.command as CommandName, step.params)
        return session.execute(step.mutation)
      },
      () => solve.idle(),
    )

  return {
    session,
    registry,
    solve,
    getDoc: () => docBox.current,
    idle: () => solve.idle(),
    run,
  }
}

// Re-exported so the CLI imports one module for the whole headless story.
export { applySolveToDoc, partSolvePayload } from '@/drive/solveWriteBack'
export { getCommandJournal } from '@/drive/journal'
