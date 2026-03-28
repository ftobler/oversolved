import { executeCommand, CORE_KEYBINDINGS } from '../../../stores/commandRegistry'
import ToolbarButton from '../ToolbarButton'
import toolbarConstructionIcon from '../../../assets/icons/constraint-line-swap.svg'

const constructionKey = CORE_KEYBINDINGS.find(b => b.command === 'toggle_construction')?.key.toUpperCase()

export default function ConstructionToggleTool() {
  return (
    <ToolbarButton
      title={constructionKey ? `Toggle Construction (${constructionKey})` : 'Toggle Construction'}
      icon={toolbarConstructionIcon}
      onClick={() => executeCommand('toggle_construction')}
    />
  )
}
