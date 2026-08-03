import { describe, it, expect, vi } from 'vitest'
import { createDrawingTool } from '@/tools/DrawingTool'
import type { DrawingToolContext } from '@/tools/DrawingTool'

function createMockContext(overrides: Partial<DrawingToolContext> = {}): DrawingToolContext {
  // Mirrors the context Drawing.tsx builds for a drawing-tool pointer-down
  // (all required fields plus the optional snap/projection slots).
  const context: DrawingToolContext = {
    normalSelection: new Set<string>(),
    hoveredSelectionId: null,
    hoveredSourceKind: null,
    hoveredFaceEdges: null,
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
    setDrawPoints: (pts) => { context.drawPoints = [...pts] },
    clearDraw: vi.fn(),
    setActiveTool: vi.fn(),
    alignmentSnapPoint: null,
    alignmentSnapKind: null,
    alignmentSnapVertexId: null,
    setDrawSnap: vi.fn(),
    ngonSides: 6,
    ...overrides,
  }
  return context
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

  describe('gesture batching', () => {
    it('routes an end-snapped line through onMutationBatch as one undo step', () => {
      const onMutation = vi.fn()
      const onMutationBatch = vi.fn()
      const tool = createDrawingTool({ entityKind: 'line', paramCount: 4 })
      const context = createMockContext({
        onMutation,
        onMutationBatch,
        drawPoints: [[0, 0]],
        hoveredVertexId: 'vertex:S1:l1:end',
        hoveredSnapKind: 'vertex',
        activeFeatureId: 'S1',
      })

      tool.handlers.onPointerDown!({} as PointerEvent, [10, 0], context)

      // The line and its end constraint are one gesture: one batch call, no
      // per-mutation dispatches.
      expect(onMutation).not.toHaveBeenCalled()
      expect(onMutationBatch).toHaveBeenCalledTimes(1)
      const ms = onMutationBatch.mock.calls[0][0] as { type: string }[]
      expect(ms).toHaveLength(2)
      expect(ms[0].type).toBe('add_entity')
      expect(ms[1].type).toBe('add_constraint')
    })

    it('routes a plain (unsnapped) line through onMutation', () => {
      const onMutation = vi.fn()
      const onMutationBatch = vi.fn()
      const tool = createDrawingTool({ entityKind: 'line', paramCount: 4 })
      const context = createMockContext({
        onMutation,
        onMutationBatch,
        drawPoints: [[0, 0]],
        activeFeatureId: 'S1',
      })

      tool.handlers.onPointerDown!({} as PointerEvent, [10, 0], context)

      expect(onMutation).toHaveBeenCalledTimes(1)
      expect(onMutationBatch).not.toHaveBeenCalled()
    })

    it('warns in dev when a multi-mutation gesture has no onMutationBatch', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const tool = createDrawingTool({ entityKind: 'line', paramCount: 4 })
      const context = createMockContext({
        drawPoints: [[0, 0]],
        hoveredVertexId: 'vertex:S1:l1:end',
        hoveredSnapKind: 'vertex',
        activeFeatureId: 'S1',
      })

      tool.handlers.onPointerDown!({} as PointerEvent, [10, 0], context)

      // The batch is silently dropped, but the miss is loud enough to catch.
      expect(warn).toHaveBeenCalled()
      expect(warn.mock.calls[0][0]).toContain('onMutationBatch')
      warn.mockRestore()
    })
  })

  describe('intermediate clicks (setDrawPoints)', () => {
    it('advances the buffer through setDrawPoints instead of mutating in place', () => {
      const setDrawPoints = vi.fn()
      const tool = createDrawingTool({ entityKind: 'line', paramCount: 4 })
      const context = createMockContext({ setDrawPoints })

      tool.handlers.onPointerDown!({} as PointerEvent, [10, 20], context)

      expect(setDrawPoints).toHaveBeenCalledTimes(1)
      expect(setDrawPoints).toHaveBeenCalledWith([[10, 20]])
      expect(context.drawPoints).toEqual([])
      expect(context.drawPoints).not.toBe(setDrawPoints.mock.calls[0][0])
    })

    it('does not call setDrawPoints when the gesture commits (clearTool)', () => {
      const setDrawPoints = vi.fn()
      const onMutation = vi.fn()
      const tool = createDrawingTool({ entityKind: 'line', paramCount: 4 })
      const context = createMockContext({
        onMutation,
        setDrawPoints,
        drawPoints: [[0, 0]],
        activeFeatureId: 'S1',
      })

      tool.handlers.onPointerDown!({} as PointerEvent, [10, 10], context)

      expect(onMutation).toHaveBeenCalledTimes(1)
      expect(setDrawPoints).not.toHaveBeenCalled()
    })
  })
})