import { create } from 'zustand'

/**
 * Developer-only settings that tweak solver behaviour for debugging. Not
 * persisted and not part of the document; they reset on reload.
 */
interface DevSettingsState {
  // When on, the rebuild button runs the extra `validateIncremental` fresh
  // full rebuild (mirrors builder.ts:925) to diff incremental-vs-full and
  // populate the validation badge. That doubles the solve, so it is off by
  // default: a normal rebuild is a single build.
  validateOnRebuild: boolean
  setValidateOnRebuild: (v: boolean) => void
}

export const useDevSettingsStore = create<DevSettingsState>((set) => ({
  validateOnRebuild: false,
  setValidateOnRebuild: (v) => set({ validateOnRebuild: v }),
}))
