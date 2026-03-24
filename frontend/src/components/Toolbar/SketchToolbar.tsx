import { useSketchEditorStore } from '../../stores/sketchEditorStore'
import { TOOLBAR_CONSTRAINTS, TOOLBAR_ENTITIES } from '../../registry'
import type { ConstraintDef, EntityDef } from '../../registry'
import ToolbarButton from './ToolbarButton'

import toolbarRectangleIcon from '../../assets/icons/toolbar-rectangle.svg'
import toolbarDimensionIcon from '../../assets/icons/constraint-dimension.svg'
import toolbarConstructionIcon from '../../assets/icons/constraint-line-swap.svg'
import viewportResetIcon from '../../assets/icons/viewport-reset.svg'

// Eager-load all icon SVGs so we can look them up by filename at runtime.
const iconModules = import.meta.glob('../../assets/icons/*.svg', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>

function iconUrl(filename: string): string {
  return iconModules[`../../assets/icons/${filename}.svg`] ?? ''
}

function shortcutHint(def: ConstraintDef): string {
  return def.shortcut ? ` (${def.shortcut.toUpperCase()})` : ''
}

interface SketchToolbarProps {
  onResetViewport: () => void
}

export default function SketchToolbar({ onResetViewport }: SketchToolbarProps) {
  const activeTool = useSketchEditorStore(s => s.activeTool)
  const setActiveTool = useSketchEditorStore(s => s.setActiveTool)
  const applyConstraint = useSketchEditorStore(s => s.applyConstraint)
  const toggleConstruction = useSketchEditorStore(s => s.toggleConstruction)

  return (
    <>
      <ToolbarButton title="Reset Viewport" icon={viewportResetIcon} onClick={onResetViewport} />

      <div className="toolbar-separator" />

      <ToolbarButton
        title="Dimension (D)"
        icon={toolbarDimensionIcon}
        onClick={() => setActiveTool('dimension')}
        active={activeTool === 'dimension'}
      />

      {/* Drawing tools — derived from entity registry */}
      {TOOLBAR_ENTITIES.map((def: EntityDef) => (
        <ToolbarButton
          key={def.kind}
          title={def.label}
          icon={iconUrl(def.toolbarIcon!)}
          onClick={() => setActiveTool(def.activeTool!)}
          active={activeTool === def.activeTool}
        />
      ))}

      {/* Rectangle is a composite tool, not a single entity — stays manual */}
      <ToolbarButton
        title="Rectangle"
        icon={toolbarRectangleIcon}
        onClick={() => setActiveTool('rect')}
        active={activeTool === 'rect'}
      />

      <ToolbarButton title="Toggle Construction" icon={toolbarConstructionIcon} onClick={toggleConstruction} />

      <div className="toolbar-separator" />

      {/* Constraint buttons — derived from constraint registry */}
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
