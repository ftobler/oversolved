// @vitest-environment node
//
// The chamfer refusal message when the distance cannot fit into a wall.
//
// `BRepFilletAPI_MakeChamfer` reports only `build_failed` for a distance wider
// than the strip it has to bevel (the practice repro: 0.25 on a 0.2 shell rim).
// The leaf measures the adjacent face width across the picked edge and names it,
// so a caller can tell "too large a distance" from "bad pick".
//
// Skips when opencascade.js is absent.

import { describe, it, expect } from 'vitest'
import { loadOcc } from '../../occ/loadOcc'
import { DisposeScope } from '../../occ/disposeScope'
import { HandleTable } from '../../occ/handleTable'
import { booleanWithDiff } from '../../occ/booleans'
import { makeBoxAt, edgeToGeom } from '../../occ/primitives'
import { canonicalEdges } from '../../occ/bodyNames'
import { bodyFrame, compareEdgeSortKeys } from '../../occ/tessellation'
import { Repository } from '../../query'
import { bareBody } from '../shared/bodyResolution'
import { solveChamfer } from '../filletChamfer'
import type { Body } from '../../types3d'
import type { OccModule, OccShape } from '../../occ/occTypes'
import type { EdgeData } from '@/types/cad'

const loadedOcc = await loadOcc()
const hasOcc = loadedOcc !== null
const oc = loadedOcc!

/** An L bracket with a 0.2 mm wall: a base plate plus a thin upright. */
function bracket(ocm: OccModule, scope: DisposeScope): OccShape {
  const base = makeBoxAt(ocm, scope, [0, 0, 0], 10, 10, 2)
  const wall = makeBoxAt(ocm, scope, [0, 0, 2], 10, 0.2, 10)
  return scope.track(booleanWithDiff(ocm, scope, base, wall, 'fuse').shape)
}

/**
 * The `?body:edge:N` alias index of the first edge the predicate names, in the
 * same display order `buildEdgeIndex` numbers the aliases by. The edge index
 * the viewport shows is this sort, not the canonical order.
 */
function aliasIndexOf(
  ocm: OccModule,
  scope: DisposeScope,
  shape: OccShape,
  test: (ed: EdgeData) => boolean,
): number {
  const uniq = canonicalEdges(ocm, scope, shape)
  const withGeom: { ed: EdgeData; sortKey: ReturnType<typeof edgeToGeom>['sortKey'] }[] = []
  for (const te of uniq) {
    if (ocm.BRep_Tool.Degenerated?.(te)) continue
    try {
      const g = edgeToGeom(ocm, scope, te)
      withGeom.push({ ed: g.ed, sortKey: g.sortKey })
    } catch {
      // A geometry read that fails has no display sort key, so its alias lands
      // after the sorted edges; it cannot be the target this test asks for.
    }
  }
  withGeom.sort((a, b) => compareEdgeSortKeys(a.sortKey, b.sortKey))
  return withGeom.findIndex((e) => test(e.ed))
}

/** A straight 10 mm top edge of the thin upright (z = 12). */
function isUprightTopEdge(ed: EdgeData): boolean {
  if (ed.kind !== 'line') return false
  const top = Math.abs(ed.start[2] - 12) < 1e-6 && Math.abs(ed.end[2] - 12) < 1e-6
  const length = Math.hypot(ed.end[0] - ed.start[0], ed.end[1] - ed.start[1], ed.end[2] - ed.start[2])
  return top && Math.abs(length - 10) < 1e-6
}

describe.skipIf(!hasOcc)('chamfer: a distance wider than the adjacent face names the width', () => {
  function rig(): { scope: DisposeScope; table: HandleTable; store: Record<string, Body> } {
    return { scope: new DisposeScope(), table: new HandleTable(), store: {} }
  }

  it('refuses 0.25 on a 0.2 wall and names the 0.2 width', () => {
    const r = rig()
    const body = bareBody('body_b', 'b')
    body.shape = r.table.register(bracket(oc, r.scope), body.created_by)
    r.store.body_b = body
    const shape = r.table.get<OccShape>(body.shape!)
    // `bodyFrame` is the normalisation the alias numbering uses; calling it here
    // also pins that the helper and the leaf sort the same edges.
    bodyFrame(oc, r.scope, shape)
    const idx = aliasIndexOf(oc, r.scope, shape, isUprightTopEdge)
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(() => solveChamfer(oc, r.scope, r.table, {
      id: 'ch1',
      chamfer: { edges: [`?body_b:edge:${idx}`], distance: 0.25, kind: 'distance', angle: 45 },
    }, new Repository(), r.store)).toThrow(/adjacent face width 0\.2/)
    r.scope.dispose()
  })

  it('a distance that fits still builds and is not refused', () => {
    const r = rig()
    const body = bareBody('body_b', 'b')
    body.shape = r.table.register(bracket(oc, r.scope), body.created_by)
    r.store.body_b = body
    const shape = r.table.get<OccShape>(body.shape!)
    const idx = aliasIndexOf(oc, r.scope, shape, isUprightTopEdge)
    const res = solveChamfer(oc, r.scope, r.table, {
      id: 'ch1',
      chamfer: { edges: [`?body_b:edge:${idx}`], distance: 0.1, kind: 'distance', angle: 45 },
    }, new Repository(), r.store)
    expect(res.status).toBe('ok')
    r.scope.dispose()
  })
})
