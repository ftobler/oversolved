// @vitest-environment node
//
// Gated real-OCC test for the boolean leaf's clearance (features/boolean.ts):
// a subtract grows (+) or shrinks (-) every tool by a 3D offset before the cut,
// while union/intersect ignore it with a warning. Volumes are analytic.
//
// Skips when opencascade.js is absent, like the other real-OCC gates.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { loadOcc } from '../../occ/loadOcc'
import { DisposeScope } from '../../occ/disposeScope'
import { HandleTable } from '../../occ/handleTable'
import { makeBoxAt, makeCylinder } from '../../occ/primitives'
import { volumeOf } from '../../occ/booleans'
import { applyFilletWithDiff } from '../../occ/edgeModifier'
import { mintFaceUuid, toolCopyFacePath } from '../../constructionName'
import { offsetSolid } from '../../occ/offsetShape'
import { Repository } from '../../query'
import { solveBoolean } from '../boolean'
import type { Body } from '../../types3d'
import type { OccModule, OccShape } from '../../occ/occTypes'
import type { Vec3 } from '../../occ/primitives'

// Replace the offset entry with a spy that still runs the real implementation,
// so a zero/absent clearance can be shown to skip the offset entirely.
vi.mock('../../occ/offsetShape', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../occ/offsetShape')>()
  return { ...actual, offsetSolid: vi.fn(actual.offsetSolid) }
})

const oc = await loadOcc()
const offsetSpy = vi.mocked(offsetSolid)

function boxBody(
  occ: OccModule,
  scope: DisposeScope,
  table: HandleTable,
  id: string,
  corner: Vec3,
  dx: number,
  dy: number,
  dz: number,
  faceUuids?: string[],
): Body {
  const box = makeBoxAt(occ, scope, corner, dx, dy, dz)
  return {
    id, created_by: `ex_${id}`, modified_by: [],
    shape: table.register(box, `ex_${id}`), sketch_id: `sk_${id}`,
    brep_diff: null, profile_queries: [], face_uuids: faceUuids,
  }
}

function cylinderBody(
  occ: OccModule,
  scope: DisposeScope,
  table: HandleTable,
  id: string,
  center: Vec3,
  radius: number,
  height: number,
): Body {
  const cyl = makeCylinder(occ, scope, center, [0, 0, 1] as Vec3, radius, height)
  return {
    id, created_by: `ex_${id}`, modified_by: [],
    shape: table.register(cyl, `ex_${id}`), sketch_id: `sk_${id}`,
    brep_diff: null, profile_queries: [],
  }
}

function filletedBody(
  occ: OccModule,
  scope: DisposeScope,
  table: HandleTable,
  id: string,
  corner: Vec3,
  dx: number,
  dy: number,
  dz: number,
  radius: number,
): Body {
  const box = makeBoxAt(occ, scope, corner, dx, dy, dz)
  const exp = scope.track(new occ.TopExp_Explorer_2(box, occ.TopAbs_ShapeEnum.TopAbs_EDGE, occ.TopAbs_ShapeEnum.TopAbs_SHAPE))
  const edges: OccShape[] = []
  for (; exp.More(); exp.Next()) edges.push(scope.track(occ.TopoDS.Edge_1(exp.Current())))
  const res = applyFilletWithDiff(occ, scope, box, radius, edges)
  if (!res.success) throw new Error(`test setup: fillet failed: ${res.reason}`)
  return {
    id, created_by: `ex_${id}`, modified_by: [],
    shape: table.register(scope.track(res.shape), `ex_${id}`), sketch_id: `sk_${id}`,
    brep_diff: null, profile_queries: [],
  }
}

function targetBody(occ: OccModule, scope: DisposeScope, table: HandleTable, faceUuids?: string[]): Body {
  return boxBody(occ, scope, table, 'body_t', [0, 0, 0] as Vec3, 10, 10, 8, faceUuids)
}

function solve(
  occ: OccModule,
  scope: DisposeScope,
  table: HandleTable,
  store: Record<string, Body>,
  sub: Record<string, unknown>,
): { result: ReturnType<typeof solveBoolean>; store: Record<string, Body> } {
  const result = solveBoolean(
    occ, scope, table,
    { id: 'bool1', boolean: sub },
    new Repository(),
    store,
  )
  return { result, store }
}

function volumeOfBody(occ: OccModule, scope: DisposeScope, table: HandleTable, body: Body): number {
  return volumeOf(occ, scope, table.get<OccShape>(body.shape!))
}

const V0 = 800  // 10x10x8 target

