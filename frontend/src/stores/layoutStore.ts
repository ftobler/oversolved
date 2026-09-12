import { create } from 'zustand'
import type { PanelId } from '@/components/layout/panelRegistry'

// Which activity-bar panel is visible. Lifted out of the host because it is
// genuinely shared: the no-entry workspace route defaults it to 'workspace',
// the editor routes default it to 'document', and C6's origins panel reads it.
// It is the only view value lifted; scroll position stays in the DOM.
//
// `visited` records the panels that have ever been active, so the host can
// lazy-mount the workspace tree on first activation without an effect that sets
// state (the activation itself is the external event that records it).
interface LayoutState {
  activePanel: PanelId
  visited: PanelId[]
  setPanel: (panel: PanelId) => void
}

export const useLayoutStore = create<LayoutState>(set => ({
  activePanel: 'document',
  visited: [],
  setPanel: panel => set(state => ({
    activePanel: panel,
    visited: state.visited.includes(panel) ? state.visited : [...state.visited, panel],
  })),
}))
