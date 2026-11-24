// @vitest-environment node
//
// A drill site whose cutter lies inside the bore an earlier site of the same
// hole already cut removes nothing. That used to be reported as a `partial`
// miss ("did not intersect body") while the overlap note said the two sites
// merge into one cut, so the author was sent to move a site that was exactly
// where the recipe wanted it. Since projection-constraint a projected origin is
// an ordinary point held by a `projection` constraint, so the projection itself
// is the drill site: a second point coincident to it is a real authoring slip,
// reported by name with the delete remedy, and a site several earlier bores
// swallow is reported the same way. The cut itself was always right, so the
// hole stays `ok` and counts only the sites that removed material.
//
// Skips when OCC.js is absent.

import { describe, it, expect } from 'vitest'
import { loadOcc } from '../../occ/loadOcc'
import { DisposeScope } from '../../occ/disposeScope'
import { HandleTable } from '../../occ/handleTable'
import { makeBox } from '../../occ/primitives'
import { volumeOf } from '../../occ/booleans'
import { Repository } from '../../query'
import { solveHole } from '../hole'
import type { PartSolid } from '../../types3d'
import type { OccModule, OccShape } from '../../occ/occTypes'
import { leakedIds } from '@/testing/warningText'

const oc = await loadOcc()

const PLATE = 60 * 80 * 10
const BORE_R = 6
const CB_R = 11
const CB_DEPTH = 7
// A through counterbore through the 10 mm plate removes pi R^2 7 for the step
// and pi r^2 3 for the rest of the bore.
const COUNTERBORED = Math.PI * CB_R * CB_R * CB_DEPTH + Math.PI * BORE_R * BORE_R * (10 - CB_DEPTH)

// The sketch plane at the plate's face z = 0, whose outward +Z normal points
// into the material (the same reading a top-face sketch has). A mouth exactly
// on the plane opens at the face. Sites sit at the plate's centre so an r11
// counterbore stays inside its edges.
const FACE_PLANE = { origin: [0, 0, 0], x_axis: [1, 0, 0], y_axis: [0, 1, 0], normal: [0, 0, 1] }
const CENTRE: [number, number] = [30, 40]

function plateTarget(occ: OccModule, scope: DisposeScope, table: HandleTable): Record<string, PartSolid> {
  const box = makeBox(occ, scope, 60, 80, 10)
  return {
    body_t: {
      id: 'body_t', created_by: 'ex_t', modified_by: [],
      shape: table.register(box, 'ex_t'),
      sketch_id: 'sk_t', brep_diff: null, profile_queries: [],
    },
  }
}

interface Site {
  eid: string
  xy: [number, number]
}

/** Solve one hole over that face sketch and report the plate that is left. */
function drill(
  hole: Record<string, unknown>,
  sites: Site[],
  constraints: Array<Record<string, unknown>> = [],
): { result: Record<string, unknown>; volume: number } {
  const scope = new DisposeScope()
  const table = new HandleTable()
  try {
    const repo = new Repository()
    repo.register('_pt_sk', FACE_PLANE)
    for (const site of sites) repo.register(`sk/${site.eid}/xy`, { external_xy: site.xy })
    const partStore = plateTarget(oc!, scope, table)
    const result = solveHole(oc!, scope, table, {
      id: 'h1',
      hole: { sketch: '@sk', target: 'body_t', ...hole },
    }, repo, partStore, {
      sk: {
        entities: sites.map((site) => ({ id: site.eid, kind: 'point' })),
        constraints,
      },
    })
    return { result, volume: volumeOf(oc!, scope, table.get<OccShape>(partStore.body_t.shape!)) }
  } finally {
    scope.dispose()
  }
}

const COUNTERBORE = {
  diameter: 2 * BORE_R, depth_mode: 'through_all', style: 'counterbore',
  cb_diameter: 2 * CB_R, cb_depth: CB_DEPTH,
}

