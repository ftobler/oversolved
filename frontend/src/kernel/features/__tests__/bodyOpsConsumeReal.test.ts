// @vitest-environment node
//
// A cut that consumes a whole target body deletes it from the store. The
// result must say so the same way hole and array do when the deletion is a
// surprise: `body_ids` names only survivors (empty here), `body_id` keeps the
// id the feature would have minted, and a deletion warning is present.
// Reporting `ok` with `body_id: null` and a dead id in `body_ids` made a
// feature row point at a body nobody could find.
//
// The warning is conditional since the example008 practice run: an automatic
// cut reaches every body, so eating a split lump is the asked-for result and
// went silent. It stays for the two cases where it is not (the cut's explicit
// merge target vanished, or the part is now empty). Skips when
// opencascade.js is absent.

import { describe, it, expect } from 'vitest'
import { loadOcc } from '../../occ/loadOcc'
import { DisposeScope } from '../../occ/disposeScope'
import { HandleTable } from '../../occ/handleTable'
import { makeBoxAt } from '../../occ/primitives'
import { applyBodyOperation } from '../bodyOps'
import type { Body } from '../../types3d'
import type { OccShape } from '../../occ/occTypes'

const oc = await loadOcc()

// Every box in this file is a 2 mm cube at its corner; the tool cube is big
// enough to swallow one whole when it is centred on it.
const CUBE = 2
const ENCLOSING = 5
const CENTRE_OFFSET = -1.5

interface BodySpec {
  id: string
  at: [number, number, number]
}

describe.skipIf(!oc)('applyBodyOperation cut consumes a body (real OCC)', () => {
  function runCut(
    bodies: BodySpec[],
    toolAt: [number, number, number],
    mergeTarget: string | null,
  ): { result: ReturnType<typeof applyBodyOperation>; store: Record<string, Body> } {
    const scope = new DisposeScope()
    const table = new HandleTable()
    const bodyStore: Record<string, Body> = {}
    try {
      for (const spec of bodies) {
        const box = makeBoxAt(oc!, scope, spec.at, CUBE, CUBE, CUBE)
        bodyStore[spec.id] = {
          id: spec.id, created_by: `feat_${spec.id}`, modified_by: [],
          shape: table.register(box, `feat_${spec.id}`), sketch_id: 'sk', brep_diff: null, profile_queries: [],
        }
      }
      const tool = scope.track(makeBoxAt(oc!, scope, toolAt, ENCLOSING, ENCLOSING, ENCLOSING))
      const result = applyBodyOperation(oc!, scope, table, {
        toolShape: tool as OccShape,
        bodyStore,
        operation: 'cut',
        mergeTarget,
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

  it('warns when the merge target is the consumed body, keeping the would-be body_id', () => {
    const { result, store } = runCut([{ id: 'body_t', at: [0, 0, 0] }], [CENTRE_OFFSET, CENTRE_OFFSET, CENTRE_OFFSET], 'body_t')
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

  it('warns when the automatic cut empties the part, since nothing is left to build on', () => {
    const { result, store } = runCut([{ id: 'body_a', at: [0, 0, 0] }], [CENTRE_OFFSET, CENTRE_OFFSET, CENTRE_OFFSET], null)
    expect(result.status).toBe('ok')
    expect(result.body_ids).toEqual([])
    expect(store).toEqual({})
    expect(result.solver_warning).toBe(
      "extrude: the cut removed all of body 'body_a'; the body was deleted",
    )
  })

  it('warns when the named merge target vanishes even though another body survives', () => {
    const { result, store } = runCut(
      [{ id: 'body_a', at: [0, 0, 0] }, { id: 'body_b', at: [10, 0, 0] }],
      [CENTRE_OFFSET, CENTRE_OFFSET, CENTRE_OFFSET],
      'body_a',
    )
    expect(result.status).toBe('ok')
    expect(store.body_a).toBeUndefined()
    expect(store.body_b).toBeDefined()
    // The user aimed at body_a and it is gone: that is the surprise the
    // warning exists for, whatever else the cut did.
    expect(result.solver_warning).toBe(
      "extrude: the cut removed all of body 'body_a'; the body was deleted",
    )
  })

  it('stays quiet when an automatic cut eats one body and another survives', () => {
    const { result, store } = runCut(
      [{ id: 'body_a', at: [0, 0, 0] }, { id: 'body_b', at: [10, 0, 0] }],
      [CENTRE_OFFSET, CENTRE_OFFSET, CENTRE_OFFSET],
      null,
    )
    expect(result.status).toBe('ok')
    // body_ids still never names the consumed body; only the warning is gone.
    expect(result.body_ids).toEqual([])
    expect(store.body_a).toBeUndefined()
    expect(store.body_b).toBeDefined()
    expect(store.body_b.shape).not.toBeNull()
    // No deletion text, and no "operation produced no geometry change" either:
    // the only thing this cut did was consume, which is not a no-op.
    expect(result.solver_warning).toBeUndefined()
  })

  it('stays quiet when an automatic cut eats one body and only trims the other', () => {
    // The second body spans x 3..5 and the tool reaches x 3.5, so it survives
    // with a real cut. `cutBodyId` then names a live body, and the deleted one
    // must not drag the no-change warning along with it.
    const { result, store } = runCut(
      [{ id: 'body_a', at: [0, 0, 0] }, { id: 'body_b', at: [3, 0, 0] }],
      [CENTRE_OFFSET, CENTRE_OFFSET, CENTRE_OFFSET],
      null,
    )
    expect(result.status).toBe('ok')
    expect(store.body_a).toBeUndefined()
    expect(store.body_b).toBeDefined()
    expect(store.body_b.brep_diff).not.toBeNull()
    expect(result.solver_warning).toBeUndefined()
  })
})
