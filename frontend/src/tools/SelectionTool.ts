import type { Tool, ToolCategory, ToolContext, ToolHandlers } from '@/registry/toolRegistry'

export interface SelectionToolContext extends ToolContext {
  internalHoverSelection: string | null
  normalSelection: Set<string>
  setInternalHoverSelection: (id: string | null) => void
  clearNormalSelection: () => void
  clearDynamicSelection: () => void
  toggleNormalSelection: (id: string) => void
  updateDynamicSelection: (hoverId: string | null) => void
}

export interface SelectionTool extends Tool {
  readonly supportsMulti: boolean
  readonly supportsDynamic: boolean
}

export function createSelectionTool(): SelectionTool {
  const handlers: ToolHandlers<SelectionToolContext> = {
    onPointerDown: () => {
      return null
    },

    onClick: (_e, _worldPt, context) => {
      const hoverId = context.internalHoverSelection
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
    supportsDynamic: true,
    showInToolbar: true,

    activate: () => {
    },

    deactivate: () => {
    },

    handlers,
  }
}
