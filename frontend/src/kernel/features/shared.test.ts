// Parity gate for features/shared.ts (phase 2e pure-logic port). Replays the
// inputs recorded in the frozen featuresShared.json fixture through the TS port
// and asserts identical outputs (coords within 1e-9). The fixture is a golden
// snapshot; its generator (gen_features_shared_fixture.py) was deleted with the
// Python kernel in phase 4d.

import { describe, it, expect } from 'vitest'
import fixture from '../occ/__fixtures__/featuresShared.json'
import { Repository } from '../query'
import type { Body, BrepDiff } from '../types3d'
import {
  tessellateEdge,
  extractProfileLoops,
  registerTopFace,
  resolveDirection,
  resolveBody,
  resolveMergeTargets,
  brepDiffIsEmpty,
  resolveDirectionQuery,
  resolveAxisQuery,
  type PlaneLike,
} from './shared'

const TOL = 1e-9

/** Recursive structural compare with float tolerance on numbers. */
function expectClose(actual: unknown, expected: unknown, path = ''): void {
  if (typeof expected === 'number' && typeof actual === 'number') {
    expect(Math.abs(actual - expected), `${path}: ${actual} != ${expected}`).toBeLessThanOrEqual(TOL)
    return
  }
  if (Array.isArray(expected)) {
    expect(Array.isArray(actual), `${path}: expected array`).toBe(true)
    const a = actual as unknown[]
    expect(a.length, `${path}: length`).toBe(expected.length)
    for (let i = 0; i < expected.length; i++) expectClose(a[i], expected[i], `${path}[${i}]`)
    return
  }
  if (expected !== null && typeof expected === 'object') {
    expect(actual !== null && typeof actual === 'object', `${path}: expected object`).toBe(true)
    const eo = expected as Record<string, unknown>
    const ao = actual as Record<string, unknown>
    expect(Object.keys(ao).sort(), `${path}: keys`).toEqual(Object.keys(eo).sort())
    for (const k of Object.keys(eo)) expectClose(ao[k], eo[k], `${path}.${k}`)
    return
  }
  expect(actual, path).toEqual(expected)
}

function makeBody(id: string, createdBy: string): Body {
  return {
    id,
    created_by: createdBy,
    modified_by: [],
    shape: null,
    sketch_id: '',
    brep_diff: null,
    profile_queries: [],
    face_lineage: {},
    edge_lineage: {},
  }
}

function makeStore(spec: Record<string, string>): Record<string, Body> {
  const store: Record<string, Body> = {}
  for (const [bid, cb] of Object.entries(spec)) store[bid] = makeBody(bid, cb)
  return store
}

const f = fixture as unknown as Record<string, Array<Record<string, unknown>>>

describe('tessellateEdge parity', () => {
  for (const c of f.tessellate_edge) {
    it(c.name as string, () => {
      expectClose(tessellateEdge(c.edge as Record<string, unknown>), c.expected)
    })
  }
})

describe('extractProfileLoops parity', () => {
  for (const c of f.extract_profile_loops) {
    it(c.name as string, () => {
      expectClose(extractProfileLoops(c.surfaces as Record<string, unknown>[]), c.expected)
    })
  }

  it('a full-ellipse surface yields its single closed loop (no start/end edges)', () => {
    // A standalone full ellipse boundary is one self-closed `ellipse` edge with
    // null endpoints; it must still produce a profile loop to extrude into a part.
    const surfaces = [
      { boundary: [{ kind: 'ellipse', center: [0, 0], a: 5, b: 2.5, theta: 0, start_vertex: null, end_vertex: null, id: 'e1' }], query: '?x' },
    ]
    const loops = extractProfileLoops(surfaces as Record<string, unknown>[])
    expect(loops).toHaveLength(1)
    expect(loops[0]).toHaveLength(1)
    expect(loops[0][0].kind).toBe('ellipse')
  })

  it('a sliced ellipse surface (ellipse_arc + line) still chains into a loop', () => {
    const surfaces = [
      {
        boundary: [
          { kind: 'ellipse_arc', center: [0, 0], a: 5, b: 2.5, theta: 0, angle_start_deg: 90, angle_end_deg: 270, ccw: true, start: [0, 2.5], end: [0, -2.5] },
          { kind: 'line', start: [0, -2.5], end: [0, 2.5] },
        ],
        query: '?y',
      },
    ]
    const loops = extractProfileLoops(surfaces as Record<string, unknown>[])
    expect(loops).toHaveLength(1)
    expect(loops[0].length).toBe(2)
  })
})

