import { toolRegistry } from '../registry/toolRegistry'
import { createSelectionTool } from './SelectionTool'
import { createDrawingTool } from './DrawingTool'
import { createConstraintTool } from './ConstraintTool'
import { createDimensionTool } from './DimensionTool'
import { createDragTool } from './DragTool'
import { ENTITIES } from '../registry/entityRegistry'
import { CONSTRAINTS } from '../registry/constraintRegistry'

export function initializeTools(): void {
  toolRegistry.register(createSelectionTool())

  for (const entity of ENTITIES) {
    if (entity.activeTool) {
      toolRegistry.register(createDrawingTool({ entityKind: entity.activeTool, paramCount: entity.paramCount }))
    }
  }

  for (const constraint of CONSTRAINTS) {
    toolRegistry.register(
      createConstraintTool({
        constraintKind: constraint.kind,
        requiresSelection: constraint.refPattern === 'a_b' || constraint.kind === 'midpoint' ? 2 : 1,
      })
    )
  }

  toolRegistry.register(createDimensionTool())
  toolRegistry.register(createDragTool())

  if (process.env.NODE_ENV === 'development') {
    toolRegistry.validate()
  }
}

export { createSelectionTool, createDrawingTool, createConstraintTool, createDimensionTool, createDragTool }
export { toolRegistry } from '../registry/toolRegistry'