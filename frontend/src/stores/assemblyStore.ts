import { create } from 'zustand'
import type { AssemblyDoc, PartInstance, MateFeature, MateRef, MateRefField, Transform3D, BodyResult } from '@/types/cad'
import type { EdgeCurve } from '@/kernel/partBundle'
import type { AssemblySolveStatus } from '@/kernel/solveAssembly'
import { cycleIndex, resolveCandidates, sameCandidateSet, type EntityMateRefs } from '@/utils/anchorCandidates'
import { hoverScopeEntity, type AnchorTable } from '@/utils/anchorGizmos'
import { bakeSolvedTransforms, findInstance, findMate, setMateRef, updateMate } from '@/utils/assemblyMutations'
import { reduceEditingSubject, type EditingSubject } from '@/utils/assemblyEditingSubject'
import type { AssemblySubject } from '@/utils/assemblySelection'
import { runAssemblyOperation } from '@/utils/assemblyOperations'
import { ASSEMBLY_UNDO_LABELS, type AssemblyUndoLabel } from '@/utils/core/assemblyUndoLabels'
import { captureMateOrientationPatch } from '@/utils/mateCapture'
import type { AssemblyPickBody } from '@/utils/assemblyPick'
import type { GizmoAxisName } from '@/utils/gizmoPickGeometry'
import { composeTransforms, IDENTITY_TRANSFORM, transformsEqual, type Vec3 } from '@/utils/transform3d'

/** The mate reference slot a pick currently writes into; null when not authoring. */
export interface MateFieldTarget {
  featureId: string
  field: MateRefField
}

/**
 * The triad gesture in progress, published for the renderer. The gesture itself
 * lives in a closure inside the pointer adapter, which React cannot see, so the
 * triad learns which handle is grabbed (and, for a ring, how far it has swung)
 * from here. `axis` is the part-local axis name, not a world vector, so the
 * renderer matches it against GIZMO_AXES without inverse-rotating anything.
 */
export type GizmoDragState =
  | { kind: 'axis'; axis: GizmoAxisName }
  | { kind: 'plane'; axis: GizmoAxisName }
  /**
   * `swing` is the SNAPPED angle the part receives, which is what the dial draws.
   * `snapped` is this frame's outcome; `snapArmed` is whether snapping could
   * happen at all, which the cursor's distance from the ring decides. The dial
   * shows the two differently: a free angle inside the ring still has ticks to
   * fall onto, a disarmed one has none, and the user must be able to see which.
   */
  | {
      kind: 'ring'
      axis: GizmoAxisName
      datum: number
      swing: number
      snapped: boolean
      snapArmed: boolean
    }

/** One entity the ID buffer found under the cursor, resolver-ordered. */
export interface EntityHit {
  entityKey: string
}

function sameEntityHits(a: readonly EntityHit[], b: readonly EntityHit[]): boolean {
  return a.length === b.length && a.every((h, i) => h.entityKey === b[i].entityKey)
}
import {
  beginBodyManipulation,
  beginManipulation,
  commitManipulation,
  dragTranslate,
  gizmoRotate,
  manipulationDelta,
  setDragSolvedPose as setDragSolvedPoseOnSession,
  setDragTarget as setDragTargetOnSession,
  settledTransforms,
  type ManipulationSession,
} from '@/utils/partManipulation'

/** One undo step: the pre-mutation document plus a short label for the toolbar tooltip. */
export interface AssemblyUndoEntry {
  doc: AssemblyDoc
  label: AssemblyUndoLabel
}

