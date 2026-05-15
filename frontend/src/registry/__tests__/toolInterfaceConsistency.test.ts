import { describe, it, expect } from 'vitest'
import { ToolRegistry, type Tool } from '@/registry/toolRegistry'
import { createDragTool } from '@/tools/DragTool'
import { createDimensionTool } from '@/tools/DimensionTool'

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
    registry.register(createDragTool())
    registry.register(createDimensionTool())
    registry.register({ id: 'select' as const, label: 'Select', category: 'selection' as const, showInToolbar: true, activate: () => {}, deactivate: () => {}, handlers: { onClick: () => {} } })
    registry.register({ id: 'line' as const, label: 'Line', category: 'drawing' as const, entityKind: 'line', paramCount: 4, showInToolbar: true, activate: () => {}, deactivate: () => {}, handlers: {} } as unknown as Tool)
    expect(() => registry.validate()).not.toThrow()
  })
})
