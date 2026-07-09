import { create } from 'zustand'
import type { AssemblyDoc, PartInstance, MateFeature, MateRef, MateRefField, Transform3D, BodyResult } from '@/types/cad'
import type { EdgeCurve } from '@/kernel/partBundle'
import type { MateResult } from '@/kernel/solveAssembly'
import { cycleIndex, resolveCandidates, sameCandidateSet, type EntityMateRefs } from '@/utils/anchorCandidates'
import { hoverScopeEntity, type AnchorTable } from '@/utils/anchorGizmos'
import { setMateRef } from '@/utils/assemblyMutations'
import type { AssemblyPickBody } from '@/utils/assemblyPick'
import type { Vec3 } from '@/utils/transform3d'

/** The mate reference slot a pick currently writes into; null when not authoring. */
export interface MateFieldTarget {
  featureId: string
  field: MateRefField
}

/** One entity the ID buffer found under the cursor, resolver-ordered. */
export interface EntityHit {
  entityKey: string
}

function sameEntityHits(a: readonly EntityHit[], b: readonly EntityHit[]): boolean {
  return a.length === b.length && a.every((h, i) => h.entityKey === b[i].entityKey)
}
import {
  beginManipulation,
  commitManipulation,
  dragTranslate,
  gizmoRotate,
  type ManipulationSession,
} from '@/utils/partManipulation'

type UndoEntry = { doc: unknown; mutation: unknown }

export interface AssemblyEditorData {
  doc: AssemblyDoc | null
  instances: PartInstance[]
  mates: MateFeature[]
  /** Per-mate solve outcome, keyed by feature id. `stale` drives the red rendering. */
  mateResults: Record<string, MateResult>
  transforms: Record<string, Transform3D>
  bodies: Record<string, BodyResult>
  /** Analytic edges of the solved bodies, keyed by the same body id. */
  edgeCurves: Record<string, EdgeCurve[]>
  /** Entity pick id -> the mate refs it offers. The Stage 7 pick lookup. */
  entityMateRefs: EntityMateRefs
  /** Solved-pose anchor geometry, by part handle plus the assembly's own frame. */
  anchors: AnchorTable
  /** ID-layer registration payloads for the solved scene. */
  pickGeometry: AssemblyPickBody[]
  activePartHandle: string | null
  selectedPartHandle: string | null
  /** The mate whose editor panel is open; null when no mate is being authored. */
  selectedMateId: string | null
  /** The reference slot an aimed pick writes into. Null means picks only aim. */
  activeMateField: MateFieldTarget | null
  /**
   * A reference was written since the field was armed. Committing a pick does not
   * re-solve (that would drop `pickCandidates` and kill the cycle), so the solve
   * is owed until the field closes.
   */
  mateFieldDirty: boolean
  /**
   * The mate references under the last pick, resolver-ordered, and which one is
   * aimed. A pick keeps the whole set: at a corner the user cycles through it
   * rather than re-clicking pixels until the right entity happens to win.
   * `pickIndex` is -1 exactly when the set is empty.
   */
  pickCandidates: MateRef[]
  pickIndex: number
  /** Ctrl+hover entity scope: restricts picks to this one entity's anchors. */
  pickScopeEntity: string | null
  /**
   * The entities under the cursor right now. Empty is the resting state, and it
   * is what keeps a part's ~54 anchors from all being drawn at once: gizmos
   * exist only for what these hits resolve to.
   */
  hoverHits: EntityHit[]
  /** Live drag/gizmo state; null between manipulations. */
  manipulation: ManipulationSession | null
  isSolving: boolean
  solveError: string | null
  undoStack: UndoEntry[]
  redoStack: UndoEntry[]
}

export const DEFAULT_ASSEMBLY_EDITOR_DATA: AssemblyEditorData = {
  doc: null,
  instances: [],
  mates: [],
  mateResults: {},
  transforms: {},
  bodies: {},
  edgeCurves: {},
  entityMateRefs: {},
  anchors: {},
  pickGeometry: [],
  activePartHandle: null,
  selectedPartHandle: null,
  selectedMateId: null,
  activeMateField: null,
  mateFieldDirty: false,
  pickCandidates: [],
  pickIndex: -1,
  pickScopeEntity: null,
  hoverHits: [],
  manipulation: null,
  isSolving: false,
  solveError: null,
  undoStack: [],
  redoStack: [],
}

/** Everything one solve produces. Grouped so a new derived artifact (anchors,
 *  pick geometry) cannot be added to the solve and forgotten at the store. */
export type AssemblySolveResult = Pick<
  AssemblyEditorData,
  'transforms' | 'bodies' | 'edgeCurves' | 'entityMateRefs' | 'anchors' | 'pickGeometry' | 'mateResults'