export interface AssemblyEditorData {
  doc: AssemblyDoc | null
  instances: PartInstance[]
  mates: MateFeature[]
  // The whole solve verdict, including the per-mate and per-part marks. One
  // field so no consumer re-derives failure from a partial signal.
  solveStatus: AssemblySolveStatus | null
  transforms: Record<string, Transform3D>
  bodies: Record<string, BodyResult>
  // Analytic edges of the solved bodies, keyed by the same body id.
  edgeCurves: Record<string, EdgeCurve[]>
  // Entity pick id -> the mate refs it offers. The Stage 7 pick lookup.
  entityMateRefs: EntityMateRefs
  // Solved-pose anchor geometry, by part handle plus the assembly's own frame.
  anchors: AnchorTable
  // ID-layer registration payloads for the solved scene.
  pickGeometry: AssemblyPickBody[]
  // The solved pose `pickGeometry` was baked at. The ID buffer offsets from this
  // onto the drawn pose, so a committed drag's pick geometry follows the parts.
  pickGeometryPose: Record<string, Transform3D>
  // The tree subject: the one selected part handle or mate id, as a union so
  // "both a part and a mate are selected" is unrepresentable.
  subject: AssemblySubject | null
  // Which subject (if any) has its inline editor open. One tagged value instead
  // of two independent ids, so "a mate and an instance at once" is impossible.
  editingSubject: EditingSubject
  // The reference slot an aimed pick writes into. Null means picks only aim.
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
  // Ctrl+hover entity scope: restricts picks to this one entity's anchors.
  pickScopeEntity: string | null
  /**
   * The entities under the cursor right now. Empty is the resting state, and it
   * is what keeps a part's ~54 anchors from all being drawn at once: gizmos
   * exist only for what these hits resolve to.
   */
  hoverHits: EntityHit[]
  /**
   * B-rep entities selected for measurement, keyed by `assemblyEntityKey`. Named
   * `entitySelection` so "which selection" has one answer: this is the entity
   * set, orthogonal to the tree `subject`. It is live only when no mate field is
   * armed: the viewport is a dock-connector picker while authoring a mate and a
   * plain B-rep selector otherwise. Positional keys renumber on re-solve, so a
   * solve clears it (as it does hoverHits).
   */
  entitySelection: Set<string>
  // The single entity under the cursor in B-rep selection mode; null when none.
  hoveredEntity: string | null
  // The ID-buffer debug renderpass overlay (mirrors the part editor's showDebugHit).
  showPickDebug: boolean
  // Live drag/gizmo state; null between manipulations. This is the single
  // React-visible truth for "a drag is live": the viewport derives its orbit
  // lock and render gates from it, and the gesture machine in
  // utils/assemblyPointer is the only writer, so they cannot drift.
  manipulation: ManipulationSession | null
  // Which triad handle is being dragged right now; null when none is. Only the
  // gesture machine's open and move transitions publish it.
  gizmoDrag: GizmoDragState | null
  /**
   * Per-handle render offsets owed by a drag that is committed but not yet
   * re-meshed: the doc holds the new pose while the bodies are still baked at
   * the old one. Retired by the solve that re-bakes them.
   */
  settlingOffsets: Record<string, Transform3D>
  isSolving: boolean
  undoStack: AssemblyUndoEntry[]
  redoStack: AssemblyUndoEntry[]
}

// Mint a fresh set of defaults. Every caller that needs a default for a LIVE
// store slot (the create() seed, resetTransientAssemblyState) must go through
// this rather than the exported constant: the constant's containers are shared,
// and a default Set handed to the store by reference would be poisoned by the
// first in-place `entitySelection.add(...)` for every later document in the tab.
export function createDefaultAssemblyEditorData(): AssemblyEditorData {
  return {
    doc: null,
    instances: [],
    mates: [],
    solveStatus: null,
    transforms: {},
    bodies: {},
    edgeCurves: {},
    entityMateRefs: {},
    anchors: {},
    pickGeometry: [],
    pickGeometryPose: {},
    subject: null,
    editingSubject: { kind: 'none' },
    activeMateField: null,
    mateFieldDirty: false,
    pickCandidates: [],
    pickIndex: -1,
    pickScopeEntity: null,
    hoverHits: [],
    entitySelection: new Set(),
    hoveredEntity: null,
    showPickDebug: false,
    manipulation: null,
    gizmoDrag: null,
    settlingOffsets: {},
    isSolving: false,
    undoStack: [],
    redoStack: [],
  }
}

