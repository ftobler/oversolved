import type { Tool, ToolCategory, ToolContext, ToolHandlers } from '../registry/toolRegistry'

export interface SelectionToolContext extends ToolContext {
  toggleSelect: (id: string) => void
  toggleDynamicSelection: (id: string) => void
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

    onPointerUp: () => {
    },

    onPointerOver: (_e, _worldPt, context) => {
      if (context.isPointerDown && context.hoveredEntityId) {
        context.toggleDynamicSelection(context.hoveredEntityId)
      }
    },

    onPointerOut: () => {
    },

    onClick: () => {
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