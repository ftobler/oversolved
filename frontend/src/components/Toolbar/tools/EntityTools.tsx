import { useSketchEditorStore } from '../../../stores/sketchEditorStore'
import { TOOLBAR_ENTITIES } from '../../../registry'
import type { EntityDef } from '../../../registry'
import ToolbarButton from '../ToolbarButton'
import { iconUrl } from './toolUtils'

/** Renders entity drawing tools from the entity registry (point, line, circle, arc) */
export default function EntityTools() {
  const activeTool = useSketchEditorStore(s => s.activeTool)
  const setActiveTool = useSketchEditorStore(s => s.setActiveTool)

  return (
    <>
      {TOOLBAR_ENTITIES.map((def: EntityDef) => (
        <ToolbarButton
          key={def.kind}
          title={def.label}
          icon={iconUrl(def.toolbarIcon!)}
          onClick={() => setActiveTool(def.activeTool!)}
          active={activeTool === def.activeTool}
        />
      ))}
    </>
  )
}