>

// Fields owned exclusively by the store (not overwritten by setSnapshot).
const STORE_OWNED_FIELDS = [
  'activePartHandle', 'selectedPartHandle', 'manipulation',
  'selectedMateId', 'activeMateField', 'mateFieldDirty',
  'pickCandidates', 'pickIndex', 'pickScopeEntity', 'hoverHits',
] as const

/**
 * Host callbacks the AssemblyEditor registers, mirroring `setSketchCallback`
 * (sketchEditorStore): the store owns the manipulation state machine but does
 * not own the document, so committing a drag hands the new doc back to the page
 * and asks for exactly one re-solve.
 */
export interface AssemblyCallbacks {
  mutateDoc: (fn: (doc: AssemblyDoc) => AssemblyDoc) => void
  requestSolve: () => void
}

let callbacks: AssemblyCallbacks | null = null

export function setAssemblyCallbacks(cb: AssemblyCallbacks | null): void {
  callbacks = cb
}

interface AssemblyEditorState extends AssemblyEditorData {
  setSnapshot: (data: AssemblyEditorData) => void
  setActivePartHandle: (handle: string | null) => void
  setSelectedPartHandle: (handle: string | null) => void
  /** Open a mate's editor. Closing the previous one settles its owed solve. */
  setSelectedMateId: (featureId: string | null) => void
  /** Arm a reference slot for the next pick; `null` disarms and re-solves if owed. */
  setActiveMateField: (target: MateFieldTarget | null) => void
  /** Push a mate edit to the solver, unless a chip is armed; then it is owed. */
  requestSolveOrDefer: () => void
  setIsSolving: (solving: boolean) => void
  setSolveError: (error: string | null) => void
  setSolveResult: (result: AssemblySolveResult) => void
  /** Resolve an ordered hit list into the candidate set, aiming its first entry. */
  setPickFromHits: (hits: readonly EntityHit[]) => void
  /** A Ctrl+click: re-aim, or advance the cycle when it lands on the same set. */
  pickFromHitsOrCycle: (hits: readonly EntityHit[]) => void
  /** Write the aimed reference into the armed mate slot. No-op when none is armed. */
  commitAimToMateField: () => void
  /** Ctrl+click: aim the next candidate. No-op on an empty set. */
  cyclePickCandidate: () => void
  clearPickCandidates: () => void
  setPickScopeEntity: (entityKey: string | null) => void
  /** Pointer moved: reveal the hovered entities' anchors; Ctrl narrows the scope. */
  setHoverHits: (hits: readonly EntityHit[], ctrlKey: boolean) => void
  clearHover: () => void
  /** The reference a mate pick chip would commit right now; the set is retained. */
  activePickCandidate: () => MateRef | null
  /** Pointer-down on a part body or its triad. No-op for a grounded instance. */
  beginPartManipulation: (handle: string) => boolean
  /** `delta` / `angle` are measured from pointer-down, not from the last frame. */
  dragPartTranslate: (delta: Vec3) => void
  rotatePartGizmo: (axis: Vec3, angle: number, pivot?: Vec3) => void
  /** Pointer-up: write the seed transform, then re-solve once if it moved. */
  endPartManipulation: () => void
  cancelPartManipulation: () => void
}

