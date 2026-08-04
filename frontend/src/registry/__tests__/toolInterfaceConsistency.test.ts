import { describe, it, expect } from 'vitest'
import { ToolRegistry, ACTIVATABLE_TOOL_IDS } from '@/registry/toolRegistry'
import { createDragTool } from '@/tools/DragTool'
import { createDimensionTool } from '@/tools/DimensionTool'
import { createDrawingTool } from '@/tools/DrawingTool'

describe('ToolHandlers interface consistency', () => {
  it('DragTool handlers satisfy ToolHandlers type', () => {
    const tool = createDragTool()
    expect(tool.handlers.onPointerDown).toBeDefined()
    expect(tool.handlers.onPointerMove).toBeDefined()
    expect(tool.handlers.onPointerUp).toBeDefined()
  })

  it('DimensionTool handlers satisfy ToolHandlers type', () => {
    const tool = createDimensionTool()
    expect(tool.handlers.onPointerDown).toBeDefined()
    expect(tool.handlers.onClick).toBeDefined()
  })

  it('ToolRegistry.validate() works with all tools', () => {
    const registry = new ToolRegistry()
    for (const id of ACTIVATABLE_TOOL_IDS) {
      if (id === 'dimension') {
        registry.register(createDimensionTool())
      } else if (id === 'drag') {
        registry.register(createDragTool())
      } else {
        registry.register(createDrawingTool({ entityKind: id, paramCount: 4 }))
      }
    }
    expect(() => registry.validate()).not.toThrow()
  })

  it('validate() rejects a registry missing a non-placeholder id', () => {
    const registry = new ToolRegistry()
    for (const id of ACTIVATABLE_TOOL_IDS) {
      if (id === 'ngon') continue  // ngon is compound, skip it to make validate fail
      if (id === 'dimension') {
        registry.register(createDimensionTool())
      } else if (id === 'drag') {
        registry.register(createDragTool())
      } else {
        registry.register(createDrawingTool({ entityKind: id, paramCount: 4 }))
      }
    }
    expect(() => registry.validate()).toThrow('Tool ngon not registered')
  })
})