// READ-ONLY. Exported for the many call sites and tests that pass a default to
// `setSnapshot`, which copies the top level before it writes. `setSnapshot` is
// the only permitted consumer of a mutable field here; a caller that needs a
// default for a live store slot uses `createDefaultAssemblyEditorData()`.
export const DEFAULT_ASSEMBLY_EDITOR_DATA: AssemblyEditorData =
  Object.freeze(createDefaultAssemblyEditorData())

/** Everything one solve produces. Grouped so a new derived artifact (anchors,
 *  pick geometry) cannot be added to the solve and forgotten at the store. */
export type AssemblySolveResult = Pick<
  AssemblyEditorData,
  'transforms' | 'bodies' | 'edgeCurves' | 'entityMateRefs' | 'anchors' | 'pickGeometry' | 'solveStatus'
>

/**
 * Whether two instance lists describe the same parts in the same poses.
 *
 * Exists so `setSnapshot` can hand back the reference it already holds. The
 * page rebuilds the whole snapshot from the document on every doc change, so a
 * mutation that touches no part (flipping a built-in plane visible, editing a
 * mate) still arrives with a freshly built array. Passing that on re-keys the
 * viewport's `groups` memo (AssemblyViewport), which re-runs
 * `getAssemblyPartGroups` and mints a new `items` array for every part, so
 * every AssemblyBody sees new props for a scene that did not change.
 *
 * Compared field by field rather than with an epsilon: this decides object
 * identity, and a pose that differs at all is a different pose. The element
 * fast path is the common case -- instances are the very objects held by the
 * doc's features, and an untouched feature is copied by reference.
 */
