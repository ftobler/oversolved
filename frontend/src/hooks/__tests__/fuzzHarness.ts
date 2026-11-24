// The seeded fuzz driver for the session/history ratchet. It owns the PRNG,
// the sequence generator over the frozen mutation registry, the start document
// and the replay loop whose invariants are the ratchet's teeth: after every
// step the document is well formed and JSON-serializable, the session is idle,
// no solve crashed and history stays within its cap; at the end undo-all and
// redo-all have to replay the exact timeline the steps describe. No production
// module imports this file.
//
// The mutation handlers are the real ones: the driver feeds concrete
// MutationExample mutations through DocSession.execute, never a handler stub.
import { isDeepStrictEqual } from 'node:util'
import type { PartDoc, Mutation, PartFeature, SketchData } from '@/types/cad'
import { createDocSession, type EditorFacts } from '@/session/DocSession'
import type { SolveScheduler } from '@/session/SolveScheduler'
import type { DirtyFacts } from '@/session/dirty'
import { MAX_UNDO_DEPTH } from '@/config/undoConfig'
import { MutationRefusal } from '@/utils/yamlMutations/helpers'
import { MUTATION_EXAMPLES } from './mutationExamples'
import { makeDoc } from '@/utils/core/testFixture'
import { makePrng } from '@/utils/core/prng'

export type FuzzStep =
  | { kind: 'mutation'; type: Mutation['type'] }
  | { kind: 'undo' }
  | { kind: 'redo' }
  // An unsuppressed sketch session. Production enters one per sketch edit, so
  // its per-action entries and its floor are the real user-facing undo shape.
  | { kind: 'sessionOpen'; featureId: string }
  | { kind: 'sessionCommit' }
  | { kind: 'sessionCancel' }

// The draw order is the registry's declaration order. Nothing freezes that
// order, so reordering the registry re-rolls every seed and a pinned regression
// seed stops replaying its sequence: treat a reorder as a fuzz-data change.
export const MUTATION_TYPES = Object.keys(MUTATION_EXAMPLES) as Mutation['type'][]

// Roughly 30% of the steps are history moves: one draw picks the step kind,
// and a mutation step spends a second draw on the type. The generator is a
// pure function of the seed, which is what makes a failing seed replayable.
export function generateSequence(seed: number, length: number): FuzzStep[] {
  const rnd = makePrng(seed)
  const steps: FuzzStep[] = []
  for (let i = 0; i < length; i++) {
    const roll = rnd()
    if (roll < 0.15) {
      steps.push({ kind: 'undo' })
    } else if (roll < 0.3) {
      steps.push({ kind: 'redo' })
    } else {
      const index = Math.floor(rnd() * MUTATION_TYPES.length)
      steps.push({ kind: 'mutation', type: MUTATION_TYPES[index] })
    }
  }
  return steps
}

// The start document: every example's own document merged feature by feature,
// first id wins. A mutation drawn at random only has a real effect on the doc
// it was authored for, so the union gives the pool of targets the registry was
// built against; without it most steps would be guard-classified no-ops and the
// fuzz would exercise almost nothing.
export function initialFuzzDoc(): PartDoc {
  const features: PartFeature[] = []
  const seen = new Set<string>()
  let partStyle: PartDoc['part_style']
  for (const example of Object.values(MUTATION_EXAMPLES)) {
    const source = example.makeDoc()
    for (const feature of source.features ?? []) {
      if (seen.has(feature.id)) continue
      seen.add(feature.id)
      features.push(feature)
    }
    if (source.part_style) partStyle = { ...(partStyle ?? {}), ...source.part_style }
  }
  const doc = makeDoc(...features)
  if (partStyle) doc.part_style = partStyle
  return doc
}

// The sketch a session opens on: a real id from the union doc, so the editor
// facts the session reads name a feature the steps can act on.
const SESSION_FEATURE_ID = initialFuzzDoc().features?.find(feature => feature.kind === 'sketch')?.id ?? 'sk1'

