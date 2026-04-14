import { describe, it, expect, vi } from 'vitest'
import { ToolRegistry } from '../toolRegistry'
import { getEffectiveTool } from '../../stores/sketchEditorStore'

import type { Tool, ToolCategory, ToolId, ToolContext, ToolHandlers } from '../toolRegistry'

const mockHandlers: ToolHandlers = {
  onPointerDown: () => null,
  onPointerUp: () => {},
  onClick: () => {},
}

// Helper to create mock tools for testing
function createMockTool(id: ToolId, category: ToolCategory = 'selection'): Tool {
  return {
    id,
    label: id,
    category,
    activate: () => {},
    deactivate: () => {},
    handlers: mockHandlers,
  }
}

describe('ToolRegistry', () => {
  describe('registration', () => {
    it('registers a tool and retrieves it by id', () => {
      const registry = new ToolRegistry()
      const mockTool = createMockTool('select')
      registry.register(mockTool)
      expect(registry.get('select')).toBe(mockTool)
    })

    it('throws when registering duplicate tool id', () => {
      const registry = new ToolRegistry()
      registry.register(createMockTool('select'))
      expect(() => registry.register(createMockTool('select'))).toThrow(
        'Tool with id select already registered'
      )
    })
  })

  describe('byCategory', () => {
    it('returns all tools in a category', () => {
      const registry = new ToolRegistry()
      registry.register(createMockTool('line', 'drawing'))
      registry.register(createMockTool('circle', 'drawing'))
      registry.register(createMockTool('select', 'selection'))

      const drawingTools = registry.byCategory('drawing')
      expect(drawingTools).toHaveLength(2)
    })

    it('returns empty array for empty category', () => {
      const registry = new ToolRegistry()
      expect(registry.byCategory('drawing')).toHaveLength(0)
    })
  })

  describe('getToolbarTools', () => {
    it('returns tools that show in toolbar', () => {
      const registry = new ToolRegistry()
      registry.register({
        ...createMockTool('select', 'selection'),
        showInToolbar: true,
      })
      registry.register({
        ...createMockTool('line', 'drawing'),
        showInToolbar: false,
      })

      const toolbarTools = registry.getToolbarTools()
      expect(toolbarTools).toHaveLength(1)
      expect(toolbarTools[0].id).toBe('select')
    })
  })

  describe('Tool interface', () => {
    it('activate and deactivate are called', () => {
      const activate = vi.fn()
      const deactivate = vi.fn()
      const context: ToolContext = {
        normalSelection: new Set(),
        internalHoverSelection: null,
        dynamicSelection: new Set(),
        isPointerDown: false,
        activeFeatureId: null,
        hoveredVertexId: null,
        hoveredVertexPosition: null,
        hoveredSnapKind: null,
        onMutation: null,
      }
      const tool: Tool = {
        id: 'select',
        label: 'Select',
        category: 'selection',
        activate,
        deactivate,
        handlers: mockHandlers,
      }

      tool.activate(context)
      expect(activate).toHaveBeenCalledWith(context)

      tool.deactivate(context)
      expect(deactivate).toHaveBeenCalledWith(context)
    })
  })

  describe('validation', () => {
    it('passes when all handlers registered via tool system', () => {
      const registry = new ToolRegistry()
      const tool = createMockTool('select')
      registry.register(tool)
      registry.register(createMockTool('line', 'drawing'))
      registry.register(createMockTool('dimension', 'dimension'))
      registry.register(createMockTool('drag', 'drag'))

      expect(() => registry.validate()).not.toThrow()
    })

    it('throws when no selection tool registered', () => {
      const registry = new ToolRegistry()
      registry.register(createMockTool('line', 'drawing'))
      registry.register(createMockTool('dimension', 'dimension'))
      registry.register(createMockTool('drag', 'drag'))

      expect(() => registry.validate()).toThrow('No selection tool registered')
    })

    it('throws when no drawing tools registered', () => {
      const registry = new ToolRegistry()
      registry.register(createMockTool('select'))
      registry.register(createMockTool('dimension', 'dimension'))
      registry.register(createMockTool('drag', 'drag'))

      expect(() => registry.validate()).toThrow('No drawing tools registered')
    })

    it('throws when dimension tool not registered', () => {
      const registry = new ToolRegistry()
      registry.register(createMockTool('select'))
      registry.register(createMockTool('line', 'drawing'))
      registry.register(createMockTool('drag', 'drag'))

      expect(() => registry.validate()).toThrow('Dimension tool not registered')
    })

    it('throws when drag tool not registered', () => {
      const registry = new ToolRegistry()
      registry.register(createMockTool('select'))
      registry.register(createMockTool('line', 'drawing'))
      registry.register(createMockTool('dimension', 'dimension'))

      expect(() => registry.validate()).toThrow('Drag tool not registered')
    })

    it('throws when selection tool missing onClick handler', () => {
      const registry = new ToolRegistry()
      const toolNoClick: Tool = {
        id: 'select',
        label: 'Select',
        category: 'selection',
        activate: () => {},
        deactivate: () => {},
        handlers: {
          onPointerDown: () => null,
          onPointerUp: () => {},
        },
      }
      registry.register(toolNoClick)
      registry.register(createMockTool('line', 'drawing'))
      registry.register(createMockTool('dimension', 'dimension'))
      registry.register(createMockTool('drag', 'drag'))

      expect(() => registry.validate()).toThrow('Selection tool must have onClick handler')
    })

    it('tracks registered handlers', () => {
      const registry = new ToolRegistry()
      const tool = createMockTool('select')
      registry.register(tool)
      registry.register(createMockTool('line', 'drawing'))
      registry.register(createMockTool('dimension', 'dimension'))
      registry.register(createMockTool('drag', 'drag'))

      expect(registry.getRegisteredHandlerCount()).toBeGreaterThan(0)
    })
  })

  describe('fallback tool behavior', () => {
    it('returns drag tool when activeTool is null', () => {
      expect(getEffectiveTool(null)).toBe('drag')
    })

    it('returns the same tool when activeTool is set', () => {
      expect(getEffectiveTool('select')).toBe('select')
      expect(getEffectiveTool('line')).toBe('line')
      expect(getEffectiveTool('dimension')).toBe('dimension')
    })
  })
})