// The headless assembly session: one AssemblyDoc, one History, the real
// assembly command table and the Rust mate solver, with no browser stores.
//
// The browser editor's parts live in a workspace session and its bundles in
// IndexedDB; headlessly there is no workspace and no IndexedDB. The binding
// (`parts: doc_id -> PartDoc`) travels with the call, and the bundle memo below
// is the in-worker replacement for the cache: it dies with the worker, which is
// the point (D7).
//
// Solved poses are never written back into the document (D6): the reply carries
// `instances[].pose`, and the doc keeps its authored seeds. A bake-flagged
// operation still bakes the LAST solve's transforms, exactly as the editor
// does, because that is the operation's contract.

import type { AssemblyDoc, BodyResult, PartDoc, Transform3D } from '@/types/cad'
import { History } from '@/session/History'
import { okResult } from '@/session/result'
import { CommandRegistry } from '@/utils/core/commandSpec'
import type { CommandName } from '@/utils/core/commandNames'
import { ASSEMBLY_COMMAND_SPECS, type AssemblyCommandContext } from '@/pages/assemblyCommandEntries'
import {
  planAssemblyOperation,
  runAssemblyOperation,
  type AssemblyOperationHost,
  type AssemblyOperationId,
  type AssemblyOperationInputs,
} from '@/utils/assemblyOperations'
import { applyAssemblyEdit } from '@/utils/assemblyEdit'
import { ASSEMBLY_UNDO_LABELS, type AssemblyUndoLabel } from '@/utils/core/assemblyUndoLabels'
import { ASSEMBLY_BUILTIN_DEFAULTS } from '@/utils/assemblyBuiltins'
import { findInstance, findMate, partInstances, setInstanceFixedFromSolved } from '@/utils/assemblyMutations'
import { partSpecs, mateSpecs } from '@/utils/assemblySolveInput'
import { solveAssembly, type AssemblyBuildResponse } from '@/kernel/solveAssembly'
import { solveLocally } from '@/kernel/solveLocally'
import { toPartBundle, type Anchor, type PartBundle } from '@/kernel/partBundle'
import { markFeatureStart } from '@/kernel/featureProgress'
import { partSolvePayload } from '@/drive/solveWriteBack'
import { docHashOf } from '@/drive/docHash'
import { partBundleKey } from '@/workspace/contentHash'
import { CURRENT_DOC_VERSION } from '@/persistence/docSchema'
import { stepSeedFor, seededIdSource } from '@/drive/seededIds'
import { setIdSource } from '@/utils/yamlMutations'
import { runScript, type AnnotatedSuccess, type KeptPose, type MateCapture, type ScriptRunOutcome, type ScriptFailure } from '@/drive/scriptRunner'
import type { AssemblyWireMutation, PartPatternRequest } from '@/drive/assemblyMutationCatalog'
import { expandPartPattern } from '@/drive/assemblyPatternExpand'
import { captureMateAtSeeds, seedAnchorTable } from '@/drive/assemblyCapture'
import { featureProblems, readSolveOutcomes, type FeatureProblem } from '@/drive/featureOutcome'
import { validateAssemblyMutation } from '@/drive/assemblyMutationCatalog'
import { buildPartAnchorIndex, resolveDriveRef, type DriveMateRef, type PartAnchorIndex, type ResolvedDriveRef } from '@/drive/assemblyRefs'

/** The Rust mate solver entry point; null when the mate package is absent. */
export type MateSolveFn = (input: Uint8Array) => Uint8Array

// A module-level slot rather than a session option: the kernel worker boots
// once and every assembly session in it reads the same solver.
let mateSolver: MateSolveFn | null = null

export function setMateSolver(fn: MateSolveFn | null): void {
  mateSolver = fn
}

export function getMateSolver(): MateSolveFn | null {
  return mateSolver
}

/** A fresh assembly with its built-in origin and planes seeded, like the app's
 *  empty document after useAssemblyDoc prepends them. */
