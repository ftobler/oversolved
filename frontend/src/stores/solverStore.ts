import { create } from 'zustand'

interface SolverStoreState {
  isSolving: boolean
  setIsSolving: (solving: boolean) => void
  onCancelSolve: (() => void) | null
  setOnCancelSolve: (fn: (() => void) | null) => void
}

export const useSolverStore = create<SolverStoreState>((set) => ({
  isSolving: false,
  setIsSolving: (solving) => set({ isSolving: solving }),
  onCancelSolve: null,
  setOnCancelSolve: (fn) => set({ onCancelSolve: fn }),
}))
