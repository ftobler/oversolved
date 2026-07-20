import { describe, it, expect } from 'vitest'
import { computeMeasurements } from '@/utils/geometry/computeMeasurements'
import type { Sketch, BodyResult } from '@/types/cad'

const sketch: Sketch = {
  P1: { x: 0, y: 0 },
  P2: { x: 3, y: 4 },  // dist from P1 = 5
  P3: { x: 6, y: 8 },  // dist from P1 = 10
  L1: { start: [0, 0], end: [3, 4] },  // length = 5
  L2: { start: [1, 0], end: [4, 4] },  // parallel to L1 (same direction)
  L3: { start: [0, 0], end: [4, 0] },  // horizontal, angle to L1 ≈ 53.1°
  A1: { center: [0, 0], radius: 2, angle_start: 0, angle_end: Math.PI / 2, start: [2, 0], end: [0, 2] },
  A2: { center: [5, 0], radius: 1, angle_start: 0, angle_end: Math.PI / 2, start: [6, 0], end: [5, 1] },
  C1: { center: [0, 0], radius: 3 },
  C2: { center: [4, 0], radius: 2 },
}

const sel = (...ids: string[]) => new Set(ids)
const entity = (id: string) => `entity:S1:${id}`
const vertex = (id: string, ref: string) => `vertex:S1:${id}:${ref}`

