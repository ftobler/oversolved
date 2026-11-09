// The sign of `apply_offset` on a closed selection means one side whatever the
// loop's winding: positive goes out of the bounded region. Birdhouse F3 saw +2
// go inward on a CCW triangle and Case_Seam_Lip F6 saw -1 go inward on a
// projected rim (r4 -> r3): the seed rule followed each line's own direction.
// Three loops pin it: a CCW triangle, the same triangle drawn CW, and a
// rounded rectangle whose lines and arcs run the mixed directions a projected
// loop has.

import { describe, it, expect, vi } from 'vitest'
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

// An open chain has no region to be outside of, so +d has to name one side of
// the walk for every entity or the chain falls apart: an L that turns left with
// a fillet used to offset its lines inward but grow the arc outward, and the
// source-tangent joints then dragged the authored geometry. The walk starts at
// the chain end of the first listed source, and +d is its left.
const LEFT_TURN: Row[] = [
  ['l1', 'line', [0, 0, -7, 0]],
  ['a1', 'arc', [-7, -3, 3, 90, 180]],
  ['l2', 'line', [-10, -3, -10, -10]],
]
const RIGHT_TURN: Row[] = [
  ['l1', 'line', [0, 0, 7, 0]],
  ['a1', 'arc', [7, -3, 3, 0, 90]],
  ['l2', 'line', [10, -3, 10, -10]],
]

function sourcesOf(rows: Row[]) {
  return rows.map(([id, kind, params]) => ({ id, kind, params }))
}

/** The clone a source's offset relationship points at, as its stored params. */
function clonesOf(rows: Row[], distance: number): Record<string, number[]> {
  const doc = build(rows)
  applyAddOffset(doc, 'sk', rows.map(([id]) => id), distance)
  const f = sketchAt(doc)
  return Object.fromEntries(rows.map(([id]) => {
    const relation = f.constraints!.find(
      (c) => (c.kind === 'parallel' || c.kind === 'concentric') && c.a === '$' + id,
    )!
    return [id, f.initial![(relation.b as string).slice(1)]]
  }))
}

/** A line segment's two endpoints in canonical (sorted) order, so a clone that
 *  traverses the same segment the other way still compares equal. */
function segment(params: number[]): number[] {
  const a = [params[0], params[1]], b = [params[2], params[3]]
  return (a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]) ? [a, b] : [b, a]).flat()
}

describe('apply_offset side on an open chain', () => {
  it('open_chain_turning_left_offsets_lines_and_arc_to_one_side', () => {
    const factors = offsetSideFactors(sourcesOf(LEFT_TURN))
    // +1 is the left of the walk, the inside of this left turn: both lines move
    // inward and the CCW arc shrinks (factor -1), the same side for all three.
    expect(factors.get('l1')).toBe(1)
    expect(factors.get('a1')).toBe(-1)
    expect(factors.get('l2')).toBe(1)

    const clones = clonesOf(LEFT_TURN, 1)
    expect(clones.l1).toEqual([0, -1, -7, -1])
    expect(clones.a1).toEqual([-7, -3, 2, 90, 180])
    expect(clones.l2).toEqual([-9, -3, -9, -10])
  })

  it('open_chain_mirror_twins_get_mirrored_factors', () => {
    // The right-turning twin walked from the same first end turns right, so the
    // walk through its arc is clockwise and +1 grows it. Under -1 every copy
    // lands on the mirror of the left twin's +1 result, inside the turn too.
    const factors = offsetSideFactors(sourcesOf(RIGHT_TURN))
    expect(factors.get('l1')).toBe(1)
    expect(factors.get('a1')).toBe(1)
    expect(factors.get('l2')).toBe(1)

    const clones = clonesOf(RIGHT_TURN, -1)
    expect(clones.l1).toEqual([0, -1, 7, -1])
    expect(clones.a1).toEqual([7, -3, 2, 0, 90])
    expect(clones.l2).toEqual([9, -3, 9, -10])
  })

  it('reversed_line_in_chain_flips_its_factor', () => {
    // l2 drawn end to start: the joint, the walk and the offset side are
    // unchanged; only the stored direction of the copy flips.
    const reversed: Row[] = [
      ['l1', 'line', [0, 0, -7, 0]],
      ['a1', 'arc', [-7, -3, 3, 90, 180]],
      ['l2', 'line', [-10, -10, -10, -3]],
    ]
    const factors = offsetSideFactors(sourcesOf(reversed))
    expect(factors.get('l2')).toBe(-1)

    const forward = clonesOf(LEFT_TURN, 1)
    const flipped = clonesOf(reversed, 1)
    expect(flipped.l1).toEqual(forward.l1)
    expect(flipped.a1).toEqual(forward.a1)
    expect(segment(flipped.l2)).toEqual(segment(forward.l2))
  })

  it('chain_orientation_follows_first_listed_end', () => {
    const forward = offsetSideFactors(sourcesOf(LEFT_TURN))
    const backward = offsetSideFactors(sourcesOf([LEFT_TURN[2], LEFT_TURN[1], LEFT_TURN[0]]))
    // Walking from l2's free end instead walks every entity the other way.
    expect(backward.get('l1')).toBe(-forward.get('l1')!)
    expect(backward.get('a1')).toBe(-forward.get('a1')!)
    expect(backward.get('l2')).toBe(-forward.get('l2')!)
  })

  it('branching_selection_keeps_per_entity_rule', () => {
    const doc = build([
      ['a', 'line', [0, 0, 10, 0]],
      ['b', 'line', [0, 0, 0, 10]],
      ['c', 'line', [0, 0, -10, 0]],
    ])
    const f = sketchAt(doc)
    const sources = f.entities!.map((e) => ({ id: e.id, kind: e.kind, params: f.initial![e.id] }))
    expect(offsetSideFactors(sources, f.constraints).size).toBe(0)

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    applyAddOffset(doc, 'sk', ['a', 'b', 'c'], 2)
    expect(warnSpy).toHaveBeenCalledOnce()
    expect(warnSpy.mock.calls[0][0]).toContain('branches')
    expect(warnSpy.mock.calls[0][0]).toContain('per-entity')
    warnSpy.mockRestore()
  })
})
