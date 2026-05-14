import { create } from 'zustand'

export type WsStatus = 'connecting' | 'open' | 'closed'

interface SolverStoreState {
  isSolving: boolean
  setIsSolving: (solving: boolean) => void
  wsStatus: WsStatus
  setWsStatus: (status: WsStatus) => void
}

export const useSolverStore = create<SolverStoreState>((set) => ({
  isSolving: false,
  setIsSolving: (solving) => set({ isSolving: solving }),
  wsStatus: 'closed',
  setWsStatus: (status) => set({ wsStatus: status }),
}))
