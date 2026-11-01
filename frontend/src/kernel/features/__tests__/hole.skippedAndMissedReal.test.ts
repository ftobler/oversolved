// @vitest-environment node
//
// A hole can skip sites for missing XY data AND have other sites miss the
// body in the same solve. The two facts are independent, so one message must
// not replace the other: the user needs both the ids that were never placed
// and the ids that removed nothing. The frozen `partial_skip` wording stays
// first so the parity snapshot still matches. Skips when OCC.js is absent.

import { describe, it, expect } from 'vitest'
import { loadOcc } from '../../occ/loadOcc'
import { DisposeScope } from '../../occ/disposeScope'
import { HandleTable } from '../../occ/handleTable'
import { Repository } from '../../query'
import { makeBox } from '../../occ/primitives'
import { solveHole } from '../hole'
import type { Body } from '../../types3d'

const oc = await loadOcc()

const PLANE = { origin: [0, 0, 0], x_axis: [1, 0, 0], y_axis: [0, 1, 0], normal: [0, 0, 1] }

describe.skipIf(!oc)('hole skipped and missed sites (real OCC)', () => {
  it('reports both the skipped and the missed sites, skip prefix first', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    const repo = new Repository()
    try {
      const shape = makeBox(oc!, scope, 20, 20, 20)
      const body: Body = {
        id: 'body_t', created_by: 'ex', modified_by: [], shape: table.register(shape, 'ex'),
        sketch_id: 'sk', brep_diff: null, profile_queries: [],
      }
      repo.register('_pt_sk', PLANE)
      // p1 and p2 sit over the box; p3 is outside it; p4 has no XY entry at all
      // (the "skipped" site the parity snapshot names).
      repo.register('sk/p1/xy', { external_xy: [5, 5] })
      repo.register('sk/p2/xy', { external_xy: [15, 15] })
      repo.register('sk/p3/xy', { external_xy: [50, 50] })

      const result = solveHole(oc!, scope, table, {
        id: 'h1', kind: 'hole',
        hole: { sketch: '@sk', target: 'body_t', diameter: 2, depth: 5 },
      }, repo, { body_t: body }, {
        sk: {
          entities: [
            { id: 'p1', kind: 'point' }, { id: 'p2', kind: 'point' },
            { id: 'p3', kind: 'point' }, { id: 'p4', kind: 'point' },
          ],
        },
      })

      expect(result.status).toBe('partial')
      expect(result.exception).toBe(
        'hole: 1/4 point(s) skipped, no XY data for: p4; ' +
        "hole: 1/3 drill site(s) did not intersect body 'body_t': p3",
      )
      expect(result.hole_count).toBe(2)
    } finally {
      table.disposeAll()
      scope.dispose()
    }
  })
})
