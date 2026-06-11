import { toolRegistry } from '@/registry/toolRegistry'
import { createSelectionTool } from '@/tools/SelectionTool'
import { createDrawingTool } from '@/tools/DrawingTool'
import { createConstraintTool } from '@/tools/ConstraintTool'
import { createDimensionTool } from '@/tools/DimensionTool'
import { createDragTool } from '@/tools/DragTool'
import { ENTITIES } from '@/registry/entityRegistry'
import { CONSTRAINTS } from '@/registry/constraintRegistry'

export function initializeTools(): void {
  toolRegistry.register(createSelectionTool())

  for (const entity of ENTITIES) {
    if (entity.activeTool) {
      toolRegistry.register(createDrawingTool({ entityKind: entity.activeTool, paramCount: entity.paramCount }))
    }
  }

  // Compound drawing tools (rect, center_rect) create multiple entities and constraints,
  // not a single entity — they have no entry in ENTITIES. Register them separately.
  toolRegistry.register(createDrawingTool({ entityKind: 'rect', paramCount: 0 }))
  toolRegistry.register(createDrawingTool({ entityKind: 'center_rect', paramCount: 0 }))
  toolRegistry.register(createDrawingTool({ entityKind: 'ngon', paramCount: 0 }))

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

  if (import.meta.env.DEV) {
    toolRegistry.validate()
  }
}

export { createSelectionTool, createDrawingTool, createConstraintTool, createDimensionTool, createDragTool }
export { toolRegistry } from '@/registry/toolRegistry'