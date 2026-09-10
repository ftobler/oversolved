import { create } from 'zustand'

/**
 * Which editor owns the document currently mounted. `DocumentPage` knows the
 * document's kind, so it writes this once the kind is known and the key
 * dispatcher reads it here rather than parsing the route. That keeps the
 * registry router-free and gives the assembly keymap a home separate from the
 * sketch/feature split, which is keyed on the sketch store instead.
 */
export type ActiveEditor = 'part' | 'assembly'

interface EditorModeState {
  activeEditor: ActiveEditor | null
  setActiveEditor: (editor: ActiveEditor | null) => void
}

export const useEditorModeStore = create<EditorModeState>((set) => ({
  activeEditor: null,
  setActiveEditor: (activeEditor) => set({ activeEditor }),
}))
