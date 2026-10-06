// @vitest-environment node
//
// Integration for bugreports/bug-report-1788207174415 ("sketch area building"),
// driving the report's own AST through the real Rust solver + area builder.
//
// A venn of two circles, an external line tangent to both, and a vertical line
// from the small circle's centre down to the origin. Five regions: the two
// crescents, the lens halved by the vertical, and the region the tangent line
// closes against the two rims. The tangent region was missing because a
// converged tangent constraint leaves the line/circle discriminant a hair
// negative, so neither circle got split at its tangent point.
//
// Second half of the same report: turning the vertical line into construction
// geometry must read like deleting it (4 areas) while it still constrains the
// solve -- the flag never reached the area builder, which happily sliced on it.
import { describe, it, expect, beforeEach } from 'vitest'
import { solveSketch, setSketchSolver, resetSketchSolver } from '../sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import type { Repository } from '../../query'
import type { Body } from '../../types3d'

type Dict = Record<string, unknown>

const solveBytes = loadSolver()
const repo = { query: () => null, elements: new Map() } as unknown as Repository

const BIG = 'AK5gIaxjhW69tUpP'      // circle, diameter 19, centred on the origin
const SMALL = '_G3Z5xEtABUe0u6n'    // circle, diameter 8, 10 above it
const TANGENT = '-xdCgl7z56nvBUbb'  // line tangent to both circles
const VERT = 'V-Wlsm1U-eT1KpvE'     // vertical line, SMALL's centre -> origin

/** The report's sketch feature; `vertConstruction` flips the vertical line. */
function sketchFeature(opts: { withVert: boolean; vertConstruction?: boolean }): Dict {
  const entities: Dict[] = [
    { id: BIG, kind: 'circle' },
    { id: SMALL, kind: 'circle' },
    { id: TANGENT, kind: 'line' },
  ]
  const initial: Record<string, number[]> = {
    [BIG]: [-4.353447723842718e-12, -4.0431186176803635e-11, 9.5],
    [SMALL]: [1.5241397033349813e-10, 10, 4],
    [TANGENT]: [3.340658664703369, 12.199999809265137, 7.9340643882751465, 5.224999904632568],
  }
  const constraints: Dict[] = [
    { id: 'c1', kind: 'coincident', a: `$${BIG}center`, b: '@builtin_origin' },
    { id: 'c2', kind: 'coincident', a: `$${TANGENT}start`, b: `$${SMALL}` },
    { id: 'c3', kind: 'coincident', a: `$${TANGENT}end`, b: `$${BIG}` },
    { id: 'c4', kind: 'tangent', a: `$${TANGENT}`, b: `$${SMALL}` },
    { id: 'c5', kind: 'tangent', a: `$${TANGENT}`, b: `$${BIG}` },
    { id: 'c6', kind: 'diameter', target: `$${BIG}`, value: 19 },
    { id: 'c7', kind: 'diameter', target: `$${SMALL}`, value: 8 },
  ]
  if (opts.withVert) {
    entities.push({ id: VERT, kind: 'line', ...(opts.vertConstruction ? { construction: true } : {}) })
    initial[VERT] = [1.0544775469467638e-10, 10, 5.3868996069406094e-11, 1.6345385114857613e-11]
    constraints.push(
      { id: 'c8', kind: 'coincident', a: `$${VERT}start`, b: `$${SMALL}center` },
      { id: 'c9', kind: 'vertical', target: `$${VERT}` },
      { id: 'c10', kind: 'length', target: `$${VERT}`, value: 10 },
      { id: 'c11', kind: 'coincident', a: `$${VERT}end`, b: '@builtin_origin' },
    )
  }
  return { id: 'sk1', kind: 'sketch', plane: '@builtin_plane_front', entities, initial, constraints }
}

interface Solved {
  status: string
  geometry: Record<string, number[]>
  surfaces: Array<{ boundary: Array<{ id?: string }> }>
}

function solve(feature: Dict): Solved {
  const out = solveSketch(feature, repo, {} as Record<string, Body>) as Dict
  const topology = out.topology as { surfaces: Solved['surfaces'] }
  return {
    status: out.status as string,
    geometry: out.geometry as Record<string, number[]>,
    surfaces: topology.surfaces,
  }
}

/** Entity ids bounding each area, so a count can be tied to the actual regions. */
function areaOwners(s: Solved): string[][] {
  return s.surfaces.map((f) => [...new Set(f.boundary.map((e) => e.id ?? ''))].sort())
}

describe.skipIf(!solveBytes)('tangent line closes its own sketch area', () => {
  beforeEach(() => {
    resetSketchSolver()
    setSketchSolver(solveBytes)
  })

  it('two circles + a tangent line make 4 areas', () => {
    const solved = solve(sketchFeature({ withVert: false }))
    expect(solved.surfaces).toHaveLength(4)
    // The region the bug was about is the only one the tangent line bounds, and
    // it closes against both rims -- a count alone would pass on any 4-way split.
    expect(areaOwners(solved)).toContainEqual([BIG, SMALL, TANGENT].sort())
  })

  it('the vertical line splits the lens, making 5', () => {
    const solved = solve(sketchFeature({ withVert: true }))
    expect(solved.surfaces).toHaveLength(5)
    expect(areaOwners(solved)).toContainEqual([BIG, SMALL, TANGENT].sort())
    // The chord splits only the lens: exactly the two lens halves carry it. The
    // crescents it dangles into do not -- the dangling stub is a zero-width slit
    // the area builder collapses away, not part of their real boundary.
    expect(areaOwners(solved).filter((o) => o.includes(VERT))).toEqual([
      [BIG, SMALL, VERT].sort(),
      [BIG, SMALL, VERT].sort(),
    ])
  })

  it('a construction vertical line bounds nothing, back to 4', () => {
    const solved = solve(sketchFeature({ withVert: true, vertConstruction: true }))
    expect(solved.surfaces).toHaveLength(4)
    expect(areaOwners(solved).some((o) => o.includes(VERT))).toBe(false)
    // ...but it is still an entity the solver placed, not one that was dropped:
    // it holds its vertical, length-10 pose from the small circle's centre to
    // the origin. That is what separates "construction" from "deleted".
    expect(solved.status).toBe('fully_constrained')
    const [x1, y1, x2, y2] = solved.geometry[VERT]
    expect([x1, y1, x2, y2].map((v) => Math.round(v * 1e6) / 1e6)).toEqual([0, 10, 0, 0])
  })
})