export function sameInstances(a: readonly PartInstance[], b: readonly PartInstance[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  return a.every((inst, i) => {
    const other = b[i]
    if (inst === other) return true
    return (
      inst.handle === other.handle &&
      inst.doc_id === other.doc_id &&
      inst.doc_rev === other.doc_rev &&
      inst.visible === other.visible &&
      inst.fixed === other.fixed &&
      inst.transform.tx === other.transform.tx &&
      inst.transform.ty === other.transform.ty &&
      inst.transform.tz === other.transform.tz &&
      inst.transform.qx === other.transform.qx &&
      inst.transform.qy === other.transform.qy &&
      inst.transform.qz === other.transform.qz &&
      inst.transform.qw === other.transform.qw
    )
  })
}

// Fields owned exclusively by the store (not overwritten by setSnapshot). The
// solve lifecycle fields belong here because their writer is the async solve in
// useAssemblySolve, not page state a snapshot mirrors: a snapshot landing
// mid-solve must not clear a running flag or resurrect a banner just retired.
// The undo stacks are mutable store state too: the page spreads the current
// store into every setSnapshot, so they would survive anyway, but naming them
// here keeps setSnapshot's "React-mirrored state only" contract intact.
const STORE_OWNED_FIELDS = [
  'subject', 'manipulation', 'gizmoDrag', 'settlingOffsets',
  'pickGeometryPose',
  'activeMateField', 'mateFieldDirty',
  'editingSubject',
  'pickCandidates', 'pickIndex', 'pickScopeEntity', 'hoverHits',
  'entitySelection', 'hoveredEntity', 'showPickDebug',
  'isSolving', 'solveStatus',
  'undoStack', 'redoStack',
] as const

/**
 * Host callbacks the AssemblyEditor registers, mirroring `setSketchCallback`
 * (sketchEditorStore): the store owns the manipulation state machine but does
 * not own the document, so committing a drag hands the new doc back to the page
 * and asks for exactly one re-solve.
 */
export interface AssemblyCallbacks {
  // One-shot mutations push an undo step immediately.
  mutateDoc: (label: AssemblyUndoLabel, fn: (doc: AssemblyDoc) => AssemblyDoc) => void
  // A ref pick mid-authoring folds into the open edit session's coalesced step.
  mutateDocSession: (label: AssemblyUndoLabel, fn: (doc: AssemblyDoc) => AssemblyDoc) => void
  requestSolve: () => void
}

let callbacks: AssemblyCallbacks | null = null

export function setAssemblyCallbacks(cb: AssemblyCallbacks | null): void {
  callbacks = cb
}

interface AssemblyEditorState extends AssemblyEditorData {
  setSnapshot: (data: AssemblyEditorData) => void
  // A fresh document must not inherit a previous one's undo history; see useAssemblyDoc.
  clearAssemblyHistory: () => void
  // Reset every store-owned interaction field to its create() default, EXCEPT
  // the undo/redo stacks (clearAssemblyHistory owns those). Mirrors
  // sketchEditorStore.resetTransientState: the store is module-level and
  // survives a document swap, so the new doc would otherwise inherit the
  // previous one's live drag, picks, and selection, which describe geometry it
  // does not have. Deliberately a plain set, not the lifecycle actions: it
  // tears down a half-open state (a live drag) that endPartManipulation would
  // try to commit into the new doc.
  resetTransientAssemblyState: () => void
  // Set the tree subject to one part handle, or clear it. By construction a pick
  // drops any mate subject, so the two can never both be set.
  selectPart: (handle: string | null) => void
  // Set the tree subject to one mate id, or clear it. Closing or deleting a mate
  // still disarms the armed field via the setActiveMateField side effect.
  selectMate: (id: string | null) => void
  // The editing subject is store-owned so the undo funnel and deleteSelected can
  // read it without the page threading it through every call.
  openInstanceEditor: (handle: string) => void
  openMateEditor: (id: string) => void
  closeEditor: () => void
  // Arm a reference slot for the next pick; `null` disarms and re-solves if owed.
  setActiveMateField: (target: MateFieldTarget | null) => void
  // Push a mate edit to the solver, unless a chip is armed; then it is owed.
  requestSolveOrDefer: () => void
  setIsSolving: (solving: boolean) => void
  setSolveResult: (result: AssemblySolveResult) => void
  /**
   * A live-drag solve: merge the follower parts' new poses over the current
   * scene. Unlike setSolveResult it leaves the pick/hover/anchor state alone (a
   * drag has none) and does not clear the grabbed part's own entries, which the
   * caller drops so it keeps rendering from its drag offset.
   */
  setDragSolveResult: (result: Pick<AssemblyEditorData, 'transforms' | 'bodies' | 'edgeCurves' | 'solveStatus'>) => void
  // Resolve an ordered hit list into the candidate set, aiming its first entry.
  setPickFromHits: (hits: readonly EntityHit[]) => void
  // A Ctrl+click: re-aim, or advance the cycle when it lands on the same set.
  pickFromHitsOrCycle: (hits: readonly EntityHit[]) => void
  // Write the aimed reference into the armed mate slot. No-op when none is armed.
  commitAimToMateField: () => void
  // Ctrl+click: aim the next candidate. No-op on an empty set.
  cyclePickCandidate: () => void
  clearPickCandidates: () => void
  setPickScopeEntity: (entityKey: string | null) => void
  // Pointer moved: reveal the hovered entities' anchors; Ctrl narrows the scope.
  setHoverHits: (hits: readonly EntityHit[], ctrlKey: boolean) => void
  clearHover: () => void
  // Add or remove one B-rep entity from the measurement selection.
  toggleSelection: (entityKey: string) => void
  clearSelection: () => void
  // The lone entity highlighted under the cursor in B-rep selection mode.
  setHoveredEntity: (entityKey: string | null) => void
  setShowPickDebug: (enabled: boolean) => void
  // The reference a mate pick chip would commit right now; the set is retained.
  activePickCandidate: () => MateRef | null
  /** The settled pose of one part: the last solve carried by any committed drag
   *  that has not been re-meshed yet. This is the ONLY pose read allowed outside
   *  the drag lifecycle. Undefined for an unknown handle. */
  settledPose: (handle: string) => Transform3D | undefined
  /** The settled poses of every instance, keyed by handle. Callers that bake a
   *  whole document use this; callers that place one part use settledPose. */
  settledPoses: () => Record<string, Transform3D>
  // Publish the triad gesture in progress, or null to retire it.
  setGizmoDrag: (drag: GizmoDragState | null) => void
  // Pointer-down on a part body or its triad. No-op for a `fixed` instance.
  beginPartManipulation: (handle: string) => boolean
  /**
   * Pointer-down on a part body: begin a solver-driven grab, capturing the model
   * point under the cursor. `worldGrab` is that point in world space. No-op for a
   * `fixed` instance.
   */
  beginBodyDrag: (handle: string, worldGrab: Vec3) => boolean
  // Move where the grabbed point is pulled to; re-solves so the part tracks it.
  setDragTarget: (target: Vec3) => void
  /** Fold the drag solve's grabbed-part pose into the session (what it draws and
   *  commits), so the part shows the SOLVED pose rather than the raw cursor. */
  setDragSolvedPose: (solvedGrab: Transform3D) => void
  // `delta` / `angle` are measured from pointer-down, not from the last frame.
  dragPartTranslate: (delta: Vec3) => void
  rotatePartGizmo: (axis: Vec3, angle: number, pivot?: Vec3) => void
  // Pointer-up: write the seed transform, then re-solve once if it moved.
  endPartManipulation: () => void
  cancelPartManipulation: () => void
  /**
   * The [Delete] key's target: remove whatever the tree has selected, which is
   * the one `subject`. No-op when nothing is selected.
   */
  deleteSelected: () => void
  /**
   * Remove one named subject. The tree's row buttons route here, so the [Delete]
   * key and a row delete share the one implementation (which runs the delete
   * operation through the assembly operation table). Closes an editor that
   * named the deleted subject.
   */
  deleteSubject: (subject: AssemblySubject) => void
}

export const useAssemblyStore = create<AssemblyEditorState>((set, get) => ({
  ...createDefaultAssemblyEditorData(),
  setSnapshot: (data) => set((prev) => {
    const prevRec = prev as unknown as Record<string, unknown>
    const merged = { ...data } as unknown as Record<string, unknown>
    for (const field of STORE_OWNED_FIELDS) {
      merged[field] = prevRec[field]
    }
    // An unchanged part list keeps the reference it already had, so a doc edit
    // that moved no part cannot churn everything downstream of `instances`.
    // The updater stays pure: it reads `prev` and `data`, writes only the object
    // it just built, and re-running it is a fixed point.
    if (sameInstances(prev.instances, data.instances)) merged.instances = prev.instances
    // A doc change (undo, reload, live edit) can retire the edited subject. The
    // reducer clears it only when the named instance or mate is gone, so an
    // unrelated snapshot leaves an open editor alone.
    const nextSubject = reduceEditingSubject(prev.editingSubject, { type: 'subject_removed', doc: data.doc })
    if (nextSubject !== prev.editingSubject) merged.editingSubject = nextSubject
    return merged as unknown as AssemblyEditorData
  }),
  // A part pick replaces the subject wholesale, which is what drops any
  // previously selected mate: there is one slot, so exclusion is structural
  // rather than a pair of clears that can disagree.
  selectPart: (handle) => set({ subject: handle === null ? null : { kind: 'part', handle } }),

  openInstanceEditor: (handle) => set(prev => ({
    editingSubject: reduceEditingSubject(prev.editingSubject, { type: 'open_instance', handle }),
  })),
  openMateEditor: (id) => set(prev => ({
    editingSubject: reduceEditingSubject(prev.editingSubject, { type: 'open_mate', id }),
  })),
  closeEditor: () => set(prev => ({
    editingSubject: reduceEditingSubject(prev.editingSubject, { type: 'close' }),
  })),

  clearAssemblyHistory: () => set({ undoStack: [], redoStack: [] }),

  resetTransientAssemblyState: () => set(() => {
    const next: Record<string, unknown> = {}
    const defaults = createDefaultAssemblyEditorData() as unknown as Record<string, unknown>
    for (const field of STORE_OWNED_FIELDS) {
      // The stacks survive here: a doc load clears them via clearAssemblyHistory,
      // and the reset is about interaction residue, not history.
      if (field === 'undoStack' || field === 'redoStack') continue
      next[field] = defaults[field]
    }
    return next as Partial<AssemblyEditorData>
  }),

  // The disarm is a required coupling, not incidental: the [Delete] path routes
  // through here so a mate delete leaves no armed field pointing at the vanished
  // feature, and the same for closing/cancelling a mate editor.
  selectMate: (id) => {
    get().setActiveMateField(null)  // leaving a mate settles the solve its picks owe
    set({ subject: id === null ? null : { kind: 'mate', id } })
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
  setSolveResult: (result) => set({
    ...result,
    // A re-solve can retire the anchors the aimed candidate named (a rebuilt
    // bundle sheds an anchor its feature deleted), so the stale set is dropped
    // rather than left pointing into the previous rev. The hover goes with it:
    // its entity keys are positional and a rebuilt body renumbers them. The
    // B-rep entity selection is positional too, so it clears for the same reason.
    pickCandidates: [], pickIndex: -1, hoverHits: [],
    entitySelection: new Set(), hoveredEntity: null,
    // Every body comes back baked at its solved pose, which is what the settling
    // offsets were standing in for until now.
    settlingOffsets: {},
    // The pick snapshot landed with a solve: record the pose it was baked at so
    // the ID buffer can be offset onto wherever the parts are drawn.
    pickGeometryPose: result.transforms,
  }),

  setDragSolveResult: (result) => set((prev) => ({
    transforms: { ...prev.transforms, ...result.transforms },
    bodies: { ...prev.bodies, ...result.bodies },
    edgeCurves: { ...prev.edgeCurves, ...result.edgeCurves },
    solveStatus: result.solveStatus,
    // The parts this tick re-posed are re-baked with it; only a part it left
    // alone (the grabbed one) still owes its offset.
    settlingOffsets: Object.fromEntries(
      Object.entries(prev.settlingOffsets).filter(([handle]) => !(handle in result.transforms)),
    ),
  })),

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
    // Refuse a pick that would make both refs name the same part: the solver
    // guards against this too (a mate needs two different parts), but doing
    // it here gives the user feedback at the click instead of after the next
    // solve, and does not leave a half-armed field pointing at a dead end.
    const mate = findMate(doc, activeMateField.featureId)
    const otherField: MateRefField = activeMateField.field === 'ref_a' ? 'ref_b' : 'ref_a'
    const otherRef = mate?.[otherField]
    if (otherRef && otherRef.part === ref.part) return
    // The pick that completes (or re-aims) the pair freezes the on-screen
    // orientation into the mate's authored flip/angle, measured against the
    // solved anchor table this scene is drawn from. Authored here, held by the
    // solver forever: this is the WYSIWYG half of the no-seed-state contract
    // (see utils/mateCapture.ts).
    const refA = activeMateField.field === 'ref_a' ? ref : mate?.ref_a
    const refB = activeMateField.field === 'ref_b' ? ref : mate?.ref_b
    const patch = mate ? captureMateOrientationPatch(mate, refA, refB, get().anchors) : null
    callbacks.mutateDocSession(ASSEMBLY_UNDO_LABELS.pickMateReference, d => {
      const withRef = setMateRef(d, activeMateField.featureId, activeMateField.field, ref)
      return patch ? updateMate(withRef, activeMateField.featureId, patch) : withRef
    })
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

  toggleSelection: (entityKey) => set((prev) => {
    const next = new Set(prev.entitySelection)
    if (next.has(entityKey)) next.delete(entityKey)
    else next.add(entityKey)
    return { entitySelection: next }
  }),

  clearSelection: () => set((prev) => (prev.entitySelection.size === 0 ? {} : { entitySelection: new Set() })),

  // A hover that lands on the same entity re-sets an equal string, which Zustand
  // treats as a no-op; only a real change re-renders the highlight.
  setHoveredEntity: (entityKey) => set((prev) => (
    prev.hoveredEntity === entityKey ? {} : { hoveredEntity: entityKey }
  )),

  setShowPickDebug: (enabled) => set({ showPickDebug: enabled }),

  activePickCandidate: () => {
    const { pickCandidates, pickIndex } = get()
    return pickIndex >= 0 ? pickCandidates[pickIndex] ?? null : null
  },

  settledPose: (handle) => settledTransforms(get().transforms, get().settlingOffsets)[handle],
  settledPoses: () => settledTransforms(get().transforms, get().settlingOffsets),

  setGizmoDrag: (drag) => set({ gizmoDrag: drag }),

  beginPartManipulation: (handle) => {
    const doc = get().doc
    if (!doc) return false
    const session = beginManipulation(doc, handle)
    if (!session) return false
    set({ manipulation: session })
    return true
  },

  beginBodyDrag: (handle, worldGrab) => {
    const { doc } = get()
    if (!doc) return false
    // The grab landed on where the part is DRAWN: its settled pose, falling back
    // to the doc seed before the first solve.
    const drawn = get().settledPose(handle) ?? findInstance(doc, handle)?.transform
    if (!drawn) return false
    const session = beginBodyManipulation(doc, handle, worldGrab, drawn)
    if (!session) return false
    set({ manipulation: session })
    return true
  },

  setDragTarget: (target) => {
    const { manipulation } = get()
    if (!manipulation?.dragObjective) return
    set({ manipulation: setDragTargetOnSession(manipulation, target) })
    // Every move re-solves: the grabbed part and the rest of the assembly are
    // solved together against the drag objective, so the whole scene stays rigid.
    callbacks?.requestSolve()
  },

  setDragSolvedPose: (solvedGrab) => {
    const { manipulation } = get()
    if (!manipulation) return
    const drawnBaked = get().settledPose(manipulation.handle) ?? manipulation.seed
    set({ manipulation: setDragSolvedPoseOnSession(manipulation, solvedGrab, drawnBaked) })
  },

  // Every move re-solves so the rest of the assembly follows the dragged part
  // live (the host runs one coalesced solve per burst, pinning this part where
  // the pointer put it). A click that never leaves the seed pose asks for no
  // solve, so a plain select stays free.
  dragPartTranslate: (delta) => {
    const { manipulation } = get()
    if (!manipulation) return
    const next = dragTranslate(manipulation, delta)
    set({ manipulation: next })
    if (!transformsEqual(next.current, next.seed)) callbacks?.requestSolve()
  },

  rotatePartGizmo: (axis, angle, pivot) => {
    const { manipulation } = get()
    if (!manipulation) return
    const next = gizmoRotate(manipulation, axis, angle, pivot)
    set({ manipulation: next })
    if (!transformsEqual(next.current, next.seed)) callbacks?.requestSolve()
  },

  endPartManipulation: () => {
    const { manipulation, doc } = get()
    // The drag state is retired here rather than by the caller so that a session
    // ending by any route leaves the triad whole again; a stale gizmoDrag would
    // keep it narrowed to a gesture that is no longer running.
    set({ manipulation: null, gizmoDrag: null })
    if (!manipulation || !doc || !callbacks) return
    // The grabbed part's own drawn pose is what the drag offset was drawn over,
    // so the commit must compose against it, not against the doc seed the mates
    // may long since have pulled the part away from.
    const solved = get().settledPoses()
    const solvedGrab = solved[manipulation.handle]
    const { changed } = commitManipulation(doc, manipulation, solvedGrab)
    // A click that never moved the part must not dirty the doc or re-solve.
    if (!changed) return
    // The doc now holds the dragged pose but the bodies are still baked at the
    // pre-drag one, and the re-solve that fixes that is a round trip away.
    // Handing the drag's offset over to the render as a settling offset is what
    // keeps the part where the user dropped it; clearing it here made the part
    // snap back to its pre-drag pose until the solve returned.
    set(prev => ({
      settlingOffsets: {
        ...prev.settlingOffsets,
        [manipulation.handle]: composeTransforms(
          manipulationDelta(manipulation),
          prev.settlingOffsets[manipulation.handle] ?? IDENTITY_TRANSFORM,
        ),
      },
    }))
    // Bake every follower's live-solved pose into its seed before committing the
    // grabbed part's new seed. A drag otherwise writes back only the grabbed
    // part, leaving the followers' seeds at their placement poses; the cold
    // pointer-up solve would then restart from those stale seeds and could
    // relax the whole assembly off the pose the drag just previewed. Baking
    // first (commitManipulation then overwrites the grabbed part) keeps the
    // seeds in step with the screen, the same discipline the fix toggle uses.
    callbacks.mutateDoc(ASSEMBLY_UNDO_LABELS.movePart, d => commitManipulation(bakeSolvedTransforms(d, solved), manipulation, solvedGrab).doc)
    callbacks.requestSolve()  // one cold solve per pointer-up; no per-frame mate solve
  },

  cancelPartManipulation: () => {
    const { manipulation } = get()
    // The live solves moved the followers to track the abandoned drag; a solve
    // against the untouched doc puts them back at their pre-drag poses. The
    // grabbed part restores itself, drawn from its own bodies once the offset is
    // gone. A session that never moved has nothing to restore.
    const moved = manipulation != null && !transformsEqual(manipulation.current, manipulation.seed)
    // A cancelled-but-moved session leaves followers at live-solved poses with a
    // restoring re-solve pending. The offset the drawer carries covers the
    // followers the abandoned drag moved until that solve lands.
    set({ manipulation: null, gizmoDrag: null })
    if (moved) callbacks?.requestSolve()
  },

  // The one delete implementation. The document mutation is the assembly
  // operation table's delete_part/delete_mate cell (bake, one-shot, solve), so a
  // row delete and the [Delete] key cannot drift; this wrapper adds the
  // selection and editor cleanup the document policy does not know about. A
  // deleted part's referencing mates are left in place on purpose
  // (removeInstance's contract): they surface as stale at the next solve rather
  // than being silently cascaded away.
  deleteSelected: () => {
    const subject = get().subject
    if (subject) get().deleteSubject(subject)
  },

  deleteSubject: (subject) => {
    const { doc, editingSubject } = get()
    if (!doc || !callbacks) return
    const host = {
      doc,
      transforms: get().settledPoses(),
      mutateSession: callbacks.mutateDocSession,
      mutateOneShot: callbacks.mutateDoc,
      requestSolve: callbacks.requestSolve,
      requestSolveOrDefer: () => get().requestSolveOrDefer(),
    }
    if (subject.kind === 'mate') {
      runAssemblyOperation('delete_mate', subject.id, host)
      // Clearing through the subject setter, not a bare `set`, so the mate field
      // this selection may have armed is disarmed too: a delete that leaves the
      // armed field pointing at the just-deleted mate strands a dangling
      // reference and an owed solve that never lands.
      get().selectMate(null)
      // An editor on the deleted subject has no doc to edit any more, so close
      // it. An editor on a DIFFERENT subject is deliberately left open: the
      // delete's one-shot already committed its session, and the user did not
      // ask to stop editing it.
      if (editingSubject.kind === 'mate' && editingSubject.id === subject.id) get().closeEditor()
    } else {
      runAssemblyOperation('delete_part', subject.handle, host)
      set({ subject: null })
      if (editingSubject.kind === 'instance' && editingSubject.handle === subject.handle) get().closeEditor()
    }
  },
}))
