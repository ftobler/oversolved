import { describe, it, expect } from 'vitest'
import { measure3dSelection } from '@/registry/measurementRegistry'
import type { BodyResult, EdgeData } from '@/types/cad'

// measure3dSelection (and its findBodyElement reverse-lookup) is reached only
// indirectly via computeMeasurements today, which leaves several branches
// uncovered: the query-string vertex lookup, the not-found path, a non
// line/arc edge, the two-line angle/parallel split, the two-arc center
// distance, and the "neither 1 nor 2 picks" guard. This drives the function
// directly with BodyResult fixtures.

const edges: EdgeData[] = [
  { kind: 'line', start: [0, 0, 0], end: [10, 0, 0] },                                            // 0: +x
  { kind: 'arc', center: [0, 0, 0], radius: 2, axis: [0, 0, 1], x_axis: [1, 0, 0], angle_start: 0, angle_end: Math.PI },  // 1
  { kind: 'spline', points: [[0, 0, 0], [1, 1, 0], [2, 0, 0]] },                                  // 2
  { kind: 'line', start: [0, 5, 0], end: [10, 5, 0] },                                            // 3: +x, parallel to 0, offset 5
  { kind: 'line', start: [0, 0, 0], end: [0, 10, 0] },                                            // 4: +y, perpendicular to 0
  { kind: 'circle', center: [3, 4, 0], radius: 1, axis: [0, 0, 1], x_axis: [1, 0, 0], angle_start: 0, angle_end: 2 * Math.PI }, // 5
]

function makeBody(): BodyResult {
  return {
    id: 'B',
    created_by: 'ex',
    modified_by: [],
    edges,
    edge_queries: ['q0', 'q1', 'q2', 'q3', 'q4', 'q5'],
    vertices: [[1, 2, 3]],
    vertex_queries: ['vq0'],
  }
}

const bodies = (): Record<string, BodyResult> => ({ B: makeBody() })

describe('measure3dSelection findBodyElement reverse-lookup', () => {
  it('resolves a vertex by its query string (single vertex pick has no measurement)', () => {
    expect(measure3dSelection(new Set(['vq0']), bodies())).toEqual([])
  })

  it('returns [] when the id resolves to nothing', () => {
    expect(measure3dSelection(new Set(['not-a-real-id']), bodies())).toEqual([])
  })
})

describe('measure3dSelection single edge', () => {
  it('returns [] for an edge kind that is neither line nor arc/circle (spline)', () => {
    expect(measure3dSelection(new Set(['q2']), bodies())).toEqual([])
  })
})

describe('measure3dSelection two edges', () => {
  it('two perpendicular lines report the angle', () => {
    const r = measure3dSelection(new Set(['q0', 'q4']), bodies())
    expect(r).toEqual(['edge angle: 90.0°'])
  })

  it('two parallel lines report the perpendicular distance', () => {
    const r = measure3dSelection(new Set(['q0', 'q3']), bodies())
    expect(r).toEqual(['parallel edges, distance: 5.000 mm'])
  })

  it('two arc/circle edges report the center-to-center distance', () => {
    // arc center (0,0,0), circle center (3,4,0) -> distance 5
    const r = measure3dSelection(new Set(['q1', 'q5']), bodies())
    expect(r).toEqual(['center dist: 5.000 mm'])
  })
})

// A face pair is labelled from the two surface types, not from a fixed string:
// two cylinders have no plane between them, the number is an axis offset.
const faceData = [
  { centroid: [0, 0, 0] as [number, number, number], normal: [0, 0, 1] as [number, number, number], surface_type: 'flatface' },      // 0
  { centroid: [0, 0, 4] as [number, number, number], normal: [0, 0, 1] as [number, number, number], surface_type: 'flatface' },      // 1
  { centroid: [0, 0, 0] as [number, number, number], normal: [1, 0, 0] as [number, number, number], surface_type: 'cylinderface' },  // 2
  { centroid: [4, 0, 0] as [number, number, number], normal: [1, 0, 0] as [number, number, number], surface_type: 'cylinderface' },  // 3
  { centroid: [0, 0, 4] as [number, number, number], normal: [0, 0, 1] as [number, number, number], surface_type: 'cylinderface' },  // 4
  { centroid: [0, 0, 0] as [number, number, number], normal: [0, 0, 1] as [number, number, number] },                                // 5: pre-surface_type body
  { centroid: [0, 0, 4] as [number, number, number], normal: [0, 0, 1] as [number, number, number] },                                // 6: pre-surface_type body
]

function faceBodies(): Record<string, BodyResult> {
  return {
    B: {
      id: 'B',
      created_by: 'ex',
      modified_by: [],
      mesh: {
        vertices: [],
        faces: [],
        face_data: faceData,
        face_queries: ['f0', 'f1', 'f2', 'f3', 'f4', 'f5', 'f6'],
      },
    },
  }
}

describe('measure3dSelection two faces', () => {
  it('two planar faces report a plane distance', () => {
    expect(measure3dSelection(new Set(['f0', 'f1']), faceBodies())).toEqual(['plane distance: 4.000 mm'])
  })

  it('two cylindrical faces report a center distance', () => {
    expect(measure3dSelection(new Set(['f2', 'f3']), faceBodies())).toEqual(['center distance: 4.000 mm'])
  })

  it('a planar + cylindrical mix keeps the plane wording', () => {
    expect(measure3dSelection(new Set(['f0', 'f4']), faceBodies())).toEqual(['plane distance: 4.000 mm'])
  })

  it('faces without a surface_type keep the plane wording', () => {
    expect(measure3dSelection(new Set(['f5', 'f6']), faceBodies())).toEqual(['plane distance: 4.000 mm'])
  })
})

describe('measure3dSelection selection-count guard', () => {
  it('returns [] for an empty selection', () => {
    expect(measure3dSelection(new Set([]), bodies())).toEqual([])
  })

  it('returns [] for three or more picks', () => {
    expect(measure3dSelection(new Set(['q0', 'q3', 'q4']), bodies())).toEqual([])
  })
})
