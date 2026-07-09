import { create } from 'zustand'
import type { AssemblyDoc, PartInstance, MateFeatureDef, Transform3D, BodyResult } from '@/types/cad'
import type { Vec3 } from '@/utils/transform3d'
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
  mates: MateFeatureDef[]
  transforms: Record<string, Transform3D>
  bodies: Record<string, BodyResult>
  pickBodies: Record<string, BodyResult>
  activePartHandle: string | null
  selectedPartHandle: string | null
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
  transforms: {},
  bodies: {},
  pickBodies: {},
  activePartHandle: null,
  selectedPartHandle: null,
  manipulation: null,
  isSolving: false,
  solveError: null,
  undoStack: [],
  redoStack: [],
}

// Fields owned exclusively by the store (not overwritten by setSnapshot).
const STORE_OWNED_FIELDS = ['activePartHandle', 'selectedPartHandle', 'manipulation'] as const

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
  setIsSolving: (solving: boolean) => void
  setSolveError: (error: string | null) => void
  setSolveResult: (transforms: Record<string, Transform3D>, bodies: Record<string, BodyResult>) => void
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
  setIsSolving: (solving) => set({ isSolving: solving }),
  setSolveError: (error) => set({ solveError: error }),
  setSolveResult: (transforms, bodies) => set({ transforms, bodies }),

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
