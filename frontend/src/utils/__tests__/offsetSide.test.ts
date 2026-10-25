// The sign of `apply_offset` on a closed selection means one side whatever the
// loop's winding: positive goes out of the bounded region. Birdhouse F3 saw +2
// go inward on a CCW triangle and Case_Seam_Lip F6 saw -1 go inward on a
// projected rim (r4 -> r3): the seed rule followed each line's own direction.
// Three loops pin it: a CCW triangle, the same triangle drawn CW, and a
// rounded rectangle whose lines and arcs run the mixed directions a projected
// loop has.

import { describe, it, expect } from 'vitest'
import type { PartDoc } from '@/types/cad'
import { applyAddOffset, applyAddEntity } from '@/utils/yamlMutations'
import { offsetSideFactors } from '@/utils/geometry/offsetSide'
import { sketchAt } from '@/testing/featureAccess'

function sketchDoc(): PartDoc {
  return { features: [{ id: 'sk', kind: 'sketch', plane: '@builtin_plane_front', entities: [], initial: {}, constraints: [] }] }
}

type Row = [string, string, number[]]

function build(rows: Row[]): PartDoc {
  const doc = sketchDoc()
  for (const [id, kind, params] of rows) applyAddEntity(doc, 'sk', kind, params, id)
  return doc
}

// The clone's distance from the loop centre minus its source's: > 0 is outward.
function radialShift(doc: PartDoc, sourceIds: string[], centre: [number, number]): number[] {
  const f = sketchAt(doc)
  const clones = f.entities!.map((e) => e.id).filter((id) => !sourceIds.includes(id))
  const reach = (id: string): number => {
    const p = f.initial![id]
    const kind = f.entities!.find((e) => e.id === id)!.kind
    if (kind === 'line') {
      // The line's distance from the centre (its infinite carrier).
      const dx = p[2] - p[0], dy = p[3] - p[1]
      return Math.abs((centre[0] - p[0]) * dy - (centre[1] - p[1]) * dx) / Math.hypot(dx, dy)
    }
    return Math.hypot(p[0] - centre[0], p[1] - centre[1]) + p[2]
  }
  return sourceIds.map((id, i) => reach(clones[i]) - reach(id))
}

const CCW: Row[] = [
  ['o1', 'line', [-54, 0, 54, 0]],
  ['o2', 'line', [54, 0, 0, 85]],
  ['o3', 'line', [0, 85, -54, 0]],
]
const CW: Row[] = [
  ['o1', 'line', [54, 0, -54, 0]],
  ['o2', 'line', [-54, 0, 0, 85]],
  ['o3', 'line', [0, 85, 54, 0]],
]
// A 20 x 12 rounded rectangle, r 4 corners, lines drawn in no consistent
// direction (as projected edges arrive).
const ROUNDED: Row[] = [
  ['b', 'line', [6, 0, -6, 0]],
  ['r', 'line', [10, 4, 10, 8]],
  ['t', 'line', [-6, 12, 6, 12]],
  ['l', 'line', [-10, 4, -10, 8]],
  ['c1', 'arc', [6, 4, 4, 270, 360]],
  ['c2', 'arc', [6, 8, 4, 0, 90]],
  ['c3', 'arc', [-6, 8, 4, 90, 180]],
  ['c4', 'arc', [-6, 4, 4, 180, 270]],
]

describe('apply_offset sign on a closed loop', () => {
  const cases: Array<[string, Row[], [number, number]]> = [
    ['CCW triangle', CCW, [0, 28]],
    ['CW triangle', CW, [0, 28]],
    ['rounded rectangle with mixed directions', ROUNDED, [0, 6]],
  ]
  for (const [name, rows, centre] of cases) {
    it(`${name}: positive goes outward, negative inward`, () => {
      const ids = rows.map(([id]) => id)
      for (const [distance, sign] of [[2, 1], [-1, -1]] as const) {
        const doc = build(rows)
        applyAddOffset(doc, 'sk', ids, distance)
        for (const shift of radialShift(doc, ids, centre)) {
          expect(Math.sign(shift), `${name} distance ${distance}`).toBe(sign)
          expect(Math.abs(shift)).toBeCloseTo(Math.abs(distance), 6)
        }
      }
    })
  }

  it('keeps the seed rule for an open selection', () => {
    expect(offsetSideFactors([{ id: 'a', kind: 'line', params: [0, 0, 10, 0] }]).size).toBe(0)
  })

  it('treats a selected inner loop as a hole: its positive offset shrinks it', () => {
    const factors = offsetSideFactors([
      { id: 'outer', kind: 'circle', params: [0, 0, 20] },
      { id: 'inner', kind: 'circle', params: [0, 0, 5] },
    ])
    expect(factors.get('outer')).toBe(1)
    expect(factors.get('inner')).toBe(-1)
  })
})
