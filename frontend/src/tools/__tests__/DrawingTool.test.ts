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
    drawSnapRefs: [],
    setDrawHover: vi.fn(),
    setDrawPoints: (pts) => { context.drawPoints = [...pts] },
    clearDraw: vi.fn(),
    setActiveTool: vi.fn(),
    alignmentSnapPoint: null,
    alignmentSnapKind: null,
    setDrawSnap: vi.fn(),
    ngonSides: 6,
    ...overrides,
  }
  return context
}

describe('DrawingTool', () => {
  describe('line tool', () => {
    it('creates a segment but keeps the chain open (no tool clear on second click)', () => {
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
        // Every segment is named, so the next click can constrain its start to
        // this one's end vertex.
        entityId: expect.any(String),
      })
      // The chain continues: the draw is not cleared and the tool stays armed.
      expect(clearDraw).not.toHaveBeenCalled()
      expect(setActiveTool).not.toHaveBeenCalled()
    })

    it('chains across multiple clicks then finishes on a closing click', () => {
      const onMutation = vi.fn()
      const setActiveTool = vi.fn()
      const tool = createDrawingTool({ entityKind: 'line', paramCount: 4 })
      const context = createMockContext({
        onMutation,
        setActiveTool,
        drawPoints: [],
        activeFeatureId: 'S1',
      })

      // First vertex.
      tool.handlers.onPointerDown!({} as PointerEvent, [0, 0], context)
      expect(setActiveTool).not.toHaveBeenCalled()

      // Second click extends the chain.
      tool.handlers.onPointerDown!({} as PointerEvent, [10, 0], context)
      expect(setActiveTool).not.toHaveBeenCalled()

      // Closing click on the first vertex terminates the polyline. The line
      // tool is sticky, so the tool stays armed for the next polyline.
      tool.handlers.onPointerDown!({} as PointerEvent, [0, 0], context)
      expect(setActiveTool).not.toHaveBeenCalled()
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
      expect(setActiveTool).not.toHaveBeenCalled()
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
      expect(setActiveTool).not.toHaveBeenCalled()
    })
  })

  describe('ngon tool (compound)', () => {
    it('first click stores center, second click emits add_ngon with the context side count', () => {
      const onMutation = vi.fn()
      const clearDraw = vi.fn()
      const setActiveTool = vi.fn()
      const tool = createDrawingTool({ entityKind: 'ngon', paramCount: 0 })
      const context = createMockContext({
        onMutation,
        clearDraw,
        setActiveTool,
        drawPoints: [],
        // Non-default side count proves the context slot reaches the lowering
        // instead of the tool hardcoding the drawLogic default of 6.
        ngonSides: 5,
      })

      // First click: store center
      tool.handlers.onPointerDown!({} as PointerEvent, [0, 0], context)
      expect(onMutation).not.toHaveBeenCalled()
      expect(context.drawPoints).toEqual([[0, 0]])

      // Second click: emit add_ngon
      context.drawPoints = [[0, 0]]
      tool.handlers.onPointerDown!({} as PointerEvent, [10, 0], context)
      expect(onMutation).toHaveBeenCalledWith({
        type: 'add_ngon',
        featureId: 'S1',
        center: [0, 0],
        corner: [10, 0],
        sides: 5,
      })
      expect(clearDraw).toHaveBeenCalled()
      expect(setActiveTool).not.toHaveBeenCalled()
    })
  })

  describe('project tool', () => {
    it('emits add_projected_entity for a hovered foreign sketch entity', () => {
      const onMutation = vi.fn()
      const clearDraw = vi.fn()
      const setActiveTool = vi.fn()
      const tool = createDrawingTool({ entityKind: 'project', paramCount: 4 })
      const context = createMockContext({
        onMutation,
        clearDraw,
        setActiveTool,
        hoveredSelectionId: 'entity:S2:L1',
      })

      tool.handlers.onPointerDown!({} as PointerEvent, [0, 0], context)

      expect(onMutation).toHaveBeenCalledWith({
        type: 'add_projected_entity',
        featureId: 'S1',
        kind: 'line',
        source: '@S2/L1',
      })
      expect(clearDraw).toHaveBeenCalled()
      expect(setActiveTool).not.toHaveBeenCalled()
    })

    it('resolves the projected kind from the source sketch, not a hardcoded line', () => {
      const onMutation = vi.fn()
      const tool = createDrawingTool({ entityKind: 'project', paramCount: 4 })
      const context = createMockContext({
        onMutation,
        hoveredSelectionId: 'entity:S2:C1',
        otherSketches: { S2: { C1: { center: [0, 0], radius: 5 } } } as DrawingToolContext['otherSketches'],
      })

      tool.handlers.onPointerDown!({} as PointerEvent, [0, 0], context)

      expect(onMutation).toHaveBeenCalledWith({
        type: 'add_projected_entity',
        featureId: 'S1',
        kind: 'circle',
        source: '@S2/C1',
      })
    })

    it('passes the hovered body edge curve kind through to the lowering', () => {
      const onMutation = vi.fn()
      const tool = createDrawingTool({ entityKind: 'project', paramCount: 4 })
      const context = createMockContext({
        onMutation,
        hoveredSelectionId: '?4,4;@bxx@fyy:edge',
        hoveredSourceKind: 'arc',
      })

      tool.handlers.onPointerDown!({} as PointerEvent, [0, 0], context)

      expect(onMutation).toHaveBeenCalledWith({
        type: 'add_projected_entity',
        featureId: 'S1',
        kind: 'arc',
        source: '?4,4;@bxx@fyy:edge',
      })
    })

    it('does nothing for an entity of the sketch being projected onto', () => {
      const onMutation = vi.fn()
      const clearDraw = vi.fn()
      const tool = createDrawingTool({ entityKind: 'project', paramCount: 4 })
      const context = createMockContext({
        onMutation,
        clearDraw,
        hoveredSelectionId: 'entity:S1:L1',
      })

      tool.handlers.onPointerDown!({} as PointerEvent, [0, 0], context)

      expect(onMutation).not.toHaveBeenCalled()
      expect(clearDraw).not.toHaveBeenCalled()
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
        // Every segment is named, so the next click can constrain its start to
        // this one's end vertex.
        entityId: expect.any(String),
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

    it('advances the buffer via setDrawPoints when the segment commits (chains)', () => {
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
      // The committed segment keeps the chain alive, so the buffer advances.
      expect(setDrawPoints).toHaveBeenCalledTimes(1)
      expect(setDrawPoints).toHaveBeenCalledWith([[0, 0], [10, 10]])
    })
  })

  describe('non-finite / origin snap passthrough', () => {
    it('a non-finite worldPt emits no mutation', () => {
      const onMutation = vi.fn()
      const onMutationBatch = vi.fn()
      const tool = createDrawingTool({ entityKind: 'circle', paramCount: 3 })
      const context = createMockContext({ onMutation, onMutationBatch, drawPoints: [] })
      // test mode failLoud throws; production warn-and-drop. Either way nothing is emitted.
      expect(() => tool.handlers.onPointerDown!({} as PointerEvent, [NaN, 5], context)).toThrow()
      expect(onMutation).not.toHaveBeenCalled()
      expect(onMutationBatch).not.toHaveBeenCalled()
    })

    it('the origin snap position reaches computeDrawClick unchanged', () => {
      const tool = createDrawingTool({ entityKind: 'circle', paramCount: 3 })
      const context = createMockContext({
        hoveredVertexPosition: [-37.5, 12.25],
        drawPoints: [],
      })
      tool.handlers.onPointerDown!({} as PointerEvent, [1, 1], context)
      // The first circle click records the snapped point; it must be the origin's
      // real local position, not the raw [1,1] nor a hard-coded [0,0].
      expect(context.drawPoints).toEqual([[-37.5, 12.25]])
    })
  })

  describe('sticky arming', () => {
    // The mock's clearDraw is a no-op, so override it to reset drawPoints the
    // way the real store does, letting a committed shape leave a clean buffer
    // for the next entity of the same tool.
    function stickyContext(overrides: Partial<DrawingToolContext> = {}): DrawingToolContext {
      const ctx = createMockContext(overrides)
      ctx.clearDraw = vi.fn(() => { ctx.drawPoints = [] })
      return ctx
    }

    it('circle stays armed after committing and draws a second circle', () => {
      const onMutation = vi.fn()
      const setActiveTool = vi.fn()
      const tool = createDrawingTool({ entityKind: 'circle', paramCount: 3 })
      const context = stickyContext({ onMutation, setActiveTool, drawPoints: [] })

      // Two clicks commit the first circle.
      tool.handlers.onPointerDown!({} as PointerEvent, [1, 1], context)
      tool.handlers.onPointerDown!({} as PointerEvent, [4, 1], context)

      // The tool never disarmed after the first commit.
      expect(setActiveTool).not.toHaveBeenCalled()

      // With the buffer cleared by clearDraw, two more clicks commit a second
      // circle of the same kind - the user's literal ask.
      tool.handlers.onPointerDown!({} as PointerEvent, [5, 5], context)
      tool.handlers.onPointerDown!({} as PointerEvent, [8, 5], context)

      expect(onMutation).toHaveBeenCalledTimes(2)
      expect(onMutation.mock.calls[1][0]).toMatchObject({ type: 'add_entity', kind: 'circle' })
    })

    it('rect stays armed after committing', () => {
      const onMutation = vi.fn()
      const setActiveTool = vi.fn()
      const tool = createDrawingTool({ entityKind: 'rect', paramCount: 0 })
      const context = stickyContext({ onMutation, setActiveTool, drawPoints: [] })

      tool.handlers.onPointerDown!({} as PointerEvent, [1, 2], context)
      tool.handlers.onPointerDown!({} as PointerEvent, [5, 6], context)

      expect(context.clearDraw).toHaveBeenCalled()
      expect(setActiveTool).not.toHaveBeenCalled()
    })

    it('point stays armed after its single-click commit', () => {
      const onMutation = vi.fn()
      const setActiveTool = vi.fn()
      const tool = createDrawingTool({ entityKind: 'point', paramCount: 2 })
      const context = stickyContext({ onMutation, setActiveTool, drawPoints: [] })

      // The point tool commits on the very first click.
      tool.handlers.onPointerDown!({} as PointerEvent, [3, 3], context)

      expect(onMutation).toHaveBeenCalledTimes(1)
      expect(setActiveTool).not.toHaveBeenCalled()
    })

    it('clears the draw buffer on every commit even while staying armed', () => {
      const onMutation = vi.fn()
      const setActiveTool = vi.fn()
      const tool = createDrawingTool({ entityKind: 'circle', paramCount: 3 })
      const context = stickyContext({ onMutation, setActiveTool, drawPoints: [] })

      tool.handlers.onPointerDown!({} as PointerEvent, [1, 1], context)
      tool.handlers.onPointerDown!({} as PointerEvent, [4, 1], context)

      // One clearDraw per commit: no stale point leaks into the next entity.
      expect(context.clearDraw).toHaveBeenCalledTimes(1)
    })

    it('a tool declared staysArmedAfterCommit=false still disarms', async () => {
      const toolPickConfig = await import('@/registry/toolPickConfig')
      const spy = vi.spyOn(toolPickConfig, 'getToolPickConfig').mockReturnValue({
        allowedLayers: null, clearsSelectionOnEnter: false, staysArmedAfterCommit: false,
      })
      try {
        const onMutation = vi.fn()
        const setActiveTool = vi.fn()
        const tool = createDrawingTool({ entityKind: 'circle', paramCount: 3 })
        const context = stickyContext({ onMutation, setActiveTool, drawPoints: [] })

        tool.handlers.onPointerDown!({} as PointerEvent, [1, 1], context)
        tool.handlers.onPointerDown!({} as PointerEvent, [4, 1], context)

        // The branch itself disarms regardless of the current table values.
        expect(setActiveTool).toHaveBeenCalledWith(null)
      } finally {
        spy.mockRestore()
      }
    })
  })
})