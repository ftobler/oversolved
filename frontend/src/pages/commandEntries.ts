// The page-side surface of the part command table: the live editor state that
// feeds it and the value-dialog front ends. The command table itself is core
// data (session/partCommandSpecs), so a headless caller can register it without
// importing a React hook or an editor store.
import { useEditorState } from '@/hooks/useEditorState'
import type { EditorState } from '@/stores/editorState'
import { useSketchUiStore, type SketchUiState } from '@/stores/sketchEditorStore'

// Commands read from both stores: the editor state (selection, tools, draw
// state) and the sketch UI store (the pending value dialog). This merged
// getter keeps each command body one `st` away from whatever it needs.
export type SketchCommandState = EditorState & SketchUiState
export const getSketchState = (): SketchCommandState => ({
  ...useEditorState.getState(),
  ...useSketchUiStore.getState(),
})

export {
  PART_COMMAND_SPECS,
  cancelInProgressGesture,
  constraintCommandSpec,
  escapeStage,
  parsePatternInput,
  type EscapeStage,
  type PartCommandContext,
  type PartCommandSpec,
  type PartCommandState,
  type ShowMessagePayload,
} from '@/session/partCommandSpecs'
export { openFilletDialog, openOffsetDialog, openPatternDialog } from './commandDialogs'
