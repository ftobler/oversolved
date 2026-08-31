import { describe, it, expect, vi } from 'vitest'
import { ToolRegistry, toolRegistry, ACTIVATABLE_TOOL_IDS, isDrawingTool, drawingToolIds } from '@/registry/toolRegistry'
import { getEffectiveTool } from '@/stores/sketchEditorStore'
import { DRAWING_TOOLS } from '@/stores/stateInvariants'
import { initializeTools } from '@/tools'
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

// Register every id validate() requires (drawing/dimension/drag plus the full
// ACTIVATABLE set), so validate()-focused tests can vary one member at a time.
function registerCanonicalTools(registry: ToolRegistry): void {
  for (const id of ACTIVATABLE_TOOL_IDS) {
    const category: ToolCategory = id === 'dimension' ? 'dimension' : id === 'drag' ? 'drag' : 'drawing'
    registry.register(createMockTool(id, category))
  }
}

describe('ToolRegistry', () => {
  describe('registration', () => {
    it('registers a tool and retrieves it by id', () => {
      const registry = new ToolRegistry()
      const mockTool = createMockTool('drag')
      registry.register(mockTool)
      expect(registry.get('drag')).toBe(mockTool)
    })

    it('throws when registering duplicate tool id', () => {
      const registry = new ToolRegistry()
      registry.register(createMockTool('drag'))
      expect(() => registry.register(createMockTool('drag'))).toThrow(
        'Tool with id drag already registered'
      )
    })

    it('reset clears the registry so a tool can be re-registered', () => {
      const registry = new ToolRegistry()
      registry.register(createMockTool('line', 'drawing'))
      registry.reset()
      registry.register(createMockTool('line', 'drawing'))
      expect(registry.get('line')?.label).toBe('line')
    })
  })

  describe('initializeTools idempotency', () => {
    it('does not throw when called twice and keeps the tool set intact', () => {
      expect(() => initializeTools()).not.toThrow()
      expect(() => initializeTools()).not.toThrow()
      expect(toolRegistry.get('line')).not.toBeNull()
      expect(toolRegistry.get('rect')).not.toBeNull()
      expect(toolRegistry.get('center_rect')).not.toBeNull()
      expect(toolRegistry.get('dimension')).not.toBeNull()
      expect(toolRegistry.get('drag')).not.toBeNull()
      expect(() => toolRegistry.validate()).not.toThrow()
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
        id: 'line',
        label: 'Line',
        category: 'drawing',
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
    it('passes when the canonical tools are registered', () => {
      const registry = new ToolRegistry()
      registerCanonicalTools(registry)

      expect(() => registry.validate()).not.toThrow()
    })

    it('throws when no drawing tools registered', () => {
      const registry = new ToolRegistry()
      registry.register(createMockTool('dimension', 'dimension'))
      registry.register(createMockTool('drag', 'drag'))

      expect(() => registry.validate()).toThrow('No drawing tools registered')
    })

    it('throws when dimension tool not registered', () => {
      const registry = new ToolRegistry()
      registry.register(createMockTool('line', 'drawing'))
      registry.register(createMockTool('drag', 'drag'))

      expect(() => registry.validate()).toThrow('Dimension tool not registered')
    })

    it('throws when drag tool not registered', () => {
      const registry = new ToolRegistry()
      registry.register(createMockTool('line', 'drawing'))
      registry.register(createMockTool('dimension', 'dimension'))

      expect(() => registry.validate()).toThrow('Drag tool not registered')
    })

    it('throws when a non-placeholder activatable tool is missing', () => {
      const registry = new ToolRegistry()
      for (const id of ACTIVATABLE_TOOL_IDS) {
        if (id === 'point') continue  // deliberately not registered
        const category: ToolCategory = id === 'dimension' ? 'dimension' : id === 'drag' ? 'drag' : 'drawing'
        registry.register(createMockTool(id, category))
      }

      expect(() => registry.validate()).toThrow('Tool point not registered')
    })
  })

  describe('fallback tool behavior', () => {
    it('returns drag tool when activeTool is null', () => {
      expect(getEffectiveTool(null)).toBe('drag')
    })

    it('returns the same tool when activeTool is set', () => {
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
      }
      registry.get('drag')!.handlers.onPointerUp!({ clientX: 200, clientY: 200 } as PointerEvent, [10, 10], null, context)
      expect(onMutation).toHaveBeenCalled()
      expect(setDrag).toHaveBeenCalledWith(null)
    })

    it('routes onPointerDown through registry for drawing tool', () => {
      const registry = new ToolRegistry()
      const tool = createDrawingTool({ entityKind: 'line', paramCount: 4 })
      registry.register(tool)

      const onMutation = vi.fn()
      const clearDraw = vi.fn()
      const setDrawPoints = vi.fn()
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
        drawSnapRefs: [],
        setDrawHover: vi.fn(),
        clearDraw,
        setActiveTool: vi.fn(),
        alignmentSnapPoint: null,
        alignmentSnapKind: null,
        setDrawSnap: vi.fn(),
        setDrawPoints,
      }
      registry.get('line')!.handlers.onPointerDown!({} as PointerEvent, [10, 10], context)
      expect(onMutation).toHaveBeenCalled()
      // The line tool chains: the second click emits the segment but keeps the
      // draw alive, so the buffer advances and the tool does not clear.
      expect(setDrawPoints).toHaveBeenCalled()
      expect(clearDraw).not.toHaveBeenCalled()
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
        drawSnapRefs: [],
        setDrawHover: vi.fn(),
        clearDraw: vi.fn(),
        setActiveTool: vi.fn(),
        alignmentSnapPoint: null as [number, number] | null,
        alignmentSnapKind: null,
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
        drawSnapRefs: [],
        setDrawHover: vi.fn(),
        clearDraw: vi.fn(),
        setActiveTool: vi.fn(),
        alignmentSnapPoint: null as [number, number] | null,
        alignmentSnapKind: null,
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

  describe('registry single-source-of-truth cross-check', () => {
    it('after initializeTools, the registered id set is exactly the activatable ids', () => {
      initializeTools()
      const registered = new Set(toolRegistry.registeredIds())
      for (const id of ACTIVATABLE_TOOL_IDS) {
        expect(registered.has(id), `${id} should be registered`).toBe(true)
      }
      // Forward-compat placeholders have ActiveTool/ToolId slots but no tool
      // mode, so they must NOT resolve to a registered tool.
      expect(registered.has('mirror' as ToolId)).toBe(false)
      expect(registered.has('offset' as ToolId)).toBe(false)
      expect(registered.size).toBe(ACTIVATABLE_TOOL_IDS.length)
    })

    it('drawingToolIds equals the registered drawing-category ids', () => {
      initializeTools()
      expect(drawingToolIds()).toEqual(new Set(Array.from(toolRegistry.drawingIds())))
      // DRAWING_TOOLS is the invariant layer's name for the same derivation
      // (stateInvariants.ts); identity-pin it so a hand-listed literal cannot
      // drift the draw-plane classification away from the registry.
      expect(DRAWING_TOOLS).toBe(drawingToolIds)
    })
  })

  describe('isDrawingTool (draw-plane vs backplane classification)', () => {
    it('classifies every registered drawing tool as drawing', () => {
      initializeTools()
      for (const id of toolRegistry.drawingIds()) {
        expect(isDrawingTool(id)).toBe(true)
      }
    })

    it('classifies every non-drawing tool as not drawing', () => {
      initializeTools()
      for (const id of ['dimension', 'drag', 'mirror', 'offset'] as const) {
        expect(isDrawingTool(id)).toBe(false)
      }
      // A bogus id is a non-drawing tool, not a crash.
      expect(isDrawingTool('bogus')).toBe(false)
    })
  })
})