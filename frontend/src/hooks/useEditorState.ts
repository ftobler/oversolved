// React binding for the L2 editor-state store (stores/editorState.ts). The
// store itself is vanilla and headless; this module is the only place React
// enters its read path. The returned hook also carries the store's imperative
// API (getState/setState/subscribe) so callers that run outside render -- and
// the test suites that drive the store directly -- have one import.
import { useStore } from 'zustand'
import { editorState, type EditorState } from '@/stores/editorState'

export { editorState, clampRollback, DEFAULT_EDITOR_STATE } from '@/stores/editorState'

function useEditorStateImpl<T>(selector: (state: EditorState) => T): T {
  return useStore(editorState, selector)
}

export const useEditorState: typeof useEditorStateImpl & typeof editorState =
  Object.assign(useEditorStateImpl, editorState)
