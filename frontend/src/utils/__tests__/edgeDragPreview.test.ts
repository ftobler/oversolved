import { describe, it, expect } from 'vitest'
import { edgeDragPreview } from '@/utils/geometry/edgeDragPreview'
import type { Sketch } from '@/types/cad'
import type { VertexOrEdgeDrag } from '@/stores/sketchEditorStore'

describe('edgeDragPreview', () => {
  it('moves all line vertices by the delta', () => {
    const sketch: Sketch = {
      L1: { start: [0, 0], end: [10, 0] },
      L2: { start: [10, 0], end: [10, 10] },
    } as unknown as Sketch
    const drag: VertexOrEdgeDrag & { type: 'edge' } = {
      type: 'edge',
      vertexId: 'entity:S1:L1',
      featureId: 'S1',
      entityId: 'L1',
      vertexKey: '',
      startWorld: [5, 0],
      currentWorld: [8, 2],
      startClient: [100, 100],
    }

    const result = edgeDragPreview(sketch, drag)

    // L1 start: [0,0] + [3,2] = [3,2]
    expect((result.L1 as { start: [number, number]; end: [number, number] }).start).toEqual([3, 2])
    // L1 end: [10,0] + [3,2] = [13,2]
    expect((result.L1 as { start: [number, number]; end: [number, number] }).end).toEqual([13, 2])
    // L2 (different entity) unchanged
    expect((result.L2 as { start: [number, number]; end: [number, number] }).start).toEqual([10, 0])
  })

  it('returns sketch unchanged when edge has not moved', () => {
    const sketch: Sketch = {
      L1: { start: [0, 0], end: [10, 0] },
    } as unknown as Sketch
    const drag: VertexOrEdgeDrag & { type: 'edge' } = {
      type: 'edge',
      vertexId: 'entity:S1:L1',
      featureId: 'S1',
      entityId: 'L1',
      vertexKey: '',
      startWorld: [5, 0],
      currentWorld: [5, 0],
      startClient: [100, 100],
    }

    const result = edgeDragPreview(sketch, drag)

    expect(result).toBe(sketch)
  })

  it('moves circle center by the delta', () => {
    const sketch: Sketch = {
      C1: { center: [0, 0], radius: 5 },
    } as unknown as Sketch
    const drag: VertexOrEdgeDrag & { type: 'edge' } = {
      type: 'edge',
      vertexId: 'entity:S1:C1',
      featureId: 'S1',
      entityId: 'C1',
      vertexKey: '',
      startWorld: [0, 0],
      currentWorld: [3, -2],
      startClient: [100, 100],
    }

    const result = edgeDragPreview(sketch, drag)

    expect((result.C1 as { center: [number, number] }).center).toEqual([3, -2])
  })

  it('moves arc start/end/center by the delta', () => {
    const sketch: Sketch = {
      A1: {
        center: [5, 5],
        start: [5, 10],
        end: [10, 5],
        radius: 5,
        angle_start: 90,
        angle_end: 0,
      },
    } as unknown as Sketch
    const drag: VertexOrEdgeDrag & { type: 'edge' } = {
      type: 'edge',
      vertexId: 'entity:S1:A1',
      featureId: 'S1',
      entityId: 'A1',
      vertexKey: '',
      startWorld: [5, 5],
      currentWorld: [8, 10],
      startClient: [100, 100],
    }

    const result = edgeDragPreview(sketch, drag)

    const arc = result.A1 as { center: [number, number]; start: [number, number]; end: [number, number] }
    expect(arc.center).toEqual([8, 10])
    expect(arc.start).toEqual([8, 15])
    expect(arc.end).toEqual([13, 10])
  })

  it('moves point entity by the delta', () => {
    const sketch: Sketch = {
      P1: { x: 1, y: 2 },
    } as unknown as Sketch
    const drag: VertexOrEdgeDrag & { type: 'edge' } = {
      type: 'edge',
      vertexId: 'entity:S1:P1',
      featureId: 'S1',
      entityId: 'P1',
      vertexKey: '',
      startWorld: [1, 2],
      currentWorld: [4, 6],
      startClient: [100, 100],
    }

    const result = edgeDragPreview(sketch, drag)

    expect(result.P1 as { x: number; y: number }).toEqual({ x: 4, y: 6 })
  })

  it('moves spline control points by the delta', () => {
    const sketch: Sketch = {
      S1: { p1: [0, 0], p2: [5, 5], p3: [10, 5], p4: [15, 0] },
    } as unknown as Sketch
    const drag: VertexOrEdgeDrag & { type: 'edge' } = {
      type: 'edge',
      vertexId: 'entity:S1:S1',
      featureId: 'S1',
      entityId: 'S1',
      vertexKey: '',
      startWorld: [7.5, 2.5],
      currentWorld: [10, 5],
      startClient: [100, 100],
    }

    const result = edgeDragPreview(sketch, drag)

    const spline = result.S1 as { p1: [number, number]; p2: [number, number]; p3: [number, number]; p4: [number, number] }
    expect(spline.p1).toEqual([2.5, 2.5])
    expect(spline.p2).toEqual([7.5, 7.5])
    expect(spline.p3).toEqual([12.5, 7.5])
    expect(spline.p4).toEqual([17.5, 2.5])
  })

  it('does not mutate the input sketch', () => {
    const sketch: Sketch = {
      L1: { start: [0, 0], end: [10, 0] },
    } as unknown as Sketch
    const drag: VertexOrEdgeDrag & { type: 'edge' } = {
      type: 'edge',
      vertexId: 'entity:S1:L1',
      featureId: 'S1',
      entityId: 'L1',
      vertexKey: '',
      startWorld: [0, 0],
      currentWorld: [5, 5],
      startClient: [100, 100],
    }

    const result = edgeDragPreview(sketch, drag)

    expect(result).not.toBe(sketch)
    expect((sketch.L1 as { start: [number, number] }).start).toEqual([0, 0])
    expect((result.L1 as { start: [number, number] }).start).toEqual([5, 5])
  })
})
