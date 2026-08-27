import { describe, it, expect, vi } from 'vitest'
import { createDragTool } from '@/tools/DragTool'
import type { DragToolContext } from '@/tools/DragTool'

function createMockContext(overrides: Partial<DragToolContext> = {}): DragToolContext {
  return {
    normalSelection: new Set<string>(),
    hoveredSelectionId: null,
    isPointerDown: false,
    activeFeatureId: 'S1',
    hoveredVertexId: 'vertex:S1:L1:start',
    hoveredVertexPosition: [0, 0],
    hoveredSnapKind: null,
    onMutation: null,
    drag: null,
    dragPending: null,
    dragSnap: null,
    setDrag: vi.fn(),
    setDragPending: vi.fn(),
    setDragSnap: vi.fn(),
    startClient: [100, 100],
    pushMode: vi.fn(),
    popMode: vi.fn(),
    ...overrides,
  }
}

describe('DragTool', () => {
  describe('onPointerDown', () => {
    it('sets drag pending when hovering vertex', () => {
      const setDragPending = vi.fn()
      const tool = createDragTool()
      const context = createMockContext({
        setDragPending,
        activeFeatureId: 'S1',
        hoveredVertexId: 'vertex:S1:L1:start',
      })

      const result = tool.handlers.onPointerDown!({} as PointerEvent, [10, 10], context)

      expect(result).toBeNull()
      expect(setDragPending).toHaveBeenCalledWith(expect.objectContaining({
        type: 'vertex',
        vertexId: 'vertex:S1:L1:start',
        featureId: 'S1',
        entityId: 'L1',
        vertexKey: 'start',
      }))
    })

    it('sets drag pending for edge drag when hovering entity', () => {
      const setDragPending = vi.fn()
      const tool = createDragTool()
      const context = createMockContext({
        setDragPending,
        activeFeatureId: 'S1',
        hoveredVertexId: 'entity:S1:L1',
      })

      tool.handlers.onPointerDown!({} as PointerEvent, [10, 10], context)

      expect(setDragPending).toHaveBeenCalledWith(expect.objectContaining({
        type: 'edge',
        vertexId: 'entity:S1:L1',
        featureId: 'S1',
        entityId: 'L1',
      }))
    })

    it('an edge pending drag on a circle is unchanged at pointer-down', () => {
      // The tool stays solver-free: the mode (translate / radius / locked) is
      // resolved downstream by the WASM drag probe, not here. Pointer-down only
      // records a pending edge drag.
      const setDragPending = vi.fn()
      const tool = createDragTool()
      const context = createMockContext({
        setDragPending,
        activeFeatureId: 'S1',
        hoveredVertexId: 'entity:S1:C1',
      })

      tool.handlers.onPointerDown!({} as PointerEvent, [10, 10], context)

      expect(setDragPending).toHaveBeenCalledWith(expect.objectContaining({
        type: 'edge',
        vertexId: 'entity:S1:C1',
        featureId: 'S1',
        entityId: 'C1',
        vertexKey: '',
      }))
    })

    it('returns null when no hovered id', () => {
      const tool = createDragTool()
      const context = createMockContext({ hoveredVertexId: null })

      const result = tool.handlers.onPointerDown!({} as PointerEvent, [10, 10], context)

      expect(result).toBeNull()
    })

    it('returns null when no activeFeatureId', () => {
      const tool = createDragTool()
      const context = createMockContext({ activeFeatureId: null })

      const result = tool.handlers.onPointerDown!({} as PointerEvent, [10, 10], context)

      expect(result).toBeNull()
    })
  })

  describe('onPointerMove', () => {
    it('initiates vertex drag when threshold exceeded', () => {
      const setDragPending = vi.fn()
      const setDrag = vi.fn()
      const tool = createDragTool()
      const context = createMockContext({
        setDragPending,
        setDrag,
        startClient: [100, 100],
        dragPending: {
          type: 'vertex',
          vertexId: 'vertex:S1:L1:start',
          featureId: 'S1',
          entityId: 'L1',
          vertexKey: 'start',
          startWorld: [0, 0],
        },
      })

      tool.handlers.onPointerMove!({ clientX: 200, clientY: 200 } as PointerEvent, [10, 10], null, context)

      expect(setDrag).toHaveBeenCalled()
    })

    it('initiates edge drag when threshold exceeded, resolves startWorld', () => {
      const setDrag = vi.fn()
      const tool = createDragTool()
      const context = createMockContext({
        setDrag,
        startClient: [100, 100],
        dragPending: {
          type: 'edge',
          vertexId: 'entity:S1:L1',
          featureId: 'S1',
          entityId: 'L1',
          vertexKey: '',
          startWorld: [0, 0],
        },
      })

      tool.handlers.onPointerMove!({ clientX: 200, clientY: 200 } as PointerEvent, [5, 5], null, context)

      expect(setDrag).toHaveBeenCalledWith(expect.objectContaining({
        type: 'edge',
        startWorld: [5, 5],  // resolved from worldPt (cursor position at activation)
        currentWorld: [5, 5],
      }))
    })

    it('does not initiate drag when below threshold', () => {
      const setDrag = vi.fn()
      const tool = createDragTool()
      const context = createMockContext({
        setDrag,
        dragPending: {
          type: 'vertex',
          vertexId: 'vertex:S1:L1:start',
          featureId: 'S1',
          entityId: 'L1',
          vertexKey: 'start',
          startWorld: [0, 0],
        },
      })

      tool.handlers.onPointerMove!({} as PointerEvent, [0.01, 0.01], null, context)

      expect(setDrag).not.toHaveBeenCalled()
    })
  })

  describe('onPointerUp', () => {
    it('emits move_vertex when drag completed', () => {
      const setDragPending = vi.fn()
      const setDrag = vi.fn()
      const onMutation = vi.fn()
      const tool = createDragTool()
      const context = createMockContext({
        setDragPending,
        setDrag,
        onMutation,
        dragPending: {
          type: 'vertex',
          vertexId: 'vertex:S1:L1:start',
          featureId: 'S1',
          entityId: 'L1',
          vertexKey: 'start',
          startWorld: [0, 0],
        },
        drag: {
          type: 'vertex',
          vertexId: 'vertex:S1:L1:start',
          featureId: 'S1',
          entityId: 'L1',
          vertexKey: 'start',
          startWorld: [0, 0],
          currentWorld: [10, 10],
          startClient: [100, 100],
        },
      })

      tool.handlers.onPointerUp!({} as PointerEvent, [10, 10], null, context)

      expect(onMutation).toHaveBeenCalledWith({
        type: 'move_vertex',
        featureId: 'S1',
        entityId: 'L1',
        vertexKey: 'start',
        to: [10, 10],
      })
    })

    it('emits move_entity when edge drag completed', () => {
      const onMutation = vi.fn()
      const tool = createDragTool()
      const context = createMockContext({
        onMutation,
        dragPending: {
          type: 'edge',
          vertexId: 'entity:S1:L1',
          featureId: 'S1',
          entityId: 'L1',
          vertexKey: '',
          startWorld: [2, 3],
        },
        drag: {
          type: 'edge',
          vertexId: 'entity:S1:L1',
          featureId: 'S1',
          entityId: 'L1',
          vertexKey: '',
          startWorld: [2, 3],
          currentWorld: [7, 9],
          startClient: [100, 100],
        },
      })

      tool.handlers.onPointerUp!({} as PointerEvent, [7, 9], null, context)

      expect(onMutation).toHaveBeenCalledWith({
        type: 'move_entity',
        featureId: 'S1',
        entityId: 'L1',
        delta: [5, 6],  // 7-2, 9-3
      })
    })

    it('does not emit when movement below threshold', () => {
      const onMutation = vi.fn()
      const tool = createDragTool()
      const context = createMockContext({
        onMutation,
        dragPending: {
          type: 'vertex',
          vertexId: 'vertex:S1:L1:start',
          featureId: 'S1',
          entityId: 'L1',
          vertexKey: 'start',
          startWorld: [0, 0],
        },
      })

      tool.handlers.onPointerUp!({} as PointerEvent, [0.01, 0.01], null, context)

      expect(onMutation).not.toHaveBeenCalled()
    })
  })

  describe('tool properties', () => {
    it('has correct id', () => {
      const tool = createDragTool()
      expect(tool.id).toBe('drag')
    })

    it('has correct category', () => {
      const tool = createDragTool()
      expect(tool.category).toBe('drag')
    })

    it('supports vertex, edge, and dim_label drag modes', () => {
      const tool = createDragTool()
      expect(tool.dragModes).toContain('vertex')
      expect(tool.dragModes).toContain('edge')
      expect(tool.dragModes).toContain('dim_label')
    })
  })
})