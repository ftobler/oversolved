import { describe, it, expect } from 'vitest'
import { computeMeasurements } from '@/utils/geometry/computeMeasurements'
import type { Sketch, PartResult } from '@/types/cad'

// The page-facing caller. The rules and adapters have their own suites; this pin
// the signature and the behaviour a sketch/part caller sees through it.
const sketch: Sketch = {
  P1: { x: 0, y: 0 },
  P2: { x: 3, y: 4 },  // dist from P1 = 5
  P3: { x: 6, y: 8 },
  L1: { start: [0, 0], end: [3, 4] },  // length = 5
  L2: { start: [1, 0], end: [4, 4] },  // parallel to L1
  L3: { start: [0, 0], end: [4, 0] },  // horizontal, angle to L1 = 53.1 deg
  A1: { center: [0, 0], radius: 2, angle_start: 0, angle_end: 90, start: [2, 0], end: [0, 2] },
  C1: { center: [0, 0], radius: 3 },
  SP1: { p1: [0, 0], p2: [1, 1], p3: [2, 1], p4: [3, 0] },
  E1: { center: [0, 0], a: 4, b: 2, theta: 0 },
  V: { x: 10, y: 0 },  // beyond L1's far endpoint, for the infinite-line rule
}

const sel = (...ids: string[]) => new Set(ids)
const entity = (id: string) => `entity:S1:${id}`
const vertex = (id: string, ref: string) => `vertex:S1:${id}:${ref}`

describe('computeMeasurements: the document length unit', () => {
  it('labels a sketch measurement in inches without converting the number', () => {
    expect(computeMeasurements(sel(entity('L1')), sketch, undefined, undefined, 'inch'))
      .toEqual(['length 5.000 in'])
  })

  it('forwards the unit to the 3D body measurements', () => {
    const parts: Record<string, PartResult> = {
      body_ex: {
        id: 'body_ex',
        created_by: 'ex',
        modified_by: [],
        edges: [{ kind: 'line', start: [0, 0, 0], end: [3, 4, 0] }],
        edge_queries: ['?body_ex:edge:0'],
      },
    }
    expect(computeMeasurements(sel('?body_ex:edge:0'), sketch, undefined, parts, 'inch'))
      .toEqual(['length 5.000 in'])
  })
})

describe('computeMeasurements: singles', () => {
  it('reads a line length, an arc radius and sweep, and a circle diameter', () => {
    expect(computeMeasurements(sel(entity('L1')), sketch)).toEqual(['length 5.000 mm'])
    expect(computeMeasurements(sel(entity('A1')), sketch)).toEqual(['radius 2.000 mm', 'angle 90.0°'])
    expect(computeMeasurements(sel(entity('C1')), sketch)).toEqual(['diameter 6.000 mm'])
  })

  it('reads nothing for a lone point or vertex', () => {
    expect(computeMeasurements(sel(entity('P1')), sketch)).toEqual([])
    expect(computeMeasurements(sel(vertex('L1', 'start')), sketch)).toEqual([])
  })
})

describe('computeMeasurements: sketch pairs', () => {
  it('measures two vertices as their distance plus the delta legs', () => {
    expect(computeMeasurements(sel(vertex('L1', 'start'), vertex('L1', 'end')), sketch))
      .toEqual(['distance 5.000 mm', 'dx 3.000 mm', 'dy 4.000 mm', 'dz 0.000 mm'])
  })

  it('refuses three vertices', () => {
    expect(computeMeasurements(sel(vertex('L1', 'start'), vertex('L1', 'end'), vertex('L3', 'end')), sketch))
      .toEqual([])
  })

  it('measures two whole point entities as their distance plus the delta legs', () => {
    expect(computeMeasurements(sel(entity('P1'), entity('P2')), sketch))
      .toEqual(['distance 5.000 mm', 'dx 3.000 mm', 'dy 4.000 mm', 'dz 0.000 mm'])
  })

  it('reads two parallel lines as their distance and offset, two oblique lines as an angle and supplement', () => {
    expect(computeMeasurements(sel(entity('L1'), entity('L2')), sketch))
      .toEqual(['distance 0.800 mm', 'alignment offset 0.600 mm'])
    expect(computeMeasurements(sel(entity('L1'), entity('L3')), sketch))
      .toEqual(['angle 53.1°', 'supplement 126.9°'])
  })

  it('reads a point against a line with the infinite line, not a clamped segment (D6)', () => {
    // V (10, 0) is past L1's endpoint (3, 4): the clamped distance is 8.06, the
    // infinite line is 8, with the foot on the edge's extension.
    expect(computeMeasurements(sel(entity('V'), entity('L1')), sketch))
      .toEqual(['distance 8.000 mm (on extension)'])
  })

  it('reads a vertex to a circle and two concentric circles as centre-based readouts', () => {
    expect(computeMeasurements(sel(vertex('L1', 'end'), entity('C1')), sketch))
      .toEqual(['center distance 5.000 mm', 'dx 3.000 mm', 'dy 4.000 mm', 'dz 0.000 mm'])
    expect(computeMeasurements(sel(entity('C1'), entity('A1')), sketch))
      .toEqual(['axial distance 0.000 mm', 'radial gap 1.000 mm'])
  })
})

