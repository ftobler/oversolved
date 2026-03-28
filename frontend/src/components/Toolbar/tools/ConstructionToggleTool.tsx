import { executeCommand } from '../../../stores/commandRegistry'
import ToolbarButton from '../ToolbarButton'
import toolbarConstructionIcon from '../../../assets/icons/constraint-line-swap.svg'

export default function ConstructionToggleTool() {
  return (
    <ToolbarButton
      title="Toggle Construction (Q)"
      icon={toolbarConstructionIcon}
      onClick={() => executeCommand('toggle_construction')}
    />
  )
}