export function emptyDriveAssemblyDoc(): AssemblyDoc {
  return {
    version: CURRENT_DOC_VERSION,
    kind: 'assembly',
    features: ASSEMBLY_BUILTIN_DEFAULTS.map(feature => ({ ...feature })),
  }
}

export interface HeadlessAssemblyOptions {
  doc: AssemblyDoc
  // The binding: which part content each instance's doc_id means.
  parts: ReadonlyMap<string, PartDoc>
  // The solve file map for parts with import_step: file_id -> bytes.
  files?: ReadonlyMap<string, Uint8Array>
  /**
   * Test seam: produce a part's bundle without OCC, the way the browser relay
   * hands a pre-built one. Production leaves it undefined and every part builds
   * through solveLocally.
   */
  bundleSource?: (docId: string, partDoc: PartDoc) => Promise<InjectedBundle | null>
}

export interface InjectedBundle {
  bundle: PartBundle
  bodies: Record<string, BodyResult>
  features?: FeatureProblem[]
}

export interface PartOutcome {
  features: FeatureProblem[]
  error?: string
}

/** One assembly script step: a command id or one wire mutation. */
export type AssemblyScriptStep =
  | { command: string; params?: unknown; continueOnError?: boolean }
  | { mutation: AssemblyWireMutation; continueOnError?: boolean }

export interface HeadlessAssembly {
  getDoc(): AssemblyDoc
  history: History<AssemblyDoc>
  registry: CommandRegistry<AssemblyCommandContext>
  lastSolve(): AssemblyBuildResponse | null
  // The problems each bound part's build reported, keyed by doc_id. A part with
  // no entry was never built.
  partOutcomes(): Record<string, PartOutcome>
  solve(): Promise<AssemblyBuildResponse>
  run(steps: readonly AssemblyScriptStep[]): Promise<ScriptRunOutcome>
}

// The memo's capacity: a session's binding is small, and 32 is the same bound
// the doc store uses. A miss rebuilds through OCC, so a bounded LRU is the
// difference between one build per part and one per step.
const MEMO_CAPACITY = 32

interface BundleMemoEntry {
  bundle: PartBundle
  index: PartAnchorIndex
  outcome: PartOutcome
}

// One memo for the whole worker, not one per session: every MCP call builds a
// fresh session, and the key already folds the part content and the file ids,
// so a run -> measure -> run sequence reuses the builds instead of paying for
// them three times. The worker dying is what empties it (D7).
const bundleMemo = new Map<string, BundleMemoEntry>()

// The commands that only make sense against the editor UI. Each refusal names
// the mutation or tool to use instead, the way the part side refuses
// delete_selected.
const UI_ONLY_COMMANDS: Readonly<Record<string, string>> = {
  insert_part_instance: 'use an add_part mutation step',
  export_assembly: 'use the export tool',
  delete_selected: 'use delete_part or delete_mate',
  cancel_edit: 'there is no editor session headlessly',
}

function failure(code: string, message: string): ScriptFailure {
  return { ok: false, code, message }
}

function uiOnlyRefusal(command: string): ScriptFailure | null {
  if (command.startsWith('insert_mate_')) {
    return failure('unsupported', 'insert_mate_* opens an editor; use an add_mate mutation step instead')
  }
  const hint = UI_ONLY_COMMANDS[command]
  return hint === undefined ? null : failure('unsupported', `${command} is a UI command; ${hint}`)
}

