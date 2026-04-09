import type { Tool, ToolCategory, ToolContext, ToolHandlers } from '../registry/toolRegistry'
import { useSketchEditorStore } from '../stores/sketchEditorStore'

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

    onPointerUp: (_e, _worldPt, _drag, context) => {
      const state = useSketchEditorStore.getState()
      const dynamic = state.dynamicSelection

      if (dynamic.size > 0) {
        for (const id of dynamic) {
          context.toggleNormalSelection(id)
        }
        context.clearDynamicSelection()
      }
    },

    onPointerOver: (_e, _worldPt, context) => {
      if (context.isPointerDown && context.internalHoverSelection) {
        context.updateDynamicSelection(context.internalHoverSelection)
      }
    },

    onPointerOut: (context) => {
      if (context.isPointerDown) {
        context.setInternalHoverSelection(null)
        context.updateDynamicSelection(null)
      }
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
