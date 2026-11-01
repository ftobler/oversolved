// @vitest-environment node
//
// A cut that consumes a whole target body deletes it from the store. The
// result must say so the same way hole and array do: `body_ids` names only
// survivors (empty here), `body_id` keeps the id the feature would have
// minted, and a deletion warning is present. Reporting `ok` with
// `body_id: null` and a dead id in `body_ids` made a feature row point at a
// body nobody could find. Skips when opencascade.js is absent.

import { describe, it, expect } from 'vitest'
import { loadOcc } from '../../occ/loadOcc'
import { DisposeScope } from '../../occ/disposeScope'
import { HandleTable } from '../../occ/handleTable'
import { makeBox } from '../../occ/primitives'
import { applyBodyOperation } from '../bodyOps'
import type { Body } from '../../types3d'
import type { OccShape } from '../../occ/occTypes'

const oc = await loadOcc()

describe.skipIf(!oc)('applyBodyOperation cut consumes a body (real OCC)', () => {
  function run(): { result: ReturnType<typeof applyBodyOperation>; store: Record<string, Body> } {
    const scope = new DisposeScope()
    const table = new HandleTable()
    const bodyStore: Record<string, Body> = {}
    const target = makeBox(oc!, scope, 2, 2, 2)
    bodyStore.body_t = {
      id: 'body_t', created_by: 'featT', modified_by: [],
      shape: table.register(target, 'featT'), sketch_id: 'skT', brep_diff: null, profile_queries: [],
    }
    // The tool surrounds the target completely, so the cut leaves zero solids.
    const tool = scope.track(makeBox(oc!, scope, 5, 5, 5))
    try {
      const result = applyBodyOperation(oc!, scope, table, {
        toolShape: tool as OccShape,
        bodyStore,
        operation: 'cut',
        mergeTarget: 'body_t',
        bodyId: 'body_f',
        featureId: 'featF',
        sketchId: 'skF',
        opName: 'extrude',
        profileQueries: ['?p'],
      })
      return { result, store: bodyStore }
    } finally {
      // The store's handles are the table's; the live store outlives the scope
      // only for the assertions above, then the table releases the rest.
      table.disposeAll()
      scope.dispose()
    }
  }

  it('keeps the would-be body_id, excludes the consumed body and warns', () => {
    const { result, store } = run()
    expect(result.status).toBe('ok')
    expect(result.body_id).toBe('body_f')
    expect(result.body_ids).toEqual([])
    expect(store.body_t).toBeUndefined()
    // The same sentence hole and array emit for this event; only the operation
    // name differs, so a row reads identically whichever feature ate the body.
    expect(result.solver_warning).toBe(
      "extrude: the cut removed all of body 'body_t'; the body was deleted",
    )
  })
})