describe.skipIf(!oc)('boolean clearance (real OCC)', () => {
  let occ: OccModule
  beforeAll(() => {
    if (!oc) throw new Error('unreachable: skipIf guards this')
    occ = oc
  })
  beforeEach(() => { offsetSpy.mockClear() })

  it('clearance absent is today\'s ungrown cut (672) and does not offset', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const store: Record<string, Body> = {
        body_t: targetBody(occ, scope, table),
        body_u: boxBody(occ, scope, table, 'body_u', [3, 3, -2] as Vec3, 4, 4, 12),
      }
      const { result, store: after } = solve(occ, scope, table, store, {
        operation: 'subtract', target: 'body_t', tools: ['body_u'],
      })
      expect(result.status).toBe('ok')
      expect(volumeOfBody(occ, scope, table, after.body_t)).toBeCloseTo(V0 - 4 * 4 * 8, 3)
      expect(offsetSpy).not.toHaveBeenCalled()
    } finally {
      scope.dispose()
    }
  })

  it('clearance 0 is identical to absent and does not offset', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const store: Record<string, Body> = {
        body_t: targetBody(occ, scope, table),
        body_u: boxBody(occ, scope, table, 'body_u', [3, 3, -2] as Vec3, 4, 4, 12),
      }
      const { result, store: after } = solve(occ, scope, table, store, {
        operation: 'subtract', target: 'body_t', tools: ['body_u'], clearance: 0,
      })
      expect(result.status).toBe('ok')
      expect(volumeOfBody(occ, scope, table, after.body_t)).toBeCloseTo(V0 - 4 * 4 * 8, 3)
      expect(offsetSpy).not.toHaveBeenCalled()
    } finally {
      scope.dispose()
    }
  })

  it('clearance +0.1 grows the through tool (658.88)', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const store: Record<string, Body> = {
        body_t: targetBody(occ, scope, table),
        body_u: boxBody(occ, scope, table, 'body_u', [3, 3, -2] as Vec3, 4, 4, 12),
      }
      const { result, store: after } = solve(occ, scope, table, store, {
        operation: 'subtract', target: 'body_t', tools: ['body_u'], clearance: 0.1,
      })
      expect(result.status).toBe('ok')
      expect(volumeOfBody(occ, scope, table, after.body_t)).toBeCloseTo(V0 - 4.2 * 4.2 * 8, 3)
      expect(offsetSpy).toHaveBeenCalledTimes(1)
    } finally {
      scope.dispose()
    }
  })

  it('clearance -0.1 shrinks the through tool (684.48)', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const store: Record<string, Body> = {
        body_t: targetBody(occ, scope, table),
        body_u: boxBody(occ, scope, table, 'body_u', [3, 3, -2] as Vec3, 4, 4, 12),
      }
      const { result, store: after } = solve(occ, scope, table, store, {
        operation: 'subtract', target: 'body_t', tools: ['body_u'], clearance: -0.1,
      })
      expect(result.status).toBe('ok')
      expect(volumeOfBody(occ, scope, table, after.body_t)).toBeCloseTo(V0 - 3.8 * 3.8 * 8, 3)
    } finally {
      scope.dispose()
    }
  })

  it('grows a cylinder tool isotropically', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const store: Record<string, Body> = {
        body_t: targetBody(occ, scope, table),
        body_u: cylinderBody(occ, scope, table, 'body_u', [5, 5, -2] as Vec3, 2, 12),
      }
      const { result, store: after } = solve(occ, scope, table, store, {
        operation: 'subtract', target: 'body_t', tools: ['body_u'], clearance: 0.1,
      })
      expect(result.status).toBe('ok')
      expect(volumeOfBody(occ, scope, table, after.body_t)).toBeCloseTo(V0 - Math.PI * 2.1 * 2.1 * 8, 3)
    } finally {
      scope.dispose()
    }
  })

  it('moves a blind pocket floor axially (isotropic clearance)', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      // Tool occupies z 4..10, poking out the top of the z 0..8 target: the
      // overlap is z 4..8 and +0.1 grows the pocket to depth 4.1 (floor moves).
      const store: Record<string, Body> = {
        body_t: targetBody(occ, scope, table),
        body_u: boxBody(occ, scope, table, 'body_u', [3, 3, 4] as Vec3, 4, 4, 6),
      }
      const { result, store: after } = solve(occ, scope, table, store, {
        operation: 'subtract', target: 'body_t', tools: ['body_u'], clearance: 0.1,
      })
      expect(result.status).toBe('ok')
      expect(volumeOfBody(occ, scope, table, after.body_t)).toBeCloseTo(V0 - 4.2 * 4.2 * 4.1, 3)
    } finally {
      scope.dispose()
    }
  })

  it('succeeds on a filleted tool (pins the shell wrap)', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const store: Record<string, Body> = {
        body_t: targetBody(occ, scope, table),
        body_u: filletedBody(occ, scope, table, 'body_u', [3, 3, -2] as Vec3, 4, 4, 12, 0.5),
      }
      const { result, store: after } = solve(occ, scope, table, store, {
        operation: 'subtract', target: 'body_t', tools: ['body_u'], clearance: 0.1,
      })
      expect(result.status).toBe('ok')
      const vol = volumeOfBody(occ, scope, table, after.body_t)
      expect(vol).toBeGreaterThan(0)
      expect(vol).toBeLessThan(V0)
    } finally {
      scope.dispose()
    }
  })

  it('names the clearance when the offset cannot be applied', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      // A 1x1x1 tool cannot shrink by 0.6 on every side (its walls would cross);
      // offsetSolid refuses, and the feature must say so rather than cut ungrown.
      const store: Record<string, Body> = {
        body_t: targetBody(occ, scope, table),
        body_u: boxBody(occ, scope, table, 'body_u', [4, 4, 3] as Vec3, 1, 1, 1),
      }
      let message = ''
      try {
        solve(occ, scope, table, store, {
          operation: 'subtract', target: 'body_t', tools: ['body_u'], clearance: -0.6,
        })
      } catch (e) {
        message = e instanceof Error ? e.message : String(e)
      }
      expect(message).toContain('clearance -0.6 could not be applied to tool')
      expect(message).not.toContain('nudge')
    } finally {
      scope.dispose()
    }
  })

  it('keep_tools leaves the authored tool and re-mints its UUIDs on the target', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const toolFaces = ['u0', 'u1', 'u2', 'u3', 'u4', 'u5']
      const store: Record<string, Body> = {
        body_t: targetBody(occ, scope, table, ['t0', 't1', 't2', 't3', 't4', 't5']),
        body_u: boxBody(occ, scope, table, 'body_u', [3, 3, -2] as Vec3, 4, 4, 12, toolFaces),
      }
      const { result, store: after } = solve(occ, scope, table, store, {
        operation: 'subtract', target: 'body_t', tools: ['body_u'], keep_tools: true, clearance: 0.1,
      })
      expect(result.status).toBe('ok')
      // The kept tool keeps its authored shape and its own UUIDs.
      expect(after.body_u).toBeDefined()
      expect(volumeOfBody(occ, scope, table, after.body_u)).toBeCloseTo(4 * 4 * 12, 3)
      expect(after.body_u.face_uuids).toEqual(toolFaces)

      // The target carries SCOPED copies, never the tool's own UUIDs.
      const targetFaces = new Set<string>()
      for (const u of after.body_t.face_uuids ?? []) if (u !== null) targetFaces.add(u)
      for (const u of toolFaces) expect(targetFaces.has(u)).toBe(false)
      const scoped = new Set(toolFaces.map((u) => mintFaceUuid(toolCopyFacePath(u, 'bool1'))))
      expect([...targetFaces].some((u) => scoped.has(u))).toBe(true)
    } finally {
      scope.dispose()
    }
  })

  it('ignores a non-zero clearance on union with a warning', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const store: Record<string, Body> = {
        body_t: targetBody(occ, scope, table),
        body_u: boxBody(occ, scope, table, 'body_u', [3, 3, -2] as Vec3, 4, 4, 12),
      }
      const { result, store: after } = solve(occ, scope, table, store, {
        operation: 'union', target: 'body_t', tools: ['body_u'], clearance: 0.1,
      })
      expect(result.status).toBe('ok')
      // union of 10x10x8 with a 4x4x12 tool overlapping in z 0..8.
      expect(volumeOfBody(occ, scope, table, after.body_t)).toBeCloseTo(V0 + 4 * 4 * 12 - 4 * 4 * 8, 3)
      expect(result.solver_warning).toContain('clearance applies to subtract only')
      expect(offsetSpy).not.toHaveBeenCalled()
    } finally {
      scope.dispose()
    }
  })

  it('grows every tool of a multi-tool subtract', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const store: Record<string, Body> = {
        body_t: targetBody(occ, scope, table),
        body_u0: boxBody(occ, scope, table, 'body_u0', [1, 1, -2] as Vec3, 4, 4, 12),
        body_u1: boxBody(occ, scope, table, 'body_u1', [5, 5, -2] as Vec3, 4, 4, 12),
      }
      const { result, store: after } = solve(occ, scope, table, store, {
        operation: 'subtract', target: 'body_t', tools: ['body_u0', 'body_u1'], clearance: 0.1,
      })
      expect(result.status).toBe('ok')
      expect(offsetSpy).toHaveBeenCalledTimes(2)
      // Two grown through tools remove well over one tool's overlap.
      expect(volumeOfBody(occ, scope, table, after.body_t)).toBeLessThan(V0 - 2 * 4 * 4 * 8)
    } finally {
      scope.dispose()
    }
  })
})