describe('resolveDirection parity', () => {
  for (const c of f.resolve_direction) {
    it(c.name as string, () => {
      const [vec, dist, plane] = resolveDirection(
        c.normal as number[],
        c.plane as PlaneLike,
        c.direction as string,
        c.distance as number,
      )
      const exp = c.expected as { vec: number[]; distance: number; plane: PlaneLike }
      expectClose(vec, exp.vec, 'vec')
      expectClose(dist, exp.distance, 'distance')
      expectClose(
        {
          origin: plane.origin,
          x_axis: plane.x_axis,
          y_axis: plane.y_axis,
          normal: plane.normal,
        },
        exp.plane,
        'plane',
      )
    })
  }
})

describe('resolveBody parity', () => {
  for (const c of f.resolve_body) {
    it(c.name as string, () => {
      const store = makeStore(c.store as Record<string, string>)
      if (c.error) {
        expect(() => resolveBody(c.ref as string, store)).toThrow()
      } else {
        expect(resolveBody(c.ref as string, store).id).toBe(c.expected_id)
      }
    })
  }
})

describe('resolveMergeTargets parity', () => {
  for (const c of f.resolve_merge_targets) {
    it(c.name as string, () => {
      const store = makeStore(c.store as Record<string, string>)
      if (c.error) {
        expect(() => resolveMergeTargets(c.merge_target as string | null, store)).toThrow()
      } else {
        expect(resolveMergeTargets(c.merge_target as string | null, store)).toEqual(c.expected)
      }
    })
  }
})

describe('brepDiffIsEmpty parity', () => {
  for (const c of f.brep_diff_is_empty) {
    it(c.name as string, () => {
      const repr = c.diff as Partial<BrepDiff> | null
      const diff: BrepDiff | null =
        repr === null
          ? null
          : {
              new_faces: repr.new_faces ?? [],
              inherited_faces: repr.inherited_faces ?? [],
              new_edges: repr.new_edges ?? [],
              inherited_edges: repr.inherited_edges ?? [],
              modified_input_faces: repr.modified_input_faces ?? [],
              deleted_input_faces: repr.deleted_input_faces ?? [],
              modified_input_edges: repr.modified_input_edges ?? [],
              deleted_input_edges: repr.deleted_input_edges ?? [],
            }
      expect(brepDiffIsEmpty(diff)).toBe(c.expected)
    })
  }
})

describe('registerTopFace parity', () => {
  for (const c of f.register_top_face) {
    it(c.name as string, () => {
      const repo = new Repository()
      registerTopFace(
        repo,
        c.feature_id as string,
        c.plane as PlaneLike,
        c.surfaces as Record<string, unknown>[],
        c.distance as number,
      )
      const expected = c.expected as Record<string, unknown>
      const got: Record<string, unknown> = {}
      for (const key of Object.keys(expected)) {
        const el = repo.elements.get(key)
        if (el !== undefined) got[key] = el
      }
      expectClose(got, expected)
    })
  }
})

function repoWith(
  registered: Record<string, unknown>,
  planeElems: Record<string, unknown>,
): Repository {
  const repo = new Repository()
  for (const [eid, obj] of Object.entries(registered)) repo.register(eid, obj)
  for (const [eid, obj] of Object.entries(planeElems)) repo.register(eid, obj)
  return repo
}

describe('resolveDirectionQuery parity', () => {
  for (const c of f.resolve_direction_query) {
    it(c.name as string, () => {
      const repo = repoWith(
        c.registered as Record<string, unknown>,
        c.plane_elems as Record<string, unknown>,
      )
      const result = resolveDirectionQuery(c.query as string, repo, c.fallback as number[])
      expectClose(result, c.expected)
    })
  }
})

describe('resolveAxisQuery parity', () => {
  for (const c of f.resolve_axis_query) {
    it(c.name as string, () => {
      const repo = repoWith(
        c.registered as Record<string, unknown>,
        c.plane_elems as Record<string, unknown>,
      )
      const [origin, direction] = resolveAxisQuery(
        c.query as string,
        repo,
        c.fallback_origin as number[],
        c.fallback_direction as number[],
      )
      const exp = c.expected as { origin: number[]; direction: number[] }
      expectClose(origin, exp.origin, 'origin')
      expectClose(direction, exp.direction, 'direction')
    })
  }
})
