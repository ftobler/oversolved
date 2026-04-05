import { describe, it, expect } from 'vitest'
import { computeMeasurements } from '../computeMeasurements'
import type { Sketch } from '../../types/cad'

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
      expect(result).toEqual(['dist: 5.00 mm'])
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
      expect(result).toEqual(['[LINE] 5.00 mm'])
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
      expect(result[0]).toMatch(/\[ARC\] r=2\.00 mm, θ=90°/)
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
      expect(result).toEqual(['[CIRCLE] d=6.00 mm'])
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
      expect(result).toEqual(['arc-center dist: 5.00 mm'])
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
      expect(result).toEqual(['center dist: 4.00 mm'])
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
      expect(result).toEqual(['center dist: 4.00 mm'])
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
      expect(result).toEqual([`center dist: ${dist.toFixed(2)} mm`])
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
      expect(result).toEqual([`center dist: ${dist.toFixed(2)} mm`])
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

  describe('15. vertex + builtin plane (filtered)', () => {
    it('returns empty - planes are filtered', () => {
      const result = computeMeasurements(sel(vertex('L1', 'start'), '@builtin_plane_front'), sketch)
      expect(result).toEqual([])
    })
  })

  describe('16. vertex + boundary surface (filtered)', () => {
    it('returns empty - faces are filtered', () => {
      const result = computeMeasurements(
        sel(vertex('L1', 'start'), 'face:sketch1:?3;@sketch1abc'),
        sketch
      )
      expect(result).toEqual([])
    })
  })

  describe('17. two parallel planes/boundaries', () => {
    it('returns empty - no 3D topology data at sketch level', () => {
      const result = computeMeasurements(
        sel('@builtin_plane_front', '@builtin_plane_back'),
        sketch
      )
      expect(result).toEqual([])
    })
  })

  describe('18. two non-parallel planes/boundaries', () => {
    it('returns empty - no 3D topology data at sketch level', () => {
      const result = computeMeasurements(
        sel('@builtin_plane_front', '@builtin_plane_right'),
        sketch
      )
      expect(result).toEqual([])
    })
  })
})