// The session stream. Kept apart from generateSequence on purpose: that
// stream's draw order is what the pinned regression seeds replay, so extending
// the vocabulary inside it would silently re-roll the ratchet. This one wraps
// runs of the same steps in an unsuppressed session, which is the shape the
// floor rule exists for: an undo inside it may not cross the session's own
// first entry, and a cancel must put the doc and the stacks back.
export function generateSessionSequence(seed: number, length: number): FuzzStep[] {
  const rnd = makePrng(seed)
  const steps: FuzzStep[] = []
  const drawStep = (): FuzzStep => {
    const roll = rnd()
    if (roll < 0.2) return { kind: 'undo' }
    if (roll < 0.35) return { kind: 'redo' }
    const index = Math.floor(rnd() * MUTATION_TYPES.length)
    return { kind: 'mutation', type: MUTATION_TYPES[index] }
  }
  while (steps.length < length) {
    const room = length - steps.length
    const roll = rnd()
    // A session needs open, at least one action, and close. The actions are
    // drawn from the same undo/redo/mutation mix as the flat stream.
    if (roll < 0.25 && room >= 3) {
      const actions = 1 + Math.floor(rnd() * Math.min(3, room - 2))
      steps.push({ kind: 'sessionOpen', featureId: SESSION_FEATURE_ID })
      for (let i = 0; i < actions; i++) steps.push(drawStep())
      steps.push(rnd() < 0.65 ? { kind: 'sessionCommit' } : { kind: 'sessionCancel' })
    } else if (roll < 0.4) {
      steps.push({ kind: 'undo' })
    } else if (roll < 0.55) {
      steps.push({ kind: 'redo' })
    } else {
      const index = Math.floor(rnd() * MUTATION_TYPES.length)
      steps.push({ kind: 'mutation', type: MUTATION_TYPES[index] })
    }
  }
  return steps
}

// The document contract in one place: the fields every consumer (persistence,
// export, query resolution) assumes. Ids are only required to be present and
// non-empty, not unique: the fuzz cross-applies and repeats examples authored
// for separate documents, so an add_* step rebuilds a hard-coded id the doc
// already carries. Production mints fresh ids at the command layer, which is
// what actually guarantees uniqueness; asserting it here would only pin the
// harness's own re-application, not the session.
export function wellFormedProblems(doc: PartDoc | null): string[] {
  const problems: string[] = []
  if (doc === null) return ['document is null']
  if (doc.version !== 1) problems.push(`version is ${String(doc.version)}`)
  if (doc.kind !== 'part') problems.push(`kind is ${String(doc.kind)}`)
  if (!Array.isArray(doc.features)) return [...problems, 'features is not an array']
  const hasId = (value: unknown): boolean => typeof value === 'string' && value !== ''
  for (const feature of doc.features) {
    if (!hasId(feature.id)) problems.push('feature without an id')
    // Widened on purpose: this is the fuzz driver's well-formedness view of a
    // document that crossed session/serialization seams, so it must be able to
    // report a kind the union cannot name rather than assume the type holds.
    const kind: string = feature.kind
    if (typeof kind !== 'string' || kind === '') {
      problems.push(`feature ${feature.id} without a kind`)
    }
    if (feature.kind !== 'sketch') continue
    for (const entity of feature.entities ?? []) {
      if (!hasId(entity.id)) problems.push(`entity of ${feature.id} without an id`)
    }
    for (const constraint of feature.constraints ?? []) {
      if (!hasId(constraint.id)) problems.push(`constraint of ${feature.id} without an id`)
    }
  }
  if (doc.rollback !== undefined && (!Number.isInteger(doc.rollback) || doc.rollback < 0)) {
    problems.push(`rollback is ${String(doc.rollback)}`)
  }
  return problems
}

// JSON drops -0's sign, so an otherwise identical document would look changed
// to the deep compare. The sign survives structuredClone but not storage, and
// -0 and 0 are the same point geometrically, so the check normalizes it away
// and keeps flagging real content loss (undefined values, NaN and Infinity,
// which become null).
function normalizeNegativeZero(value: unknown): unknown {
  if (Object.is(value, -0)) return 0
  if (Array.isArray(value)) return value.map(normalizeNegativeZero)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value)) {
      out[key] = normalizeNegativeZero((value as Record<string, unknown>)[key])
    }
    return out
  }
  return value
}

// The store persists the doc as YAML and the export path round-trips it, so a
// document that loses content to JSON serialization is already broken even
// though its consumers have not seen it yet.
function serializationProblem(doc: PartDoc): string | null {
  try {
    const parsed = JSON.parse(JSON.stringify(doc))
    return isDeepStrictEqual(parsed, normalizeNegativeZero(doc))
      ? null
      : 'document does not survive a JSON round-trip'
  } catch (e) {
    return `document did not serialize: ${String(e)}`
  }
}

