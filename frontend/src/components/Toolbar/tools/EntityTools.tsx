import { useSketchEditorStore } from '../../../stores/sketchEditorStore'
import { TOOLBAR_ENTITIES } from '../../../registry'
import type { EntityDef } from '../../../registry'
import { executeCommand } from '../../../stores/commandRegistry'
import ToolbarButton from '../ToolbarButton'
import { iconUrl, shortcutHint } from './toolUtils'

// Renders entity drawing tools from the entity registry (point, line, circle, arc)
export default function EntityTools() {
  const activeTool = useSketchEditorStore(s => s.activeTool)

  return (
    <>
      {TOOLBAR_ENTITIES.map((def: EntityDef) => (
        <ToolbarButton
          key={def.kind}
          title={`${def.label}${shortcutHint(def)}`}
          icon={iconUrl(def.toolbarIcon!)}
          onClick={() => executeCommand('set_tool_' + def.activeTool)}
          active={activeTool === def.activeTool}
        />
      ))}
    </>
  )
}
