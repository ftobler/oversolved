import type { ReactNode } from 'react'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { executeCommand, CORE_KEYBINDINGS } from '@/utils/core/commandRegistry'
import ToolbarButton from '@/components/Toolbar/ToolbarButton'
import { iconUrl } from './toolUtils'
import type { ToolDef } from './toolsConfig'

function useActiveTool() {
  return useSketchEditorStore(s => s.activeTool)
}

export function ToolItem({ def, isActive, isDisabled, children }: {
  def: ToolDef
  isActive?: boolean
  isDisabled?: boolean
  children?: ReactNode
}) {
  const activeTool = useActiveTool()

  const shortcutKey = def.shortcutCommand
    ? CORE_KEYBINDINGS.find(b => b.command === def.shortcutCommand)?.key.toUpperCase()
    : undefined
  const title = shortcutKey ? `${def.label} (${shortcutKey})` : def.label

  return (
    <>
      <ToolbarButton
        title={title}
        icon={iconUrl(def.icon)}
        onClick={() => executeCommand(def.command)}
        active={isActive ?? (def.activeTool !== undefined && activeTool === def.activeTool)}
        disabled={isDisabled ?? false}
      />
      {children}
    </>
  )
}
