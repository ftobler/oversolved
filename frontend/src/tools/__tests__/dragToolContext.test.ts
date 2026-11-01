// The drag tool context is assembled from one builder: the activation frame and
// the commit frame used to spell the same literal out twice.
import { describe, it, expect, vi } from 'vitest'
import { buildDragToolContext, type DragContextSource } from '@/tools/DragTool'
import type { DragState, DragPendingState } from '@/stores/sketchEditorStore'

const vertexDrag: DragState = {
  type: 'vertex', vertexId: 'vertex:S1:lineA:start', featureId: 'S1',
  entityId: 'lineA', vertexKey: 'start', startWorld: [0, 0], currentWorld: [1, 1],
  startClient: [10, 10],
}

function source(over: Partial<DragContextSource> = {}): DragContextSource {
  return {
    normalSelection: new Set(['entity:S1:lineB']),
    hoveredSelectionId: 'entity:S1:lineA',
    isPointerDown: true,
    activeFeatureId: 'S1',
    hoveredVertexId: 'vertex:S1:lineA:start',
    hoveredVertexPosition: [0, 0],
    hoveredSnapKind: 'vertex',
    drag: vertexDrag,
    dragPending: null,
    dragSnap: null,
    dragStartClient: [10, 10],
    ...over,
  }
}

const handlers = () => ({
  onMutation: vi.fn(),
  setDrag: vi.fn(),
  setDragPending: vi.fn(),
  setDragSnap: vi.fn(),
})

describe('buildDragToolContext', () => {
  it('carries the store fields through', () => {
    const h = handlers()
    const ctx = buildDragToolContext(source(), h)
    expect(ctx.normalSelection).toEqual(new Set(['entity:S1:lineB']))
    expect(ctx.hoveredSelectionId).toBe('entity:S1:lineA')
    expect(ctx.isPointerDown).toBe(true)
    expect(ctx.activeFeatureId).toBe('S1')
    expect(ctx.hoveredVertexId).toBe('vertex:S1:lineA:start')
    expect(ctx.hoveredVertexPosition).toEqual([0, 0])
    expect(ctx.hoveredSnapKind).toBe('vertex')
    expect(ctx.drag).toBe(vertexDrag)
    expect(ctx.dragSnap).toBeNull()
    expect(ctx.startClient).toEqual([10, 10])
    expect(ctx.onMutation).toBe(h.onMutation)
    expect(ctx.setDrag).toBe(h.setDrag)
    expect(ctx.setDragPending).toBe(h.setDragPending)
    expect(ctx.setDragSnap).toBe(h.setDragSnap)
  })

  it('lets the activation frame override the hover with the press point', () => {
    const ctx = buildDragToolContext(source(), handlers(), {
      hoveredVertexId: 'vertex:S1:lineA:start',
      hoveredVertexPosition: [4, 0],
      drag: null,
    })
    expect(ctx.hoveredVertexPosition).toEqual([4, 0])
    expect(ctx.drag).toBeNull()
  })

  it('narrows a dimension-label drag out of the tool context', () => {
    // A dim-label drag is the DragPlane's own gesture; the drag tool must never
    // see it as a vertex/edge drag.
    const dim: DragState = {
      type: 'dim_label', constraintId: 'c1', featureId: 'S1',
      anchorWorld: [0, 0], startWorld: [0, 0], currentWorld: [1, 1],
    }
    expect(buildDragToolContext(source({ drag: dim }), handlers()).drag).toBeNull()
  })

  it('narrows a feature-handle pending drag out of the tool context', () => {
    const pending: DragPendingState = {
      type: 'feature_handle', featureId: 'F1', field: 'distance',
      startValue: 1, axisOrigin: [0, 0, 0], axisDir: [0, 0, 1], unitScale: 1, min: 0,
    }
    expect(buildDragToolContext(source({ dragPending: pending }), handlers()).dragPending).toBeNull()
  })

  it('the mode stack is a no-op: the store owns it', () => {
    const ctx = buildDragToolContext(source(), handlers())
    expect(() => { ctx.pushMode('drag'); ctx.popMode('drag') }).not.toThrow()
  })
})