describe('computeMeasurements: datum planes', () => {
  const solveResults = {
    plane1: {
      plane: {
        origin: [0, 0, 0] as [number, number, number],
        normal: [0, 0, 1] as [number, number, number],
        x_axis: [1, 0, 0] as [number, number, number],
        y_axis: [0, 1, 0] as [number, number, number],
      },
    },
    plane2: {
      plane: {
        origin: [0, 0, 5] as [number, number, number],
        normal: [0, 0, 1] as [number, number, number],
        x_axis: [1, 0, 0] as [number, number, number],
        y_axis: [0, 1, 0] as [number, number, number],
      },
    },
  }

  it('measures two parallel planes by their distance', () => {
    expect(computeMeasurements(sel('@plane1', '@plane2'), sketch, solveResults))
      .toEqual(['distance 5.000 mm'])
  })

  it('measures two perpendicular planes by their angle', () => {
    const perpendicular = {
      ...solveResults,
      plane2: { plane: { ...solveResults.plane2.plane, normal: [1, 0, 0] as [number, number, number] } },
    }
    expect(computeMeasurements(sel('@plane1', '@plane2'), sketch, perpendicular))
      .toEqual(['angle 90.0°', 'supplement 90.0°'])
  })

  it('reads a plane against a sketch point', () => {
    expect(computeMeasurements(sel(vertex('L1', 'start'), '@plane2'), sketch, solveResults))
      .toEqual(['distance 5.000 mm'])
  })
})

describe('computeMeasurements: vertices resolve through geomPoint', () => {
  it('resolves a spline control point and an ellipse axis handle', () => {
    expect(computeMeasurements(sel(vertex('SP1', 'c1'), vertex('L1', 'start')), sketch))
      .toEqual(['distance 1.414 mm', 'dx 1.000 mm', 'dy 1.000 mm', 'dz 0.000 mm'])
    expect(computeMeasurements(sel(vertex('E1', 'major1'), vertex('L1', 'start')), sketch))
      .toEqual(['distance 4.000 mm', 'dx 4.000 mm', 'dy 0.000 mm', 'dz 0.000 mm'])
  })
})

describe('computeMeasurements: unmeasurable selections', () => {
  it('reads nothing when a pick cannot be resolved', () => {
    // A junk or stale id is not skipped into a smaller, more readable selection.
    expect(computeMeasurements(sel('garbage', entity('L1')), sketch)).toEqual([])
    expect(computeMeasurements(sel(entity('GHOST'), entity('L1')), sketch)).toEqual([])
    expect(computeMeasurements(sel('entity:S1:', entity('L1')), sketch)).toEqual([])
  })

  it('reads nothing for two picks plus a whole-body pick', () => {
    expect(computeMeasurements(sel(entity('L1'), entity('L3'), '@body_ex1'), sketch)).toEqual([])
  })

  it('does not read a whole-body pick as a plane-id lookup', () => {
    const solveResults = {
      body_ex1: { plane: { origin: [0, 0, 0], normal: [0, 0, 1], x_axis: [1, 0, 0], y_axis: [0, 1, 0] } },
      body_ex2: { plane: { origin: [0, 0, 7], normal: [0, 0, 1], x_axis: [1, 0, 0], y_axis: [0, 1, 0] } },
    }
    expect(computeMeasurements(sel('@body_ex1', '@body_ex2'), sketch, solveResults)).toEqual([])
  })
})