describe.skipIf(!oc)('a hole site swallowed by an earlier site (real OCC)', () => {
  it('warns that the coincident twin drills nothing and names the projection it duplicates', () => {
    const { result, volume } = drill(COUNTERBORE, [
      { eid: 'o', xy: CENTRE },
      { eid: 'p', xy: CENTRE },
    ], [{ id: 'proj_o', kind: 'projection', target: '$o', source: '@builtin_origin' }])

    expect(result.status).toBe('ok')
    expect(result.exception).toBeUndefined()
    expect(result.hole_count).toBe(1)
    expect(volume).toBeCloseTo(PLATE - COUNTERBORED, 4)
    const warning = String(result.solver_warning)
    expect(warning).toContain("hole: point 2 sits on point 1 and drills nothing; one point per hole is enough, delete point 2")
    expect(warning).toContain('(point 1 is projected from the document origin)')
    expect(leakedIds(warning)).toEqual([])
    expect(warning).not.toContain("'p'")
    expect(warning).not.toContain("'o'")
    // One message, not two: the pair's generic merge note is replaced by the
    // swallow note, and the site is never called a miss.
    expect(warning).not.toMatch(/did not intersect/)
    expect(warning).not.toMatch(/merge into one cut/)
  })

  it('cuts the same counterbore with only the projected origin as the site', () => {
    const { result, volume } = drill(COUNTERBORE, [
      { eid: 'o', xy: CENTRE },
    ], [{ id: 'proj_o', kind: 'projection', target: '$o', source: '@builtin_origin' }])

    expect(result.status).toBe('ok')
    expect(result.exception).toBeUndefined()
    expect(result.hole_count).toBe(1)
    expect(result.solver_warning).toBeUndefined()
    expect(volume).toBeCloseTo(PLATE - COUNTERBORED, 4)
  })

  it('keeps the merge note for two close sites that both cut', () => {
    const { result } = drill({ diameter: 6, depth_mode: 'through_all' }, [
      { eid: 'p1', xy: CENTRE },
      { eid: 'p2', xy: [CENTRE[0] + 0.5, CENTRE[1]] },
    ])

    expect(result.status).toBe('ok')
    expect(result.hole_count).toBe(2)
    expect(String(result.solver_warning)).toMatch(/drill sites overlap and merge into one cut: sites point \d+, point \d+/)
    expect(String(result.solver_warning)).not.toMatch(/did not intersect/)
  })

  it('names every earlier bore that swallows an offset site', () => {
    // Six r2 sites on a circumradius-1 hexagon cover the centre r2 disc, so the
    // centre site, drilled last, removes nothing. No single earlier site could
    // contain it, which is why the warning names all six.
    const centre = { x: CENTRE[0], y: CENTRE[1] }
    const vertices: Site[] = Array.from({ length: 6 }, (_, i) => {
      const angle = (i * Math.PI) / 3
      return { eid: `p${i + 1}`, xy: [centre.x + Math.cos(angle), centre.y + Math.sin(angle)] }
    })
    const { result } = drill({ diameter: 4, depth_mode: 'through_all' }, [...vertices, { eid: 'pc', xy: CENTRE }])

    expect(result.status).toBe('ok')
    expect(result.hole_count).toBe(6)
    const warning = String(result.solver_warning)
    expect(warning).toContain(
      'hole: point 7 lies inside the bores of point 1, point 2, point 3, point 4, point 5, point 6 and drills nothing; move or delete point 7',
    )
    expect(warning).not.toMatch(/\bpc\b/)
    expect(warning).not.toMatch(/did not intersect/)
    expect(leakedIds(warning)).toEqual([])
  })

  it('names a swallowed site even when the fixture ids are long', () => {
    // Long ids so the leak tripwire can actually fire: the note and the
    // projection-source clause must name "point 1"/"point 2", never the rows.
    const origin = 'originXyZ0123456789'
    const dupe = 'duplicateXyZ0123456789'
    const { result } = drill(
      COUNTERBORE,
      [{ eid: origin, xy: CENTRE }, { eid: dupe, xy: CENTRE }],
      [{ id: 'proj_origin', kind: 'projection', target: `$${origin}`, source: '@builtin_origin' }],
    )
    expect(result.status).toBe('ok')
    const warning = String(result.solver_warning)
    expect(warning).toContain(
      'hole: point 2 sits on point 1 and drills nothing; one point per hole is enough, delete point 2',
    )
    expect(warning).toContain('(point 1 is projected from the document origin)')
    expect(leakedIds(warning)).toEqual([])
    for (const id of [origin, dupe]) expect(warning).not.toContain(id)
  })
})
