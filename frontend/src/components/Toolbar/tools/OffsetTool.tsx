import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { executeCommand } from '@/stores/commandRegistry'
import ToolbarButton from '@/components/Toolbar/ToolbarButton'
import toolbarOffsetIcon from '@/assets/icons/toolbar-offset.svg'

// Offset is a selection action (not a draw mode): it operates on the currently
// selected sketch entities, so it is disabled until at least one is selected.
export default function OffsetTool() {
  const normalSelection = useSketchEditorStore(s => s.normalSelection)
  const hasEntities = Array.from(normalSelection).some(id => id.startsWith('entity:'))

  return (
    <ToolbarButton
      title="Offset selected entities"
      icon={toolbarOffsetIcon}
      disabled={!hasEntities}
      onClick={() => executeCommand('apply_offset')}
    />
  )
}
