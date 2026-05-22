import { describe, it, expect, vi } from 'vitest'
import { createDrawingTool } from '@/tools/DrawingTool'
import type { DrawingToolContext } from '@/tools/DrawingTool'

function createMockContext(overrides: Partial<DrawingToolContext> = {}): DrawingToolContext {
  return {
    normalSelection: new Set<string>(),
    hoveredSelectionId: null,
    isPointerDown: false,
    activeFeatureId: 'S1',
    hoveredVertexId: null,
    hoveredVertexPosition: null,
    hoveredSnapKind: null,
    onMutation: null,
    pushMode: vi.fn(),
    popMode: vi.fn(),
    drawPoints: [],
    drawSnapVertexId: null,
    setDrawHover: vi.fn(),
    clearDraw: vi.fn(),
    setActiveTool: vi.fn(),
    alignmentSnapPoint: null,
    alignmentSnapKind: null,
    alignmentSnapVertexId: null,
    setDrawSnap: vi.fn(),
    ...overrides,
  }
}

describe('DrawingTool', () => {
  describe('line tool', () => {
    it('creates entity when enough points collected', () => {
      const onMutation = vi.fn()
      const clearDraw = vi.fn()
      const setActiveTool = vi.fn()
      const tool = createDrawingTool({ entityKind: 'line', paramCount: 4 })
      const context = createMockContext({
        onMutation,
        clearDraw,
        setActiveTool,
        drawPoints: [[0, 0]],
        activeFeatureId: 'S1',
      })

      tool.handlers.onPointerDown!({} as PointerEvent, [10, 10], context)

      expect(onMutation).toHaveBeenCalledWith({
        type: 'add_entity',
        featureId: 'S1',
        kind: 'line',
        params: expect.any(Array),
      })
      expect(clearDraw).toHaveBeenCalled()
      expect(setActiveTool).toHaveBeenCalledWith(null)
    })

    it('adds point when not enough points', () => {
      const onMutation = vi.fn()
      const clearDraw = vi.fn()
      const tool = createDrawingTool({ entityKind: 'line', paramCount: 4 })
      const context = createMockContext({
        onMutation,
        clearDraw,
        drawPoints: [],
      })

      tool.handlers.onPointerDown!({} as PointerEvent, [10, 10], context)

      expect(onMutation).not.toHaveBeenCalled()
    })
  })

  describe('circle tool', () => {
    it('has paramCount of 3 (cx, cy, r)', () => {
      const tool = createDrawingTool({ entityKind: 'circle', paramCount: 3 })
      expect(tool.paramCount).toBe(3)
    })
  })

  describe('arc tool', () => {
    it('has paramCount of 5 (cx, cy, r, a_start, a_end)', () => {
      const tool = createDrawingTool({ entityKind: 'arc', paramCount: 5 })
      expect(tool.paramCount).toBe(5)
    })
  })

  describe('onPointerMove', () => {
    it('updates draw hover', () => {
      const setDrawHover = vi.fn()
      const tool = createDrawingTool({ entityKind: 'line', paramCount: 4 })
      const context = createMockContext({ setDrawHover })

      tool.handlers.onPointerMove!({} as PointerEvent, [10, 10], null, context)

      expect(setDrawHover).toHaveBeenCalledWith([10, 10])
    })
  })

  describe('tool properties', () => {
    it('has correct category', () => {
      const tool = createDrawingTool({ entityKind: 'line', paramCount: 4 })
      expect(tool.category).toBe('drawing')
    })

    it('has correct entity kind', () => {
      const tool = createDrawingTool({ entityKind: 'line', paramCount: 4 })
      expect(tool.entityKind).toBe('line')
    })
  })

  describe('rect tool (compound)', () => {
    it('first click stores point, second click emits add_rect', () => {
      const onMutation = vi.fn()
      const clearDraw = vi.fn()
      const setActiveTool = vi.fn()
      const tool = createDrawingTool({ entityKind: 'rect', paramCount: 0 })
      const context = createMockContext({
        onMutation,
        clearDraw,
        setActiveTool,
        drawPoints: [],
      })

      // First click: store point
      tool.handlers.onPointerDown!({} as PointerEvent, [1, 2], context)
      expect(onMutation).not.toHaveBeenCalled()
      expect(context.drawPoints).toEqual([[1, 2]])

      // Second click: emit add_rect mutation
      context.drawPoints = [[1, 2]]
      tool.handlers.onPointerDown!({} as PointerEvent, [5, 6], context)
      expect(onMutation).toHaveBeenCalledWith({
        type: 'add_rect',
        featureId: 'S1',
        p0: [1, 2],
        p1: [5, 6],
      })
      expect(clearDraw).toHaveBeenCalled()
      expect(setActiveTool).toHaveBeenCalledWith(null)
    })
  })

  describe('center_rect tool (compound)', () => {
    it('first click stores center, second click emits add_center_rect', () => {
      const onMutation = vi.fn()
      const clearDraw = vi.fn()
      const setActiveTool = vi.fn()
      const tool = createDrawingTool({ entityKind: 'center_rect', paramCount: 0 })
      const context = createMockContext({
        onMutation,
        clearDraw,
        setActiveTool,
        drawPoints: [],
      })

      // First click: store center
      tool.handlers.onPointerDown!({} as PointerEvent, [0, 0], context)
      expect(onMutation).not.toHaveBeenCalled()
      expect(context.drawPoints).toEqual([[0, 0]])

      // Second click: emit add_center_rect mutation
      context.drawPoints = [[0, 0]]
      tool.handlers.onPointerDown!({} as PointerEvent, [3, 4], context)
      expect(onMutation).toHaveBeenCalledWith({
        type: 'add_center_rect',
        featureId: 'S1',
        center: [0, 0],
        corner: [3, 4],
      })
      expect(clearDraw).toHaveBeenCalled()
      expect(setActiveTool).toHaveBeenCalledWith(null)
    })
  })

  describe('alignment snap integration', () => {
    it('line tool creates entity on second click (prerequisite for alignment snap test)', () => {
      const onMutation = vi.fn()
      const clearDraw = vi.fn()
      const setActiveTool = vi.fn()
      const tool = createDrawingTool({ entityKind: 'line', paramCount: 4 })
      const context = createMockContext({
        onMutation,
        clearDraw,
        setActiveTool,
        drawPoints: [[0, 0]],
        activeFeatureId: 'S1',
      })

      tool.handlers.onPointerDown!({} as PointerEvent, [10, 10], context)

      expect(onMutation).toHaveBeenCalledWith({
        type: 'add_entity',
        featureId: 'S1',
        kind: 'line',
        params: expect.any(Array),
      })
    })
  })
})