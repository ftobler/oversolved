// interaction/index.ts
// Re-export interaction module types and shared hooks.

export type {
  DragInit,
  InteractionHandlers,
  ToolDragHandlers,
  ToolHandlerContract,
  DimensionClickHandlers,
} from './interaction-actions'

export { useDynamicSelectionPositions } from './snapHooks'