export const useAssemblyStore = create<AssemblyEditorState>((set, get) => ({
  ...DEFAULT_ASSEMBLY_EDITOR_DATA,
  setSnapshot: (data) => set((prev) => {
    const prevRec = prev as unknown as Record<string, unknown>
    const merged = { ...data } as unknown as Record<string, unknown>
    for (const field of STORE_OWNED_FIELDS) {
      merged[field] = prevRec[field]
    }
    return merged as unknown as AssemblyEditorData
  }),
  setActivePartHandle: (handle) => set({ activePartHandle: handle }),
  setSelectedPartHandle: (handle) => set({ selectedPartHandle: handle }),

  setSelectedMateId: (featureId) => {
    get().setActiveMateField(null)  // leaving a mate settles the solve its picks owe
    set({ selectedMateId: featureId })
  },

  // Disarming is where an authored mate reaches the solver. Committing a pick
  // cannot re-solve: setSolveResult drops the candidate set, so the second
  // Ctrl+click on a corner would re-aim its first entity instead of advancing,
  // and the entities behind the vertex would be unreachable.
  setActiveMateField: (target) => {
    const owed = target === null && get().mateFieldDirty
    set(prev => ({ activeMateField: target, mateFieldDirty: owed ? false : prev.mateFieldDirty }))
    if (owed) callbacks?.requestSolve()
  },

  // Any mate edit made while a chip is armed has to take the same deferral as a
  // pick. Typing an offset mid-authoring would otherwise re-solve, drop the
  // candidate set, and leave the armed field unable to cycle the corner it aims
  // at. The edit is owed along with the picks and lands when the field closes.
  requestSolveOrDefer: () => {
    if (get().activeMateField) {
      set({ mateFieldDirty: true })
      return
    }
    callbacks?.requestSolve()
  },

  setIsSolving: (solving) => set({ isSolving: solving }),
  setSolveError: (error) => set({ solveError: error }),
  setSolveResult: (result) => set({
    ...result,
    // A re-solve can retire the anchors the aimed candidate named (a rebuilt
    // bundle sheds an anchor its feature deleted), so the stale set is dropped
    // rather than left pointing into the previous rev. The hover goes with it:
    // its entity keys are positional and a rebuilt body renumbers them.
    pickCandidates: [], pickIndex: -1, hoverHits: [],
  }),

  setPickFromHits: (hits) => set((prev) => {
    const pickCandidates = resolveCandidates(hits, prev.entityMateRefs, prev.pickScopeEntity)
    return { pickCandidates, pickIndex: pickCandidates.length > 0 ? 0 : -1 }
  }),

  // Clicking the same corner twice must advance the aim rather than reset it to
  // the top candidate, or a user could never reach the face behind the vertex.
  // Clicking elsewhere re-aims, because the old set no longer describes what is
  // under the cursor.
  pickFromHitsOrCycle: (hits) => {
    const prev = get()
    const next = resolveCandidates(hits, prev.entityMateRefs, prev.pickScopeEntity)
    if (next.length > 0 && sameCandidateSet(next, prev.pickCandidates)) {
      prev.cyclePickCandidate()
    } else {
      set({ pickCandidates: next, pickIndex: next.length > 0 ? 0 : -1 })
    }
    get().commitAimToMateField()
  },

  // An armed chip follows the aim: every click and every cycle rewrites the
  // reference, so the triad the user sees highlighted is the one the mate holds.
  // A hit on an anchor-less entity aims at nothing and therefore writes nothing.
  commitAimToMateField: () => {
    const { activeMateField, doc } = get()
    const ref = get().activePickCandidate()
    if (!activeMateField || !ref || !doc || !callbacks) return
    callbacks.mutateDoc(d => setMateRef(d, activeMateField.featureId, activeMateField.field, ref))
    set({ mateFieldDirty: true })
  },

  cyclePickCandidate: () => set((prev) => ({
    pickIndex: cycleIndex(prev.pickCandidates.length, prev.pickIndex),
  })),

  clearPickCandidates: () => set({ pickCandidates: [], pickIndex: -1 }),

  setPickScopeEntity: (entityKey) => set({ pickScopeEntity: entityKey }),

  // The scope rides the hover rather than latching: releasing Ctrl on the next
  // move must widen the set back, or the user would be stuck aiming at whatever
  // entity happened to be under the cursor when they pressed the key.
  //
  // A pointer resting on one face re-resolves the same hits every frame. Writing
  // them back would hand the viewport a fresh array each time, and every visible
  // triad would rebuild its geometry for a hover that never changed.
  setHoverHits: (hits, ctrlKey) => set((prev) => {
    const scope = hoverScopeEntity(hits, ctrlKey)
    if (scope === prev.pickScopeEntity && sameEntityHits(hits, prev.hoverHits)) return {}
    return { hoverHits: [...hits], pickScopeEntity: scope }
  }),

  clearHover: () => set({ hoverHits: [], pickScopeEntity: null }),

  activePickCandidate: () => {
    const { pickCandidates, pickIndex } = get()
    return pickIndex >= 0 ? pickCandidates[pickIndex] ?? null : null
  },

  beginPartManipulation: (handle) => {
    const doc = get().doc
    if (!doc) return false
    const session = beginManipulation(doc, handle)
    if (!session) return false
    set({ manipulation: session })
    return true
  },

  dragPartTranslate: (delta) => set((prev) => (
    prev.manipulation ? { manipulation: dragTranslate(prev.manipulation, delta) } : {}
  )),

  rotatePartGizmo: (axis, angle, pivot) => set((prev) => (
    prev.manipulation ? { manipulation: gizmoRotate(prev.manipulation, axis, angle, pivot) } : {}
  )),

  endPartManipulation: () => {
    const { manipulation, doc } = get()
    set({ manipulation: null })
    if (!manipulation || !doc || !callbacks) return
    const { changed } = commitManipulation(doc, manipulation)
    // A click that never moved the part must not dirty the doc or re-solve.
    if (!changed) return
    callbacks.mutateDoc(d => commitManipulation(d, manipulation).doc)
    callbacks.requestSolve()  // one cold solve per pointer-up; no per-frame mate solve
  },

  cancelPartManipulation: () => set({ manipulation: null }),
}))
