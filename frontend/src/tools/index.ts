import { toolRegistry } from '@/registry/toolRegistry'
import { createDrawingTool } from '@/tools/DrawingTool'
import { createDimensionTool } from '@/tools/DimensionTool'
import { createDragTool } from '@/tools/DragTool'
import { ENTITIES } from '@/registry/entityRegistry'

export function initializeTools(): void {
  // Idempotent: a re-execution (HMR, repeated test setup) wipes the singleton
  // before re-registering instead of throwing "already registered".
  toolRegistry.reset()

  for (const entity of ENTITIES) {
    // The generic tool is enough even for the variable-size fit spline: its
    // click collector builds the params from the placed points, so the
    // registry's minimum `paramCount` is never used to size the entity.
    if (entity.activeTool) {
      toolRegistry.register(createDrawingTool({ entityKind: entity.activeTool, paramCount: entity.paramCount }))
    }
  }

  // Compound drawing tools (rect, center_rect) create multiple entities and constraints,
  // not a single entity; they have no entry in ENTITIES. Register them separately.
  toolRegistry.register(createDrawingTool({ entityKind: 'rect', paramCount: 0 }))
  toolRegistry.register(createDrawingTool({ entityKind: 'center_rect', paramCount: 0 }))
  toolRegistry.register(createDrawingTool({ entityKind: 'ngon', paramCount: 0 }))

  toolRegistry.register(createDimensionTool())
  toolRegistry.register(createDragTool())

  // Unconditional: a dangling union member must fail everywhere (test, build,
  // prod startup), not just under dev. initializeTools runs at app startup and
  // in every test that exercises the store.
  toolRegistry.validate()
}
