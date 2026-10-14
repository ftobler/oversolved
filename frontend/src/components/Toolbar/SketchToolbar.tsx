import { useMemo } from 'react'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { CORE_KEYBINDINGS } from '@/utils/core/commandRegistry'
import { useCommandRegistry } from '@/contexts/CommandRegistryContext'
import { openOffsetDialog } from '@/pages/commandEntries'
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
  const registry = useCommandRegistry()
  const activeTool = useSketchEditorStore(s => s.activeTool)
  const drag = useSketchEditorStore(s => s.drag)
  // A render token for the selection. The registry's verdicts read the live
  // store, so the component must re-run them when the selection changes; the
  // token is their dependency, the ids themselves are not rendered here.
  const selectionToken = useSketchEditorStore(s => Array.from(s.normalSelection).join('|'))
  const isDragActive = drag !== null
  const isMirrorActive = activeTool === 'mirror'
  // The disabled verdicts come from the same specs the clicks run through, so
  // a button can no longer disagree with its command. The token is a
  // deliberate dependency even though the memo bodies do not read it: the
  // verdicts read the live store through the registry, and the token is what
  // re-runs them when the selection changes.
  const mirrorDisabled = useMemo(
    () => registry.enabled('set_tool_mirror') !== true,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- selectionToken is the invalidation key for the verdict read
    [registry, selectionToken, isMirrorActive],
  )
  const offsetDisabled = useMemo(
    () => registry.enabled('apply_offset') !== true,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- selectionToken is the invalidation key for the verdict read
    [registry, selectionToken],
  )

  return (
    <>
      <ToolbarButton
        title="Drag (G)"
        icon={iconUrl('toolbar-select')}
        onClick={() => registry.execute('set_tool_drag')}
        active={isDragActive || activeTool === 'drag' || activeTool === null}
        handle="toolbar:set_tool_drag"
      />

      <ToolbarButton
        title="Reset Viewport"
        icon={viewportResetIcon}
        onClick={onResetViewport}
        handle="toolbar:reset_viewport"
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
        onClick={() => registry.execute('toggle_construction')}
        handle="toolbar:toggle_construction"
      />

      <ToolbarButton
        title={mirrorKey ? `Mirror (${mirrorKey})` : 'Mirror'}
        icon={iconUrl('feature-mirror')}
        active={isMirrorActive}
        disabled={mirrorDisabled}
        onClick={() => registry.execute('set_tool_mirror')}
        handle="toolbar:set_tool_mirror"
      />

      <ToolbarButton
        title="Offset selected entities"
        icon={iconUrl('toolbar-offset')}
        disabled={offsetDisabled}
        onClick={() => openOffsetDialog(distance => { registry.execute('apply_offset', { distance }) })}
        handle="toolbar:apply_offset"
      />

      <ToolItem def={TOOL_DEFS.project} />

      <div className="toolbar-separator" />

      <ConstraintTools />
    </>
  )
}