describe('Measurement Selection and Evaluation', () => {
  describe('1. single vertex', () => {
    it('selects no measurement', () => {
      const result = computeMeasurements(sel(vertex('L1', 'start')), sketch)
      expect(result).toEqual([])
    })
  })

  describe('2. two vertices', () => {
    it('selects distance measurement', () => {
      const result = computeMeasurements(sel(vertex('L1', 'start'), vertex('L1', 'end')), sketch)
      expect(result).toHaveLength(1)
      expect(result[0]).toContain('dist')
    })
    it('evaluates distance correctly', () => {
      const result = computeMeasurements(sel(vertex('L1', 'start'), vertex('L1', 'end')), sketch)
      expect(result).toEqual(['dist: 5.000 mm'])
    })
  })

  describe('3. three+ vertices only', () => {
    it('selects no measurement', () => {
      const result = computeMeasurements(
        sel(vertex('L1', 'start'), vertex('L1', 'end'), vertex('L3', 'end')),
        sketch
      )
      expect(result).toEqual([])
    })
  })

  describe('4. single line segment', () => {
    it('selects length measurement', () => {
      const result = computeMeasurements(sel(entity('L1')), sketch)
      expect(result).toHaveLength(1)
      expect(result[0]).toContain('[LINE]')
    })
    it('evaluates length correctly', () => {
      const result = computeMeasurements(sel(entity('L1')), sketch)
      expect(result).toEqual(['[LINE] 5.000 mm'])
    })
  })

  describe('5. two parallel line segments', () => {
    it('selects parallel distance measurement', () => {
      const result = computeMeasurements(sel(entity('L1'), entity('L2')), sketch)
      expect(result).toHaveLength(1)
      expect(result[0]).toContain('parallel')
    })
    it('evaluates parallel distance correctly', () => {
      const result = computeMeasurements(sel(entity('L1'), entity('L2')), sketch)
      expect(result[0]).toMatch(/parallel lines, distance: \d+\.\d+ mm/)
    })
  })

  describe('6. two non-parallel line segments', () => {
    it('selects angle measurement', () => {
      const result = computeMeasurements(sel(entity('L1'), entity('L3')), sketch)
      expect(result).toHaveLength(1)
      expect(result[0]).toContain('angle')
    })
    it('evaluates angle correctly (acute)', () => {
      const result = computeMeasurements(sel(entity('L1'), entity('L3')), sketch)
      expect(result[0]).toMatch(/angle: \d+\.\d+°/)
      const angleStr = result[0].match(/(\d+\.\d+)/)
      if (angleStr) {
        const angle = parseFloat(angleStr[1])
        expect(angle).toBeLessThan(90)
      }
    })
  })

  describe('7. single arc', () => {
    it('selects arc measurement', () => {
      const result = computeMeasurements(sel(entity('A1')), sketch)
      expect(result).toHaveLength(1)
      expect(result[0]).toContain('[ARC]')
    })
    it('evaluates arc correctly', () => {
      const result = computeMeasurements(sel(entity('A1')), sketch)
      expect(result[0]).toMatch(/\[ARC\] r=2\.000 mm, θ=90°/)
    })
  })

  describe('8. single circle', () => {
    it('selects diameter measurement', () => {
      const result = computeMeasurements(sel(entity('C1')), sketch)
      expect(result).toHaveLength(1)
      expect(result[0]).toContain('[CIRCLE]')
    })
    it('evaluates diameter correctly', () => {
      const result = computeMeasurements(sel(entity('C1')), sketch)
      expect(result).toEqual(['[CIRCLE] d=6.000 mm'])
    })
  })

  describe('9. two arcs', () => {
    it('selects arc center distance measurement', () => {
      const result = computeMeasurements(sel(entity('A1'), entity('A2')), sketch)
      expect(result).toHaveLength(1)
      expect(result[0]).toContain('arc-center')
    })
    it('evaluates arc center distance correctly', () => {
      const result = computeMeasurements(sel(entity('A1'), entity('A2')), sketch)
      expect(result).toEqual(['arc-center dist: 5.000 mm'])
    })
  })

  describe('10. arc + circle', () => {
    it('selects center distance measurement', () => {
      const result = computeMeasurements(sel(entity('A1'), entity('C2')), sketch)
      expect(result).toHaveLength(1)
      expect(result[0]).toContain('center dist')
    })
    it('evaluates center distance correctly', () => {
      const result = computeMeasurements(sel(entity('A1'), entity('C2')), sketch)
      expect(result).toEqual(['center dist: 4.000 mm'])
    })
  })

  describe('11. two circles', () => {
    it('selects circle center distance measurement', () => {
      const result = computeMeasurements(sel(entity('C1'), entity('C2')), sketch)
      expect(result).toHaveLength(1)
      expect(result[0]).toContain('center dist')
    })
    it('evaluates circle center distance correctly', () => {
      const result = computeMeasurements(sel(entity('C1'), entity('C2')), sketch)
      expect(result).toEqual(['center dist: 4.000 mm'])
    })
  })

  describe('12. vertex + arc', () => {
    it('selects center distance measurement', () => {
      const result = computeMeasurements(sel(vertex('L1', 'end'), entity('A1')), sketch)
      expect(result).toHaveLength(1)
      expect(result[0]).toContain('center dist')
    })
    it('evaluates center distance correctly', () => {
      const result = computeMeasurements(sel(vertex('L1', 'end'), entity('A1')), sketch)
      const dist = Math.hypot(3 - 0, 4 - 0)  // L1.end (3,4) to A1 center (0,0)
      expect(result).toEqual([`center dist: ${dist.toFixed(3)} mm`])
    })
  })

  describe('13. vertex + circle', () => {
    it('selects center distance measurement', () => {
      const result = computeMeasurements(sel(vertex('L1', 'end'), entity('C1')), sketch)
      expect(result).toHaveLength(1)
      expect(result[0]).toContain('center dist')
    })
    it('evaluates center distance correctly', () => {
      const result = computeMeasurements(sel(vertex('L1', 'end'), entity('C1')), sketch)
      const dist = Math.hypot(3 - 0, 4 - 0)  // L1.end (3,4) to C1 center (0,0)
      expect(result).toEqual([`center dist: ${dist.toFixed(3)} mm`])
    })
  })

  describe('14. vertex + line segment', () => {
    it('selects point-to-line distance measurement', () => {
      const result = computeMeasurements(sel(vertex('L2', 'start'), entity('L1')), sketch)
      expect(result).toHaveLength(1)
      expect(result[0]).toContain('point-line')
    })
    it('evaluates point-to-line distance correctly', () => {
      const result = computeMeasurements(sel(vertex('L2', 'start'), entity('L1')), sketch)
      expect(result[0]).toMatch(/point-line distance: \d+\.\d+ mm/)
    })
  })

  describe('15. vertex + plane distance', () => {
    const solveResults = {
      builtin_plane_front: {
        plane: {
          origin: [0, 0, 5] as [number, number, number],
          normal: [0, 0, 1] as [number, number, number],
          x_axis: [1, 0, 0] as [number, number, number],
          y_axis: [0, 1, 0] as [number, number, number],
        },
      },
    }
    it('selects plane distance measurement', () => {
      const result = computeMeasurements(
        sel(vertex('L1', 'start'), '@builtin_plane_front'),
        sketch,
        solveResults
      )
      expect(result).toHaveLength(1)
      expect(result[0]).toContain('plane distance')
    })
    it('evaluates plane distance correctly', () => {
      const result = computeMeasurements(
        sel(vertex('L1', 'start'), '@builtin_plane_front'),
        sketch,
        solveResults
      )
      expect(result[0]).toMatch(/plane distance: \d+\.\d+ mm/)
      expect(result[0]).toEqual('plane distance: 5.000 mm')
    })
  })

  describe('16. two parallel planes distance', () => {
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
    it('selects plane distance measurement', () => {
      const result = computeMeasurements(
        sel('@plane1', '@plane2'),
        sketch,
        solveResults
      )
      expect(result).toHaveLength(1)
      expect(result[0]).toContain('plane distance')
    })
    it('evaluates plane distance correctly', () => {
      const result = computeMeasurements(
        sel('@plane1', '@plane2'),
        sketch,
        solveResults
      )
      expect(result[0]).toEqual('plane distance: 5.000 mm')
    })
  })

  describe('17. two non-parallel planes', () => {
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
          origin: [0, 0, 0] as [number, number, number],
          normal: [1, 0, 0] as [number, number, number],
          x_axis: [0, 1, 0] as [number, number, number],
          y_axis: [0, 0, 1] as [number, number, number],
        },
      },
    }
    it('returns empty - non-parallel planes have no standard measurement', () => {
      const result = computeMeasurements(
        sel('@plane1', '@plane2'),
        sketch,
        solveResults
      )
      expect(result).toEqual([])
    })
  })

  describe('18. builtin plane pair (perpendicular)', () => {
    const solveResults = {
      builtin_plane_front: {
        plane: {
          origin: [0, 0, 0] as [number, number, number],
          normal: [0, 0, 1] as [number, number, number],
          x_axis: [1, 0, 0] as [number, number, number],
          y_axis: [0, 1, 0] as [number, number, number],
        },
      },
      builtin_plane_top: {
        plane: {
          origin: [0, 0, 0] as [number, number, number],
          normal: [0, 1, 0] as [number, number, number],
          x_axis: [1, 0, 0] as [number, number, number],
          y_axis: [0, 0, 1] as [number, number, number],
        },
      },
    }
    it('returns empty - perpendicular planes have no measurement', () => {
      const result = computeMeasurements(
        sel('@builtin_plane_front', '@builtin_plane_top'),
        sketch,
        solveResults
      )
      expect(result).toEqual([])
    })
  })

  describe('19. 3D body edge and face measurements', () => {
    const bodyResult: BodyResult = {
      id: 'body_ex1',
      created_by: 'ex1',
      modified_by: [],
      edges: [
        { kind: 'line', start: [0, 0, 0], end: [3, 4, 0] },
        { kind: 'arc', center: [0, 0, 0], radius: 2, axis: [0, 0, 1],
          x_axis: [1, 0, 0], angle_start: 0, angle_end: Math.PI / 2 },
      ],
      mesh: {
        vertices: [],
        faces: [],
        face_data: [
          { centroid: [0, 0, 0], normal: [0, 0, 1], area: 12.5 },
          { centroid: [1, 1, 0], normal: [1, 0, 0], area: 0.0 },
        ],
        face_queries: ['?9;@ex1face0:face', '?9;@ex1face1:face'],
      },
    }
    const bodies = { ex1: bodyResult }

    it('measures line edge length via simple format', () => {
      const r = computeMeasurements(new Set(['@ex1/edge/0']), sketch, undefined, bodies)
      expect(r).toEqual(['[EDGE] 5.000 mm'])
    })

    it('measures arc edge via simple format', () => {
      const r = computeMeasurements(new Set(['@ex1/edge/1']), sketch, undefined, bodies)
      expect(r[0]).toMatch(/\[EDGE\] r=2\.000 mm/)
    })

    it('measures face area via simple format', () => {
      const r = computeMeasurements(new Set(['@ex1/face/0']), sketch, undefined, bodies)
      expect(r).toEqual(['[FACE] area=12.50 mm\u00b2'])
    })

    it('measures edge via ancestry query format', () => {
      const edgeQueries = ['?9;@ex1edge0:edge', '?9;@ex1edge1:edge']
      const bodyWithQueries: BodyResult = { ...bodyResult, edge_queries: edgeQueries }
      const r = computeMeasurements(
        new Set(['?9;@ex1edge0:edge']),
        sketch,
        undefined,
        { ex1: bodyWithQueries }
      )
      expect(r).toEqual(['[EDGE] 5.000 mm'])
    })

    it('measures face via ancestry query format', () => {
      const r = computeMeasurements(
        new Set(['?9;@ex1face0:face']),
        sketch,
        undefined,
        bodies
      )
      expect(r).toEqual(['[FACE] area=12.50 mm\u00b2'])
    })

    it('returns empty for multi-3d selection', () => {
      const r = computeMeasurements(
        new Set(['@ex1/edge/0', '@ex1/edge/1']),
        sketch,
        undefined,
        bodies
      )
      expect(r).toEqual([])
    })

    it('returns empty when bodies not passed', () => {
      const r = computeMeasurements(new Set(['@ex1/edge/0']), sketch)
      expect(r).toEqual([])
    })

    it('returns empty for face with no area data', () => {
      const bodyNoArea: BodyResult = {
        ...bodyResult,
        mesh: { ...bodyResult.mesh!, face_data: [{ centroid: [0,0,0], normal: [0,0,1] }] },
      }
      const r = computeMeasurements(new Set(['@ex1/face/0']), sketch, undefined, { ex1: bodyNoArea })
      expect(r).toEqual([])
    })
  })

  describe('20. 3D body face+face parallel distance', () => {
    const bodyResult: BodyResult = {
      id: 'body_ex1', created_by: 'ex1', modified_by: [],
      edges: [],
      mesh: {
        vertices: [], faces: [],
        face_data: [
          { centroid: [0, 0, 0], normal: [0, 0, 1], area: 10 },
          { centroid: [0, 0, 5], normal: [0, 0, 1], area: 10 },
        ],
        face_queries: ['face0', 'face1'],
      },
    }
    const bodies = { ex1: bodyResult }

    it('measures distance between two parallel faces', () => {
      const r = computeMeasurements(new Set(['@ex1/face/0', '@ex1/face/1']), sketch, undefined, bodies)
      expect(r).toEqual(['plane distance: 5.000 mm'])
    })

    it('returns empty for non-parallel faces', () => {
      const bodyNonParallel: BodyResult = {
        ...bodyResult,
        mesh: {
          ...bodyResult.mesh!,
          face_data: [
            { centroid: [0, 0, 0], normal: [0, 0, 1], area: 10 },
            { centroid: [0, 0, 0], normal: [1, 0, 0], area: 10 },
          ],
        },
      }
      const r = computeMeasurements(new Set(['@ex1/face/0', '@ex1/face/1']), sketch, undefined, { ex1: bodyNonParallel })
      expect(r).toEqual([])
    })
  })

  describe('21. 3D body face+vertex perpendicular distance', () => {
    const bodyResult: BodyResult = {
      id: 'body_ex1', created_by: 'ex1', modified_by: [],
      edges: [],
      vertices: [[0, 0, 10] as [number, number, number]],
      vertex_queries: ['vert0'],
      mesh: {
        vertices: [], faces: [],
        face_data: [
          { centroid: [0, 0, 0], normal: [0, 0, 1], area: 10 },
        ],
        face_queries: ['face0'],
      },
    }
    const bodies = { ex1: bodyResult }

    it('measures perpendicular distance from vertex to face plane', () => {
      const r = computeMeasurements(new Set(['@ex1/face/0', '@ex1/vertex/0']), sketch, undefined, bodies)
      expect(r).toEqual(['plane distance: 10.000 mm'])
    })
  })

  describe('22. 3D body face+edge perpendicular distance', () => {
    const bodyResult: BodyResult = {
      id: 'body_ex1', created_by: 'ex1', modified_by: [],
      edges: [
        { kind: 'line', start: [0, 0, 10], end: [4, 0, 10] },
      ],
      edge_queries: ['edge0'],
      mesh: {
        vertices: [], faces: [],
        face_data: [
          { centroid: [0, 0, 0], normal: [0, 0, 1], area: 10 },
        ],
        face_queries: ['face0'],
      },
    }
    const bodies = { ex1: bodyResult }

    it('measures perpendicular distance from edge midpoint to face plane', () => {
      const r = computeMeasurements(new Set(['@ex1/face/0', '@ex1/edge/0']), sketch, undefined, bodies)
      expect(r).toEqual(['plane distance: 10.000 mm'])
    })
  })

  describe('23. selection-string parsing edge cases', () => {
    it('ignores ids that are neither entity, vertex, plane, nor a 3D ref', () => {
      // A junk id falls through the else-continue and only L1 is measured.
      const result = computeMeasurements(sel('garbage', entity('L1')), sketch)
      expect(result).toEqual(['[LINE] 5.000 mm'])
    })

    it('skips an entity selection with an empty entity id', () => {
      const result = computeMeasurements(sel('entity:S1:', entity('L1')), sketch)
      expect(result).toEqual(['[LINE] 5.000 mm'])
    })

    it('skips a selection that references a missing sketch entity', () => {
      const result = computeMeasurements(sel(entity('GHOST'), entity('L1')), sketch)
      expect(result).toEqual(['[LINE] 5.000 mm'])
    })
  })

  describe('24. point entities selected as whole entities', () => {
    it('classifies a whole-entity point as a point (lone point has no measurement)', () => {
      const result = computeMeasurements(sel(entity('P1')), sketch)
      expect(result).toEqual([])
    })

    it('measures the distance between two whole-entity points', () => {
      // P1 (0,0) and P2 (3,4) selected as entities -> point-point distance.
      const result = computeMeasurements(sel(entity('P1'), entity('P2')), sketch)
      expect(result).toEqual(['dist: 5.000 mm'])
    })
  })

  describe('25. no measurement match', () => {
    it('reports a "No match" summary for an unmeasurable combination', () => {
      // line + circle matches no single/pair/plane rule -> the count summary.
      const result = computeMeasurements(sel(entity('L1'), entity('C1')), sketch)
      expect(result).toEqual(['No match for 1x line, 1x circle'])
    })
  })
})
