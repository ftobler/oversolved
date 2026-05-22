import { describe, it, expect, vi } from 'vitest'
import { ToolRegistry } from '@/registry/toolRegistry'
import { getEffectiveTool } from '@/stores/sketchEditorStore'
import { createDragTool } from '@/tools/DragTool'
import { createDrawingTool } from '@/tools/DrawingTool'

import type { Tool, ToolCategory, ToolId, ToolContext, ToolHandlers } from '@/registry/toolRegistry'

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
        hoveredSelectionId: null,
        isPointerDown: false,
        activeFeatureId: null,
        hoveredVertexId: null,
        hoveredVertexPosition: null,
        hoveredSnapKind: null,
        onMutation: null,
        pushMode: vi.fn(),
        popMode: vi.fn(),
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

  describe('integration: tool dispatch through registry', () => {
    it('routes onPointerDown through registry for drag tool', () => {
      const registry = new ToolRegistry()
      const tool = createDragTool()
      registry.register(tool)

      const context = {
        normalSelection: new Set<string>(),
        hoveredSelectionId: null,
        isPointerDown: false,
        activeFeatureId: 'S1',
        hoveredVertexId: 'vertex:S1:L1:start',
        hoveredVertexPosition: [0, 0] as [number, number],
        hoveredSnapKind: null,
        onMutation: null,
        pushMode: vi.fn(),
        popMode: vi.fn(),
        drag: null,
        dragPending: null,
        dragSnap: null,
        setDrag: vi.fn(),
        setDragPending: vi.fn(),
        setDragSnap: vi.fn(),
        startClient: [100, 100] as [number, number],
        setOrbitEnabled: vi.fn(),
      }
      const result = registry.get('drag')!.handlers.onPointerDown!({} as PointerEvent, [0, 0], context)
      expect(result).toBeNull()
      expect(context.setDragPending).toHaveBeenCalled()
    })

    it('routes onPointerUp through registry for drag tool', () => {
      const registry = new ToolRegistry()
      const tool = createDragTool()
      registry.register(tool)

      const onMutation = vi.fn()
      const setDrag = vi.fn()
      const setDragSnap = vi.fn()
      const setOrbitEnabled = vi.fn()
      const context = {
        normalSelection: new Set<string>(),
        hoveredSelectionId: null,
        isPointerDown: false,
        activeFeatureId: 'S1',
        hoveredVertexId: null,
        hoveredVertexPosition: null,
        hoveredSnapKind: null,
        onMutation,
        pushMode: vi.fn(),
        popMode: vi.fn(),
        drag: { type: 'vertex' as const, vertexId: 'v1', featureId: 'S1', entityId: 'L1', vertexKey: 'start', startWorld: [0, 0] as [number, number], currentWorld: [10, 10] as [number, number], startClient: [100, 100] as [number, number] },
        dragPending: { type: 'vertex' as const, vertexId: 'v1', featureId: 'S1', entityId: 'L1', vertexKey: 'start', startWorld: [0, 0] as [number, number] },
        dragSnap: null,
        setDrag,
        setDragPending: vi.fn(),
        setDragSnap,
        startClient: [100, 100] as [number, number],
        setOrbitEnabled,
      }
      registry.get('drag')!.handlers.onPointerUp!({ clientX: 200, clientY: 200 } as PointerEvent, [10, 10], null, context)
      expect(onMutation).toHaveBeenCalled()
      expect(setDrag).toHaveBeenCalledWith(null)
      expect(setOrbitEnabled).toHaveBeenCalledWith(true)
    })

    it('routes onPointerDown through registry for drawing tool', () => {
      const registry = new ToolRegistry()
      const tool = createDrawingTool({ entityKind: 'line', paramCount: 4 })
      registry.register(tool)

      const onMutation = vi.fn()
      const clearDraw = vi.fn()
      const context = {
        normalSelection: new Set<string>(),
        hoveredSelectionId: null,
        isPointerDown: false,
        activeFeatureId: 'S1',
        hoveredVertexId: null,
        hoveredVertexPosition: null,
        hoveredSnapKind: null,
        onMutation,
        pushMode: vi.fn(),
        popMode: vi.fn(),
        drawPoints: [[0, 0]] as [number, number][],
        drawSnapVertexId: null,
        setDrawHover: vi.fn(),
        clearDraw,
        setActiveTool: vi.fn(),
        hoveredSelectionId: null,
        alignmentSnapPoint: null,
        alignmentSnapKind: null,
        alignmentSnapVertexId: null,
        setDrawSnap: vi.fn(),
      }
      registry.get('line')!.handlers.onPointerDown!({} as PointerEvent, [10, 10], context)
      expect(onMutation).toHaveBeenCalled()
      expect(clearDraw).toHaveBeenCalled()
    })

    it('routes rect tool through registry and generates add_rect mutation', () => {
      const registry = new ToolRegistry()
      const tool = createDrawingTool({ entityKind: 'rect', paramCount: 0 })
      registry.register(tool)

      const onMutation = vi.fn()
      const drawPoints: [number, number][] = [[1, 2]]
      const context = {
        normalSelection: new Set<string>(),
        hoveredSelectionId: null,
        isPointerDown: false,
        activeFeatureId: 'S1',
        hoveredVertexId: null,
        hoveredVertexPosition: null as [number, number] | null,
        hoveredSnapKind: null,
        onMutation,
        pushMode: vi.fn(),
        popMode: vi.fn(),
        drawPoints,
        drawSnapVertexId: null,
        setDrawHover: vi.fn(),
        clearDraw: vi.fn(),
        setActiveTool: vi.fn(),
        hoveredSelectionId: null,
        alignmentSnapPoint: null as [number, number] | null,
        alignmentSnapKind: null,
        alignmentSnapVertexId: null,
        setDrawSnap: vi.fn(),
      }
      registry.get('rect')!.handlers.onPointerDown!({} as PointerEvent, [5, 6], context)
      expect(onMutation).toHaveBeenCalledWith({
        type: 'add_rect',
        featureId: 'S1',
        p0: [1, 2],
        p1: [5, 6],
      })
    })

    it('routes center_rect tool through registry and generates add_center_rect mutation', () => {
      const registry = new ToolRegistry()
      const tool = createDrawingTool({ entityKind: 'center_rect', paramCount: 0 })
      registry.register(tool)

      const onMutation = vi.fn()
      const drawPoints: [number, number][] = [[0, 0]]
      const context = {
        normalSelection: new Set<string>(),
        hoveredSelectionId: null,
        isPointerDown: false,
        activeFeatureId: 'S1',
        hoveredVertexId: null,
        hoveredVertexPosition: null as [number, number] | null,
        hoveredSnapKind: null,
        onMutation,
        pushMode: vi.fn(),
        popMode: vi.fn(),
        drawPoints,
        drawSnapVertexId: null,
        setDrawHover: vi.fn(),
        clearDraw: vi.fn(),
        setActiveTool: vi.fn(),
        hoveredSelectionId: null,
        alignmentSnapPoint: null as [number, number] | null,
        alignmentSnapKind: null,
        alignmentSnapVertexId: null,
        setDrawSnap: vi.fn(),
      }
      registry.get('center_rect')!.handlers.onPointerDown!({} as PointerEvent, [3, 4], context)
      expect(onMutation).toHaveBeenCalledWith({
        type: 'add_center_rect',
        featureId: 'S1',
        center: [0, 0],
        corner: [3, 4],
      })
    })
  })
})