// What the driver needs from a solve backend: a scheduler for the session and
// a way to complete whatever the scheduler deferred, so a synchronous fake can
// reach idle. A real-kernel scheduler settles on its own and its settle() is a
// no-op.
// settle() may be async: the real suite hands the event loop a macrotask
// there, since a seed of synchronous WASM solves otherwise never leaves the
// microtask queue and trips the test-setup stall guard.
export interface FuzzSolver {
  scheduler: SolveScheduler<PartDoc>
  settle(): void | Promise<void>
}

export interface FuzzRunOptions {
  // false models a caller that forgot the store pre-sync: the session must
  // refuse set_rollback with a rollback-unsynced fault (R04), which the
  // minimiser tests pin as a known failing seed.
  presyncRollback?: boolean
  // A throw out of the solve pipeline is a kernel crash; a feature the kernel
  // cannot resolve is reported as a failed feature result instead and stays
  // acceptable, exactly as production treats it.
  failOnSolveError?: boolean
}

export interface FuzzViolation {
  // The step the violation was observed at; steps.length is the end-of-run
  // undo-all/redo-all phase.
  step: number
  message: string
}

/** The document the session held when a step first reported a violation. */
export interface FuzzFailureDoc {
  step: number
  doc: PartDoc
}

export interface FuzzRunResult {
  violations: FuzzViolation[]
  // The live document at each failing step, so a caller can write an openable
  // repro instead of only a seed number. Empty on a passing run.
  failureDocs: FuzzFailureDoc[]
  // Landed mutation steps: steps that earned a history entry. A run of pure
  // no-ops would pass every invariant vacuously, so callers assert on this.
  landedSteps: number
  undoMoves: number
  redoMoves: number
  // Session coverage: how many unsuppressed sessions the run opened, how many
  // history moves it made without leaving one, how many keystrokes the session
  // floor made dead, and how many sessions a cancel ended. A session sweep
  // asserts these so a generator that stopped emitting sessions cannot pass.
  sessionsOpened: number
  inSessionMoves: number
  floorBlocked: number
  sessionCancels: number
  // The deepest the undo stack ever got, and how many pushes landed on a full
  // stack and therefore dropped the oldest entry. A cap test asserts both so
  // that removing pushCapped's slice fails here, not just in the per-step
  // "exceeds the cap" guard.
  maxUndoDepth: number
  droppedEntries: number
  // Whether undo-all landed back on the start doc. Only a cap drop breaks
  // that: history entries are clones, so with no drops the floor entry is the
  // start doc by construction. This is what makes a capped run observably
  // different from a bounded one.
  undoAllReachedStart: boolean
}

