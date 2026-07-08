import { create } from 'zustand'
import type { AssemblyDoc, PartInstance, MateFeatureDef, Transform3D, BodyResult } from '@/types/cad'

type UndoEntry = { doc: unknown; mutation: unknown }

export interface AssemblyEditorData {
  doc: AssemblyDoc | null
  instances: PartInstance[]
  mates: MateFeatureDef[]
  transforms: Record<string, Transform3D>
  bodies: Record<string, BodyResult>
  pickBodies: Record<string, BodyResult>
  activePartHandle: string | null
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
  isSolving: false,
  solveError: null,
  undoStack: [],
  redoStack: [],
}

// Fields owned exclusively by the store (not overwritten by setSnapshot).
const STORE_OWNED_FIELDS = ['activePartHandle'] as const

interface AssemblyEditorState extends AssemblyEditorData {
  setSnapshot: (data: AssemblyEditorData) => void
  setActivePartHandle: (handle: string | null) => void
  setIsSolving: (solving: boolean) => void
  setSolveError: (error: string | null) => void
}

export const useAssemblyStore = create<AssemblyEditorState>((set) => ({
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
  setIsSolving: (solving) => set({ isSolving: solving }),
  setSolveError: (error) => set({ solveError: error }),
}))
