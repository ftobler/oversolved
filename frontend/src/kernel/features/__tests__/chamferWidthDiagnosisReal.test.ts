// @vitest-environment node
//
// The chamfer refusal message when the distance cannot fit into a wall.
//
// `BRepFilletAPI_MakeChamfer` reports only `build_failed` for a distance wider
// than the strip it has to bevel (the practice repro: 0.25 on a 0.2 shell rim).
// The leaf measures the adjacent face width across the picked edge and names it,
// so a caller can tell "too large a distance" from "bad pick".
//
// Skips when the OCC build is absent.

import { describe, it, expect } from 'vitest'
import { loadOcc } from '../../occ/loadOcc'
import { DisposeScope } from '../../occ/disposeScope'
import { HandleTable } from '../../occ/handleTable'
import { booleanWithDiff } from '../../occ/booleans'
import { makeBoxAt, edgeToGeom } from '../../occ/primitives'
import { canonicalEdges } from '../../occ/partNames'
import { partFrame, compareEdgeSortKeys } from '../../occ/tessellation'
import { Repository } from '../../query'
import { barePart } from '../shared/partResolution'
import { solveChamfer } from '../filletChamfer'
import { chamferSecondLeg, chamferWidthDiagnosis } from '../edgeFailureDiagnosis'
import type { PartSolid } from '../../types3d'
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

/** The upright's 10 mm top edge as an OCC edge (the measured-width target). */
function uprightTopEdge(ocm: OccModule, scope: DisposeScope, shape: OccShape): OccShape {
  for (const e of canonicalEdges(ocm, scope, shape)) {
    try {
      if (isUprightTopEdge(edgeToGeom(ocm, scope, e).ed)) return e
    } catch {
      // A geometry read that fails cannot be the target this test asks for.
    }
  }
  throw new Error('the bracket has no upright top edge')
}

describe.skipIf(!hasOcc)('chamfer: a distance wider than the adjacent face names the width', () => {
  function rig(): { scope: DisposeScope; table: HandleTable; store: Record<string, PartSolid> } {
    return { scope: new DisposeScope(), table: new HandleTable(), store: {} }
  }

  it('refuses 0.25 on a 0.2 wall and names the 0.2 width', () => {
    const r = rig()
    const part = barePart('body_b', 'b')
    part.shape = r.table.register(bracket(oc, r.scope), part.created_by)
    r.store.body_b = part
    const shape = r.table.get<OccShape>(part.shape!)
    // `bodyFrame` is the normalisation the alias numbering uses; calling it here
    // also pins that the helper and the leaf sort the same edges.
    partFrame(oc, r.scope, shape)
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
    const part = barePart('body_b', 'b')
    part.shape = r.table.register(bracket(oc, r.scope), part.created_by)
    r.store.body_b = part
    const shape = r.table.get<OccShape>(part.shape!)
    const idx = aliasIndexOf(oc, r.scope, shape, isUprightTopEdge)
    const res = solveChamfer(oc, r.scope, r.table, {
      id: 'ch1',
      chamfer: { edges: [`?body_b:edge:${idx}`], distance: 0.1, kind: 'distance', angle: 45 },
    }, new Repository(), r.store)
    expect(res.status).toBe('ok')
    r.scope.dispose()
  })

  it('names the wider leg of a two_distance chamfer that overruns the wall', () => {
    const r = rig()
    const part = barePart('body_b', 'b')
    part.shape = r.table.register(bracket(oc, r.scope), part.created_by)
    r.store.body_b = part
    const shape = r.table.get<OccShape>(part.shape!)
    const edge = uprightTopEdge(oc, r.scope, shape)
    const message = chamferWidthDiagnosis(oc, r.scope, shape, [edge], 0.1, 0.25)
    expect(message).toContain('distance 0.25')
    expect(message).toContain('width 0.2')
    r.scope.dispose()
  })

  it('derives an angle_distance second leg of distance * tan(angle) for the width check', () => {
    const r = rig()
    const part = barePart('body_b', 'b')
    part.shape = r.table.register(bracket(oc, r.scope), part.created_by)
    r.store.body_b = part
    const shape = r.table.get<OccShape>(part.shape!)
    const edge = uprightTopEdge(oc, r.scope, shape)
    // distance 0.1 fits the 0.2 wall; the 80 degree second leg (0.567) does not,
    // and the message names that leg rather than the authored distance.
    const message = chamferWidthDiagnosis(oc, r.scope, shape, [edge], 0.1, 0.1 * Math.tan((80 * Math.PI) / 180))
    expect(message).toContain('width 0.2')
    expect(message).not.toContain('distance 0.1 ')
    r.scope.dispose()
  })

  it('has no second leg at or past a right angle, where tan is unbounded or negative', () => {
    expect(chamferSecondLeg(1, (30 * Math.PI) / 180)).toBeCloseTo(Math.tan((30 * Math.PI) / 180), 12)
    expect(chamferSecondLeg(1, Math.PI / 2)).toBeUndefined()
    expect(chamferSecondLeg(1, (100 * Math.PI) / 180)).toBeUndefined()
    expect(chamferSecondLeg(1, Number.POSITIVE_INFINITY)).toBeUndefined()
  })

  it('ignores a non-finite second leg instead of naming a nonsense distance', () => {
    const r = rig()
    const part = barePart('body_b', 'b')
    part.shape = r.table.register(bracket(oc, r.scope), part.created_by)
    r.store.body_b = part
    const shape = r.table.get<OccShape>(part.shape!)
    const edge = uprightTopEdge(oc, r.scope, shape)
    for (const secondLeg of [Number.POSITIVE_INFINITY, Number.NaN, 0.1 * Math.tan((100 * Math.PI) / 180)]) {
      // distance 0.1 fits the 0.2 wall, so with no usable second leg there is
      // nothing to diagnose (above 90 tan is negative and cannot be one).
      expect(chamferWidthDiagnosis(oc, r.scope, shape, [edge], 0.1, secondLeg)).toBeNull()
    }
    r.scope.dispose()
  })
})