export async function runFuzzSequence(
  steps: readonly FuzzStep[],
  solver: FuzzSolver,
  options: FuzzRunOptions = {},
): Promise<FuzzRunResult> {
  const cell: { current: PartDoc | null } = { current: initialFuzzDoc() }
  const facts: EditorFacts = { editingFeatureId: null, rollbackPosition: null }
  const dirty: DirtyFacts = { dirty: false, saves: 0, savedHash: null }
  const solveResults: { current: Record<string, SketchData> } = { current: {} }
  const session = createDocSession({
    cloneDoc: doc => structuredClone(doc),
    doc: { get: () => cell.current, set: next => { cell.current = next } },
    solve: solver.scheduler,
    solveResults: { get: () => solveResults.current, set: next => { solveResults.current = next } },
    editorFacts: () => ({ editingFeatureId: facts.editingFeatureId, rollbackPosition: facts.rollbackPosition }),
    dirtyFacts: () => dirty,
  })

  const violations: FuzzViolation[] = []
  const failureDocs: FuzzFailureDoc[] = []
  const push = (step: number, message: string): void => {
    violations.push({ step, message })
    // Capture the document the session actually held at the failing step, once
    // per step: the caller can write it as a YAML repro the app opens.
    if (cell.current !== null && !failureDocs.some((entry) => entry.step === step)) {
      failureDocs.push({ step, doc: structuredClone(cell.current) })
    }
  }
  const startDoc = structuredClone(cell.current as PartDoc)
  // A landed mutation offers a dirty decision; a guarded no-op offers none, so
  // the decision is also this driver's "did the step push an entry" signal.
  const mirrorDirty = (): boolean | null => {
    const decision = session.takeDirtyDecision()
    if (decision !== null) dirty.dirty = decision
    return decision
  }
  // The doc the newest landed entry produces: redo-all after undo-all replays
  // the surviving timeline to exactly this doc, whether or not the sequence
  // ended with the entry undone.
  let timelineTop = structuredClone(cell.current as PartDoc)
  let landedSteps = 0
  let undoMoves = 0
  let redoMoves = 0
  let sessionsOpened = 0
  let inSessionMoves = 0
  let floorBlocked = 0
  let sessionCancels = 0
  let maxUndoDepth = 0
  let droppedEntries = 0

  // What a cancel has to put back: the doc and both stacks as they stood when
  // the session opened. Entry docs are cloned so a later write-back cannot make
  // the comparison lie.
  interface SessionBaseline {
    doc: PartDoc
    undo: { label: string; doc: PartDoc }[]
    redo: { label: string; doc: PartDoc }[]
  }
  const stackNodes = (): { undo: SessionBaseline['undo']; redo: SessionBaseline['redo'] } => {
    const history = session.historyEntries()
    return {
      undo: history.undo.map(entry => ({ label: entry.label, doc: structuredClone(entry.doc) })),
      redo: history.redo.map(entry => ({ label: entry.label, doc: structuredClone(entry.doc) })),
    }
  }
  let sessionBaseline: SessionBaseline | null = null

  const settle = async (): Promise<void> => {
    await solver.settle()
    await session.idle()
  }

  for (let stepIndex = 0; stepIndex < steps.length; stepIndex++) {
    const step = steps[stepIndex]
    if (step.kind === 'sessionOpen') {
      if (sessionBaseline !== null) push(stepIndex, 'sessionOpen while a session is already open')
      const doc = cell.current
      if (doc === null) push(stepIndex, 'sessionOpen with no document')
      const baseline = stackNodes()
      sessionBaseline = { doc: structuredClone(doc as PartDoc), undo: baseline.undo, redo: baseline.redo }
      session.begin('edit', { suppressed: false })
      // Production enters the session first and stamps the edited feature
      // afterwards (useEditFeature's enterEditFeature).
      facts.editingFeatureId = step.featureId
      const index = doc?.features?.findIndex(feature => feature.id === step.featureId) ?? -1
      if (index >= 0) facts.rollbackPosition = index + 1
      sessionsOpened++
    } else if (step.kind === 'sessionCommit') {
      if (sessionBaseline === null) {
        push(stepIndex, 'sessionCommit with no open session')
      } else {
        const id = session.transactions().find(txn => txn.kind === 'edit')?.id
        if (id === undefined) push(stepIndex, 'sessionCommit found no edit transaction')
        else session.commit(id)
        mirrorDirty()
        sessionBaseline = null
        facts.editingFeatureId = null
        facts.rollbackPosition = cell.current?.rollback ?? null
      }
    } else if (step.kind === 'sessionCancel') {
      if (sessionBaseline === null) {
        push(stepIndex, 'sessionCancel with no open session')
      } else {
        const id = session.transactions().find(txn => txn.kind === 'edit')?.id
        if (id === undefined) push(stepIndex, 'sessionCancel found no edit transaction')
        else session.cancel(id)
        mirrorDirty()
        const baseline = sessionBaseline
        sessionBaseline = null
        facts.editingFeatureId = null
        facts.rollbackPosition = cell.current?.rollback ?? null
        // The cancel's contract: the doc and both stacks are exactly the pair a
        // rewind leaves behind, no stray entry from the discarded work.
        if (!isDeepStrictEqual(cell.current, baseline.doc)) {
          push(stepIndex, 'sessionCancel did not rewind to the pre-session document')
        }
        const restored = stackNodes()
        if (!isDeepStrictEqual(restored.undo, baseline.undo) || !isDeepStrictEqual(restored.redo, baseline.redo)) {
          push(stepIndex, 'sessionCancel did not restore the pre-session stacks')
        }
        // The discarded work is gone. A redo entry's counterpart doc is the doc
        // the undo left behind, and the redo-all at the end replays the stack
        // from its top (the oldest undone entry) down to the bottom (the newest
        // one), so the bottom is where the timeline ended. With no redo branch
        // left, the session baseline is the doc after the newest entry.
        const historyNow = session.historyEntries()
        timelineTop = structuredClone(historyNow.redo.length > 0
          ? historyNow.redo[0].doc
          : (cell.current as PartDoc))
        sessionCancels++
      }
    } else if (step.kind === 'mutation') {
      const mutation = MUTATION_EXAMPLES[step.type].mutation
      if (mutation.type === 'set_rollback' && options.presyncRollback !== false) {
        // The caller-side pre-sync Part.tsx performs before dispatching.
        facts.rollbackPosition = mutation.position
      }
      // pushCapped drops the oldest entry exactly when a landed push arrives
      // on a full undo stack, and one landed mutation pushes exactly one entry,
      // so the depth read before the execute says whether this push dropped.
      const undoDepthBefore = session.historyEntries().undo.length
      // A named refusal is a legitimate outcome the UI voices instead of a
      // landed entry (a freeze whose projection another step already removed,
      // an add whose source a later step deleted). It is not a fuzz violation:
      // the invariants below still run on the unchanged document.
      try {
        const result = session.execute(mutation)
        if (!result.ok && result.code !== 'refused') {
          push(stepIndex, `execute(${step.type}) refused: ${result.code}`)
        }
      } catch (e) {
        if (!(e instanceof MutationRefusal)) throw e
      }
      if (mirrorDirty() === true) {
        landedSteps++
        if (undoDepthBefore >= MAX_UNDO_DEPTH) droppedEntries++
        // The newest landed entry, not the newest step: a guarded no-op after
        // an undo leaves the timeline top where the last push put it.
        timelineTop = structuredClone(cell.current as PartDoc)
      }
    } else if (step.kind === 'undo') {
      const inSession = session.transactions().some(txn => txn.kind === 'edit')
      if (session.undo()) {
        undoMoves++
        if (inSession) inSessionMoves++
      } else if (inSession) {
        floorBlocked++
      }
      mirrorDirty()
    } else {
      const inSession = session.transactions().some(txn => txn.kind === 'edit')
      if (session.redo()) {
        redoMoves++
        if (inSession) inSessionMoves++
      } else if (inSession) {
        floorBlocked++
      }
      mirrorDirty()
    }
    await settle()

    const doc = cell.current
    for (const problem of wellFormedProblems(doc)) push(stepIndex, problem)
    if (doc !== null) {
      const serialization = serializationProblem(doc)
      if (serialization !== null) push(stepIndex, serialization)
    }
    // settle() above already awaited idle(), so a truthful real scheduler can
    // never be pending here. This guards the scheduler contract (an idle() that
    // resolves while the scheduler still reports work pending, or a future
    // settle() that stops awaiting) against passing silently.
    const solveState = session.inspect().solve
    if (solveState.pending) push(stepIndex, 'session did not reach idle')
    if (options.failOnSolveError !== false && solveState.lastError !== null) {
      push(stepIndex, `solve error: ${solveState.lastError}`)
    }
    const history = session.historyEntries()
    if (history.undo.length > maxUndoDepth) maxUndoDepth = history.undo.length
    if (history.undo.length > MAX_UNDO_DEPTH) push(stepIndex, `undo stack ${history.undo.length} exceeds the cap`)
    if (history.redo.length > MAX_UNDO_DEPTH) push(stepIndex, `redo stack ${history.redo.length} exceeds the cap`)
  }

  // A caller-built sequence can end inside a session (the generator never
  // does). Close it the way the editor does before the history round trip is
  // judged, or the in-session floor would stop the undo-all short of the floor.
  if (sessionBaseline !== null) {
    const id = session.transactions().find(txn => txn.kind === 'edit')?.id
    if (id !== undefined) session.commit(id)
    mirrorDirty()
    facts.editingFeatureId = null
  }

  // Undo-all reaches the floor of the undo stack: the doc of its oldest
  // surviving entry, or the live doc when nothing can be undone. A capped run
  // lost the dropped prefix, so its floor is the dropped boundary; a bounded
  // run must land back on the start doc exactly.
  const undoEntries = session.historyEntries().undo
  const undoFloor = structuredClone(undoEntries.length > 0 ? undoEntries[0].doc : (cell.current as PartDoc))
  while (true) {
    const moved = session.undo()
    await settle()
    if (!moved) break
  }
  const undoAllReachedStart = isDeepStrictEqual(cell.current, startDoc)
  if (!isDeepStrictEqual(cell.current, undoFloor)) {
    push(steps.length, 'undo-all did not return the undo floor document')
  }
  if (landedSteps <= MAX_UNDO_DEPTH && !undoAllReachedStart) {
    push(steps.length, 'undo-all did not return the initial document')
  }
  while (true) {
    const moved = session.redo()
    await settle()
    if (!moved) break
  }
  if (!isDeepStrictEqual(cell.current, timelineTop)) {
    push(steps.length, 'redo-all did not return the post-history document')
  }

  return {
    violations,
    failureDocs,
    landedSteps,
    undoMoves,
    redoMoves,
    sessionsOpened,
    inSessionMoves,
    floorBlocked,
    sessionCancels,
    maxUndoDepth,
    droppedEntries,
    undoAllReachedStart,
  }
}
