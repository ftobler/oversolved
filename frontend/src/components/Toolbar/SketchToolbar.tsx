import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { executeCommand, CORE_KEYBINDINGS } from '@/stores/commandRegistry'
import ToolbarButton from '@/components/Toolbar/ToolbarButton'
import { iconUrl } from '@/components/Toolbar/tools/toolUtils'
import EntityTools from '@/components/Toolbar/tools/EntityTools'
import ConstraintTools from '@/components/Toolbar/tools/ConstraintTools'
import NgonTool from '@/components/Toolbar/tools/NgonTool'
import { TOOL_DEFS } from '@/components/Toolbar/tools/toolsConfig'
import { ToolItem } from '@/components/Toolbar/tools/ToolItem'
import viewportResetIcon from '@/assets/icons/viewport-reset.svg'

interface SketchToolbarProps {
  onResetViewport: () => void
}

const mirrorKey = CORE_KEYBINDINGS.find(b => b.command === 'set_tool_mirror')?.key.toUpperCase()
const constructionKey = CORE_KEYBINDINGS.find(b => b.command === 'toggle_construction')?.key.toUpperCase()

export default function SketchToolbar({ onResetViewport }: SketchToolbarProps) {
  const activeTool = useSketchEditorStore(s => s.activeTool)
  const drag = useSketchEditorStore(s => s.drag)
  const normalSelection = useSketchEditorStore(s => s.normalSelection)
  const hasEntities = Array.from(normalSelection).some(id => id.startsWith('entity:'))

  const isDragActive = drag !== null
  const isMirrorActive = activeTool === 'mirror'

  return (
    <>
      <ToolbarButton
        title="Drag (G)"
        icon={iconUrl('toolbar-select')}
        onClick={() => executeCommand('set_tool_drag')}
        active={isDragActive || activeTool === 'drag' || activeTool === null}
      />

      <ToolbarButton
        title="Reset Viewport"
        icon={viewportResetIcon}
        onClick={onResetViewport}
      />

      <div className="toolbar-separator" />

      <ToolItem def={TOOL_DEFS.dimension} />

      <EntityTools />

      <ToolItem def={TOOL_DEFS.rectangle} />
      <ToolItem def={TOOL_DEFS.centerRect} />
      <NgonTool />

      <ToolbarButton
        title={constructionKey ? `Toggle Construction (${constructionKey})` : 'Toggle Construction'}
        icon={iconUrl('constraint-line-swap')}
        onClick={() => executeCommand('toggle_construction')}
      />

      <ToolbarButton
        title={mirrorKey ? `Mirror (${mirrorKey})` : 'Mirror'}
        icon={iconUrl('feature-mirror')}
        active={isMirrorActive}
        disabled={!hasEntities && !isMirrorActive}
        onClick={() => executeCommand('set_tool_mirror')}
      />

      <ToolbarButton
        title="Offset selected entities"
        icon={iconUrl('toolbar-offset')}
        disabled={!hasEntities}
        onClick={() => executeCommand('apply_offset')}
      />

      <ToolItem def={TOOL_DEFS.project} />

      <div className="toolbar-separator" />

      <ConstraintTools />
    </>
  )
}
