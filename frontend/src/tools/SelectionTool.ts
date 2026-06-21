import type { Tool, ToolCategory, ToolContext, ToolHandlers } from '@/registry/toolRegistry'
import { toolModeHandlers } from '@/tools/toolMode'

export interface SelectionToolContext extends ToolContext {
  hoveredSelectionId: string | null
  normalSelection: Set<string>
  clearNormalSelection: () => void
  toggleNormalSelection: (id: string) => void
}

export interface SelectionTool extends Tool {
  readonly supportsMulti: boolean
}

export function createSelectionTool(): SelectionTool {
  const handlers: ToolHandlers<SelectionToolContext> = {
    onClick: (_e, _worldPt, context) => {
      const hoverId = context.hoveredSelectionId
      if (hoverId) {
        context.toggleNormalSelection(hoverId)
      } else {
        context.clearNormalSelection()
      }
    },
  }

  return {
    id: 'select',
    label: 'Select',
    category: 'selection' as ToolCategory,
    supportsMulti: true,
    showInToolbar: true,

    ...toolModeHandlers('select'),

    handlers,
  }
}
