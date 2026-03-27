import { useSketchEditorStore } from '../../../stores/sketchEditorStore'
import { TOOLBAR_CONSTRAINTS } from '../../../registry'
import type { ConstraintDef } from '../../../registry'
import ToolbarButton from '../ToolbarButton'
import { iconUrl, shortcutHint } from './toolUtils'

/** Renders constraint tools from the constraint registry */
export default function ConstraintTools() {
  const applyConstraint = useSketchEditorStore(s => s.applyConstraint)

  return (
    <>
      {TOOLBAR_CONSTRAINTS.map((def: ConstraintDef) => (
        <ToolbarButton
          key={def.kind}
          title={`${def.label}${shortcutHint(def)}`}
          icon={iconUrl(def.toolbarIcon!)}
          onClick={() => applyConstraint(def.kind)}
        />
      ))}
    </>
  )
}
