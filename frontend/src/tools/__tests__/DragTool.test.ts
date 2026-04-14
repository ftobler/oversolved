import { describe, it, expect, vi } from 'vitest'
import { createDragTool } from '../DragTool'
import type { DragToolContext } from '../DragTool'

function createMockContext(overrides: Partial<DragToolContext> = {}): DragToolContext {
  return {
    normalSelection: new Set<string>(),
    internalHoverSelection: null,
    dynamicSelection: new Set<string>(),
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

    it('returns null when no vertex hovered', () => {
      const tool = createDragTool()
      const context = createMockContext({ hoveredVertexId: null })

      const result = tool.handlers.onPointerDown!({} as PointerEvent, [10, 10], context)

      expect(result).toBeNull()
    })
  })

  describe('onPointerMove', () => {
    it('initiates drag when threshold exceeded', () => {
      const setDragPending = vi.fn()
      const setDrag = vi.fn()
      const tool = createDragTool()
      const context = createMockContext({
        setDragPending,
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

      tool.handlers.onPointerMove!({} as PointerEvent, [10, 10], null, context)

      expect(setDrag).toHaveBeenCalled()
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

    it('shows in toolbar', () => {
      const tool = createDragTool()
      expect(tool.showInToolbar).toBe(true)
    })

    it('supports vertex, edge, and dim_label drag modes', () => {
      const tool = createDragTool()
      expect(tool.dragModes).toContain('vertex')
      expect(tool.dragModes).toContain('edge')
      expect(tool.dragModes).toContain('dim_label')
    })
  })
})