export function createHeadlessAssembly(opts: HeadlessAssemblyOptions): HeadlessAssembly {
  const docBox: { current: AssemblyDoc } = { current: opts.doc }
  const history = new History<AssemblyDoc>({ cloneDoc: doc => structuredClone(doc), cap: 200 })
  const partOutcomes: Record<string, PartOutcome> = {}
  let last: AssemblyBuildResponse | null = null
  // The doc reference the last solve ran against. Solving does not change the
  // document (D6), so equality is the whole staleness test.
  let lastSolvedDoc: AssemblyDoc | null = null
  let needsSolve = false

  const filesKey = [...(opts.files?.keys() ?? [])].sort().join(',')

  function memoKey(partDoc: PartDoc): string {
    return partBundleKey(docHashOf(partDoc), [filesKey])
  }

  function remember(key: string, entry: BundleMemoEntry): BundleMemoEntry {
    bundleMemo.delete(key)
    bundleMemo.set(key, entry)
    while (bundleMemo.size > MEMO_CAPACITY) {
      const oldest = bundleMemo.keys().next()
      if (oldest.done) break
      bundleMemo.delete(oldest.value)
    }
    return entry
  }

  // Build one part's bundle through the real kernel and keep the byQuery index
  // beside it, so a mate ref resolve needs no second build. A build failure is
  // data: it is stored against the doc_id and the solve reports the part as
  // failed rather than blanking the whole reply.
  async function bundleFor(docId: string, partDoc: PartDoc): Promise<BundleMemoEntry> {
    const key = memoKey(partDoc)
    const cached = bundleMemo.get(key)
    if (cached) {
      bundleMemo.delete(key)
      bundleMemo.set(key, cached)
      // Two doc_ids may bind byte-identical content; the outcome belongs to
      // each of them, not only to the one that paid for the build.
      partOutcomes[docId] = cached.outcome
      return cached
    }
    const payload = partSolvePayload(partDoc, docId)
    // The stall budget names the part, not one of its features: a bundle build
    // that never returns is reported as `part <doc_id>`.
    markFeatureStart(`part ${docId}`)
    try {
      if (opts.bundleSource) {
        const injected = await opts.bundleSource(docId, partDoc)
        if (!injected) throw new Error('bundle source produced no bundle')
        const entry = remember(key, {
          bundle: injected.bundle,
          index: buildPartAnchorIndex(injected.bundle, injected.bodies),
          outcome: { features: injected.features ?? [] },
        })
        partOutcomes[docId] = entry.outcome
        return entry
      }
      const response = await solveLocally(payload, {
        rollbackPosition: payload.rollback_position,
        ...(opts.files ? { files: opts.files } : {}),
      })
      if (!response) throw new Error('local solver unavailable (OCC.js is not provisioned)')
      const bundle = toPartBundle(docId, docHashOf(partDoc), response.bodies as Record<string, BodyResult>)
      const entry = remember(key, {
        bundle,
        index: buildPartAnchorIndex(bundle, response.bodies as Record<string, BodyResult>),
        outcome: { features: featureProblems(partDoc, readSolveOutcomes(response.result)) },
      })
      partOutcomes[docId] = entry.outcome
      return entry
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      const entry: BundleMemoEntry = {
        bundle: { doc_id: docId, content_hash: '', schema: 0, bodies: [], anchors: {} },
        index: { anchors: {}, byQuery: new Map(), bodies: {} },
        outcome: { features: [], error: `bundle build failed: ${message}` },
      }
      partOutcomes[docId] = entry.outcome
      return remember(key, entry)
    }
  }

  function boundPart(docId: string): PartDoc {
    const part = opts.parts.get(docId)
    if (!part) {
      throw new Error(`part "${docId}" is not bound; bound parts: ${[...opts.parts.keys()].sort().join(', ') || 'none'}`)
    }
    return part
  }

  // Build every instance's part before a step validates its refs, so the
  // synchronous resolver has an index in hand. Memoized, so only the first step
  // pays.
  async function ensureBundles(): Promise<void> {
    for (const instance of partInstances(docBox.current)) {
      const part = opts.parts.get(instance.doc_id)
      if (!part) continue
      await bundleFor(instance.doc_id, part)
    }
  }

  function indexFor(handle: string): PartAnchorIndex | Error {
    const instance = partInstances(docBox.current).find(candidate => candidate.handle === handle)
    if (!instance) return new Error(`no instance "${handle}"`)
    const part = opts.parts.get(instance.doc_id)
    if (!part) return new Error(`part "${instance.doc_id}" is not bound`)
    const entry = bundleMemo.get(memoKey(part))
    if (!entry) return new Error(`part "${instance.doc_id}" has not been built`)
    if (entry.outcome.error !== undefined) return new Error(entry.outcome.error)
    return entry.index
  }

  function resolveRef(ref: DriveMateRef): ResolvedDriveRef {
    return resolveDriveRef(ref, docBox.current, indexFor)
  }

  // A part's local bundle anchors for the seed table, or nothing when its
  // build is unavailable: a ref into that part could not have resolved
  // either, so the capture reports nothing rather than a partial frame.
  function localAnchorsFor(handle: string): Readonly<Record<string, Anchor>> | undefined {
    const index = indexFor(handle)
    return index instanceof Error ? undefined : index.anchors
  }

  // Only the two mate-writing mutations take the flag, and only when it is
  // spelled true: capture stays opt-in, so a document authored headlessly
  // before this existed keeps its meaning.
  function captureRequested(mutation: AssemblyWireMutation): boolean {
    return (mutation.type === 'add_mate' || mutation.type === 'set_mate_ref') && mutation.capture === true
  }

  /**
   * The validated input with the captured orientation merged into its `patch`,
   * measured at the seeds the next solve starts from (the same table the
   * reply's mateFrames would carry, posed at the seeds instead of the solved
   * poses), plus the report for the step result. For set_mate_ref this step
   * writes one slot, so the mate's other slot is the second half of the pair;
   * an unfilled one captures nothing, and null leaves the input untouched.
   */
  function captureStep(
    mutation: AssemblyWireMutation,
    input: AssemblyOperationInputs[AssemblyOperationId],
  ): { input: AssemblyOperationInputs[AssemblyOperationId]; captured: MateCapture } | null {
    const anchors = seedAnchorTable(docBox.current, localAnchorsFor)
    if (mutation.type === 'add_mate') {
      const added = input as AssemblyOperationInputs['add_mate']
      if (!added.ref_a || !added.ref_b) return null
      const capture = captureMateAtSeeds({
        kind: added.kind,
        ref_a: added.ref_a,
        ref_b: added.ref_b,
        anchors,
        ...(added.patch !== undefined && { explicit: added.patch }),
      })
      // The capture owns flip/angle only: merge over the step's own patch so
      // the other authored params (offset, radius, ratio) survive, while the
      // patch's flip/angle stay the explicit-wins values capture computed.
      return capture === null ? null
        : { input: { ...added, patch: { ...added.patch, ...capture.patch } }, captured: capture.captured }
    }
    if (mutation.type !== 'set_mate_ref') return null
    const existing = findMate(docBox.current, mutation.featureId)
    if (!existing) return null
    const aimed = input as AssemblyOperationInputs['set_mate_ref']
    const capture = captureMateAtSeeds({
      kind: existing.kind,
      ref_a: mutation.field === 'ref_a' ? aimed.ref : existing.ref_a,
      ref_b: mutation.field === 'ref_b' ? aimed.ref : existing.ref_b,
      anchors,
    })
    // Same merge rule as add_mate: only flip/angle come from the capture.
    return capture === null ? null
      : { input: { ...aimed, patch: { ...aimed.patch, ...capture.patch } }, captured: capture.captured }
  }

  function solve(): Promise<AssemblyBuildResponse> {
    const doc = docBox.current
    const relay = {
      // The relay's spec is ignored: the binding is the one source of part
      // content, so the bundle key and the build use the same document.
      requestPartDoc: async (docId: string) => ({ ...boundPart(docId) }),
      requestBuildBundle: async (docId: string, _hash: string, _spec: Record<string, unknown>) => {
        return (await bundleFor(docId, boundPart(docId))).bundle
      },
    }
    return solveAssembly(partSpecs(doc), {}, mateSpecs(doc), relay, mateSolver).then((response) => {
      last = response
      lastSolvedDoc = docBox.current
      needsSolve = false
      return response
    })
  }

  function applyEdit(label: AssemblyUndoLabel, fn: (doc: AssemblyDoc) => AssemblyDoc): void {
    const current = docBox.current
    const next = fn(current)
    // Headless has no open editor session, so a fold cell lands as a push: the
    // same decision the editor makes with no editor open (D11).
    const outcome = applyAssemblyEdit(history, current, label, next, false)
    if (outcome.decision === 'noop' || !outcome.doc) return
    docBox.current = outcome.doc
  }

  function host(): AssemblyOperationHost {
    return {
      doc: docBox.current,
      transforms: last?.transforms ?? {},
      knownPartIds: new Set(opts.parts.keys()),
      mutateSession: applyEdit,
      mutateOneShot: applyEdit,
      requestSolve: () => { needsSolve = true },
      requestSolveOrDefer: () => { needsSolve = true },
    }
  }

  let mintedMates = 0
  const context: AssemblyCommandContext = {
    editor: 'assembly',
    runOperation: <K extends AssemblyOperationId>(id: K, payload: AssemblyOperationInputs[K]) => {
      runAssemblyOperation(id, payload, host())
    },
    undo: () => {
      const entry = history.undo(docBox.current)
      if (entry) docBox.current = entry.doc
      needsSolve = true
    },
    redo: () => {
      const entry = history.redo(docBox.current)
      if (entry) docBox.current = entry.doc
      needsSolve = true
    },
    deleteSelected: () => {},
    cancelEdit: () => {},
    openInsertPart: () => {},
    openExport: () => {},
    // Deterministic: a headless insert_mate_* is refused before it reaches the
    // registry, so this only ever feeds the catalog's enabled verdict.
    mintMateId: () => {
      mintedMates += 1
      return `mate_${mintedMates}`
    },
    closeOpenEditor: () => {},
    onMateInserted: () => {},
    deleteSubject: (subject) => {
      if (subject.kind === 'mate') runAssemblyOperation('delete_mate', subject.id, host())
      else runAssemblyOperation('delete_part', subject.handle, host())
    },
    manipulationLive: () => false,
    cancelManipulation: () => {},
    undoDepth: () => history.undoLength(),
    redoDepth: () => history.redoLength(),
  }

  const registry = new CommandRegistry<AssemblyCommandContext>(() => context)
  for (const spec of ASSEMBLY_COMMAND_SPECS) registry.register(spec)

  // One validated wire mutation against the live doc. `solveAfter: false` is
  // the pattern's inner loop, which solves once at the end instead of per copy.
  async function runMutation(
    mutation: AssemblyWireMutation,
    solveAfter: boolean,
  ): Promise<ScriptFailure | AnnotatedSuccess> {
    const validated = validateAssemblyMutation(mutation, {
      doc: docBox.current,
      boundPartIds: new Set(opts.parts.keys()),
      resolveRef,
    })
    if (!validated.ok) return failure(validated.error.code, validated.error.message)
    if ('macro' in validated) return runPartPattern(validated.pattern)
    needsSolve = false
    // Capture runs before the step writes anything: the seeds it measures
    // are the ones the solve below starts from. Its patch already lets an
    // explicit flip/angle in this same step win, and says which it beat.
    const capture = captureRequested(mutation) ? captureStep(mutation, validated.input) : null
    const input = capture === null ? validated.input : capture.input
    let poseKept: KeptPose | undefined
    if (mutation.type === 'set_part_fixed' && mutation.bake === false) {
      // The authored seed stays: only the flag is written, so a pose the
      // last solve diverged to never lands in the document. The editor
      // path keeps baking; this is the headless escape hatch for exactly
      // that case. Empty transforms route the flag through the guarded
      // setter (assemblyOperations' rationale for the editor cells): an
      // absent `fixed` means false, so re-setting an already-correct flag
      // is absorbed as a no-op instead of materializing a permanent
      // `fixed: false` key and charging a dead undo entry.
      const { handle, fixed } = mutation
      applyEdit(ASSEMBLY_UNDO_LABELS.fixUnfixPart, doc => setInstanceFixedFromSolved(doc, handle, fixed, {}))
      poseKept = 'seed'
    } else {
      runAssemblyOperation(validated.operation, input as never, host())
      // A toggle that runs before this session ever solved has no last
      // solve to bake, so the seed it reports keeping is still the
      // authored one; anything else took the bake path.
      if (mutation.type === 'set_part_fixed') poseKept = last === null ? 'seed' : 'solved'
    }
    if (needsSolve && solveAfter) await solve()
    return {
      ...okResult(),
      ...(capture !== null && { captured: capture.captured }),
      ...(poseKept !== undefined && { poseKept }),
    }
  }

  // A pattern is all or nothing: the copies and their mates are placed through
  // the ordinary add_part and add_mate paths, then folded into one undo entry.
  // A copy that fails restores the doc and the stack to before the step, so a
  // half-built ring never survives a refusal.
  async function runPartPattern(request: PartPatternRequest): Promise<ScriptFailure | AnnotatedSuccess> {
    const entry = await bundleFor(request.part, boundPart(request.part))
    if (entry.outcome.error !== undefined) {
      return failure('unresolved-ref', `could not build part "${request.part}": ${entry.outcome.error}`)
    }
    // add_part bakes the last solve into every non-fixed seed, so the pose the
    // holes sit at once the copies are in is the solved one, not the stale seed.
    const poseOf = (handle: string): Transform3D | undefined => {
      const instance = findInstance(docBox.current, handle)
      return instance?.fixed === true ? instance.transform : (last?.transforms[handle] ?? instance?.transform)
    }
    const expansion = expandPartPattern(request, { doc: docBox.current, indexFor, partIndex: entry.index, poseOf })
    if (!expansion.ok) return failure(expansion.code, expansion.message)
    const before = docBox.current
    const mark = history.mark()
    needsSolve = false
    for (const copy of expansion.copies) {
      runAssemblyOperation('add_part', {
        docId: request.part,
        docRev: 0,
        handle: copy.handle,
        featureId: copy.featureId,
        transform: copy.transform,
      }, host())
    }
    const captured: MateCapture[] = []
    for (const copy of expansion.copies) {
      const result = await runMutation(copy.mate, false)
      if (!result.ok) {
        docBox.current = before
        history.rollbackTo(mark)
        needsSolve = false
        return failure(result.code, `${copy.handle}: ${result.message}`)
      }
      if (result.captured !== undefined) captured.push(result.captured)
    }
    // One undo entry for the whole ring: restore the stacks, then push the
    // pre-pattern doc under the pattern's label.
    history.rollbackTo(mark)
    history.push(ASSEMBLY_UNDO_LABELS.addPartPattern, before)
    await solve()
    return {
      ...okResult(expansion.copies.flatMap(copy => [copy.featureId, copy.mate.featureId])),
      ...(captured.length > 0 && { captured: captured[0] }),
    }
  }

  const run = async (steps: readonly AssemblyScriptStep[]): Promise<ScriptRunOutcome> => {
    if (steps.length === 0) {
      await solve()
      return { ok: true, steps: [] }
    }
    const outcome = await runScript(
      steps,
      async (step) => {
        const seed = stepSeedFor(docHashOf(docBox.current), step)
        setIdSource(seededIdSource(seed))
        if ('command' in step) {
          const refusal = uiOnlyRefusal(step.command)
          if (refusal) return refusal
          needsSolve = false
          const result = registry.execute(step.command as CommandName, step.params)
          if (result.ok && needsSolve) await solve()
          return result
        }
        // A ref needs the part build, which is async: build every instance's
        // part first so the synchronous resolver has an index.
        await ensureBundles()
        return runMutation(step.mutation, true)
      },
    )
    // The run always ends with a solve of the final document, but a step that
    // just solved does not need a second identical solve (the doc did not move).
    if (last === null || lastSolvedDoc !== docBox.current) await solve()
    return outcome
  }

  return {
    getDoc: () => docBox.current,
    history,
    registry,
    lastSolve: () => last,
    partOutcomes: () => ({ ...partOutcomes }),
    solve,
    run,
  }
}

// Re-exported so the drive entry points import one module for the session story.
export { planAssemblyOperation }
