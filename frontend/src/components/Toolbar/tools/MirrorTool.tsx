import { executeCommand, CORE_KEYBINDINGS } from '../../../stores/commandRegistry'
import ToolbarButton from '../ToolbarButton'
import mirrorIcon from '../../../assets/icons/feature-mirror.svg'
import { useSketchEditorStore } from '../../../stores/sketchEditorStore'

export default function MirrorTool() {
  const normalSelection = useSketchEditorStore(s => s.normalSelection)
  const activeTool = useSketchEditorStore(s => s.activeTool)
  const hasEntities = Array.from(normalSelection).some(id => id.startsWith('entity:'))
  const isActive = activeTool === 'mirror'
  const mirrorKey = CORE_KEYBINDINGS.find(b => b.command === 'set_tool_mirror')?.key.toUpperCase()
  return (
    <ToolbarButton
      title={mirrorKey ? `Mirror (${mirrorKey})` : 'Mirror'}
      icon={mirrorIcon}
      active={isActive}
      disabled={!hasEntities && !isActive}
      onClick={() => executeCommand('set_tool_mirror')}
    />
  )
}
