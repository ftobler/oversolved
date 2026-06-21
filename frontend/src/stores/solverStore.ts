import { create } from 'zustand'

interface SolverStoreState {
  isSolving: boolean
  setIsSolving: (solving: boolean) => void
}

export const useSolverStore = create<SolverStoreState>((set) => ({
  isSolving: false,
  setIsSolving: (solving) => set({ isSolving: solving }),
}))
