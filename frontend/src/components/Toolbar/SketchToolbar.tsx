import { useMemo } from 'react'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { CORE_KEYBINDINGS } from '@/utils/core/commandRegistry'
import { useCommandRegistry } from '@/contexts/CommandRegistryContext'
import { openFilletDialog, openOffsetDialog, openPatternDialog } from '@/pages/commandEntries'
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
  // The page owns the file picker and the mutation; the toolbar only arms the
  // gesture, exactly like the header's Import STEP button.
  onImportDxf: () => void
  // True only while the open edit is a sketch: the page derives this from the
  // editing feature, so a feature edit keeps the import greyed out.
  canImportDxf: boolean
}

const mirrorKey = CORE_KEYBINDINGS.find(b => b.command === 'mirror_entities')?.key.toUpperCase()
const filletKey = CORE_KEYBINDINGS.find(b => b.command === 'fillet_corners')?.key.toUpperCase()
const patternKey = CORE_KEYBINDINGS.find(b => b.command === 'pattern_entities')?.key.toUpperCase()
const constructionKey = CORE_KEYBINDINGS.find(b => b.command === 'toggle_construction')?.key.toUpperCase()

export default function SketchToolbar({ onResetViewport, onImportDxf, canImportDxf }: SketchToolbarProps) {
  const registry = useCommandRegistry()
  const activeTool = useSketchEditorStore(s => s.activeTool)
  const drag = useSketchEditorStore(s => s.drag)
  // A render token for the selection. The registry's verdicts read the live
  // store, so the component must re-run them when the selection changes; the
  // token is their dependency, the ids themselves are not rendered here.
  const selectionToken = useSketchEditorStore(s => Array.from(s.normalSelection).join('|'))
  // The mirror verdict also reads which lines are construction, so a toggle or
  // its undo under an unchanged selection must re-run it as well.
  const constructionKeys = useSketchEditorStore(s => s.constructionEntityKeys)
  // The fillet verdict reads the published corner map, so a solve or edit that
  // changes the partners must re-run it even under an unchanged selection.
  const filletCornerMap = useSketchEditorStore(s => s.filletCornerMap)
  const isDragActive = drag !== null
  // The disabled verdicts come from the same specs the clicks run through, so
  // a button can no longer disagree with its command. The token is a
  // deliberate dependency even though the memo bodies do not read it: the
  // verdicts read the live store through the registry, and the token is what
  // re-runs them when the selection changes.
  const mirrorDisabled = useMemo(
    () => registry.enabled('mirror_entities') !== true,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- selectionToken and constructionKeys are the invalidation keys for the verdict read
    [registry, selectionToken, constructionKeys],
  )
  const offsetDisabled = useMemo(
    () => registry.enabled('apply_offset') !== true,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- selectionToken is the invalidation key for the verdict read
    [registry, selectionToken],
  )
  const filletDisabled = useMemo(
    () => registry.enabled('fillet_corners') !== true,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- selectionToken and filletCornerMap are the invalidation keys for the verdict read
    [registry, selectionToken, filletCornerMap],
  )
  const patternDisabled = useMemo(
    () => registry.enabled('pattern_entities') !== true,
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
        title={mirrorKey ? `Mirror selection (${mirrorKey})` : 'Mirror selection'}
        icon={iconUrl('feature-mirror')}
        disabled={mirrorDisabled}
        onClick={() => registry.execute('mirror_entities')}
        handle="toolbar:mirror_entities"
      />

      <ToolbarButton
        title={filletKey ? `Fillet corners (${filletKey})` : 'Fillet corners'}
        icon={iconUrl('feature-fillet')}
        disabled={filletDisabled}
        onClick={() => openFilletDialog(radius => { registry.execute('fillet_corners', { radius }) })}
        handle="toolbar:fillet_corners"
      />

      <ToolbarButton
        title={patternKey ? `Pattern entities along X (${patternKey})` : 'Pattern entities along X'}
        icon={iconUrl('feature-pattern')}
        disabled={patternDisabled}
        onClick={() => openPatternDialog((count, pitch) => { registry.execute('pattern_entities', { count, pitch }) })}
        handle="toolbar:pattern_entities"
      />

      <ToolbarButton
        title="Offset selected entities"
        icon={iconUrl('toolbar-offset')}
        disabled={offsetDisabled}
        onClick={() => openOffsetDialog(distance => { registry.execute('apply_offset', { distance }) })}
        handle="toolbar:apply_offset"
      />

      <ToolItem def={TOOL_DEFS.project} />

      <ToolbarButton
        title={canImportDxf ? 'Import DXF into this sketch' : 'Open a sketch to import a DXF'}
        icon={iconUrl('icon-upload')}
        disabled={!canImportDxf}
        onClick={onImportDxf}
        handle="toolbar:import_dxf"
      />

      <div className="toolbar-separator" />

      <ConstraintTools />
    </>
  )
}
