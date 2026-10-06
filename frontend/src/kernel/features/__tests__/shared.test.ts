// Parity gate for the features/shared/ modules (phase 2e pure-logic port). Replays the
// inputs recorded in the frozen featuresShared.json fixture through the TS port
// and asserts identical outputs (coords within 1e-9). The fixture is a golden
// snapshot; its generator (gen_features_shared_fixture.py) was deleted with the
// Python kernel in phase 4d.

import { describe, it, expect } from 'vitest'
import fixture from '../../occ/__fixtures__/featuresShared.json'
import { Repository, makeAncestryQuery } from '../../query'
import type { Body, BrepDiff } from '../../types3d'
import {
  extractProfileLoops,
  registerTopFace,
  resolveDirection,
  resolveBody,
  resolveMergeTargets,
  brepDiffIsEmpty,
  resolveDirectionQuery,
  resolveAxisQuery,
  samePlane,
  surfaceEntityIds,
  unbuildableAreaReasons,
  loopDiagReasons,
  type PlaneLike,
  type ProfileLoopDiag,
} from '../shared'
import { describeProfile, validateSketchArea } from '../../profileDiagnostics'
import { TOL_LOOP_CLOSURE, TOL_TOPOLOGY_MERGE } from '../../solverConstants'

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
  }
}

function makeStore(spec: Record<string, string>): Record<string, Body> {
  const store: Record<string, Body> = {}
  for (const [bid, cb] of Object.entries(spec)) store[bid] = makeBody(bid, cb)
  return store
}

const f = fixture as unknown as Record<string, Array<Record<string, unknown>>>

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

// The two definitions of "closed" the profile handoff straddles. The area
// builder closes a face by merged vertex id at TOL_TOPOLOGY_MERGE (1e-5);
// extractProfileLoops re-derives the same loop by chaining COORDINATES at
// TOL_LOOP_CLOSURE (1e-6). Anything in between is an area the user can see and
// pick that never becomes a profile. These pin where that boundary sits today
// and, above all, that it is now REPORTED rather than silently dropped.
describe('extractProfileLoops at the tolerance boundary', () => {
  const gappedSquare = (gap: number, sharedVertices: boolean): Record<string, unknown> => ({
    boundary: [
      { kind: 'line', start: [0, 0], end: [10, gap], ...(sharedVertices ? { start_vertex: '_v0', end_vertex: '_v1' } : {}) },
      { kind: 'line', start: [10, 0], end: [10, 10], ...(sharedVertices ? { start_vertex: '_v1', end_vertex: '_v2' } : {}) },
      { kind: 'line', start: [10, 10], end: [0, 10], ...(sharedVertices ? { start_vertex: '_v2', end_vertex: '_v3' } : {}) },
      { kind: 'line', start: [0, 10], end: [0, 0], ...(sharedVertices ? { start_vertex: '_v3', end_vertex: '_v0' } : {}) },
    ],
    query: '?x',
  })

  it('a joint between TOL_LOOP_CLOSURE and TOL_TOPOLOGY_MERGE is dropped, but no longer silently', () => {
    const gap = 5e-6
    expect(gap).toBeGreaterThan(TOL_LOOP_CLOSURE)
    expect(gap).toBeLessThan(TOL_TOPOLOGY_MERGE)
    const surface = gappedSquare(gap, true)
    // Today the coordinate chainer drops it. F2 (chain by vertex id) will make
    // this loop survive instead; when it lands, flip the first assertion and
    // keep the second, which is the part that must never regress.
    expect(extractProfileLoops([surface])).toHaveLength(0)
    const v = validateSketchArea(surface)
    expect(v.buildable).toBe(false)
    expect(v.reason).toContain('TOL_LOOP_CLOSURE')
    expect(v.reason).toContain('TOL_TOPOLOGY_MERGE')
    // The dump names the joint and confirms both sides claim one merged vertex.
    const report = describeProfile([surface.boundary as Record<string, unknown>[]])
    expect(report.loops[0].joints[0].aEndVertex).toBe('_v1')
    expect(report.loops[0].joints[0].bStartVertex).toBe('_v1')
    expect(report.worstJointGap).toBeCloseTo(gap, 12)
  })

  it('a joint beyond TOL_TOPOLOGY_MERGE is reported, never advertised as a face', () => {
    const surface = gappedSquare(1e-3, false)
    expect(extractProfileLoops([surface])).toHaveLength(0)
    const v = validateSketchArea(surface)
    expect(v.buildable).toBe(false)
    expect(v.reason).toContain('TOL_TOPOLOGY_MERGE')
  })

  it('a joint inside TOL_LOOP_CLOSURE still chains, and the area stays buildable', () => {
    const surface = gappedSquare(5e-7, true)
    expect(extractProfileLoops([surface])).toHaveLength(1)
    expect(validateSketchArea(surface)).toEqual({ buildable: true })
  })
})

describe('extractProfileLoops on a nested sketch', () => {
  const ring = (): Record<string, unknown> => ({
    boundary: [
      { kind: 'line', start: [0, 0], end: [10, 0] },
      { kind: 'line', start: [10, 0], end: [10, 10] },
      { kind: 'line', start: [10, 10], end: [0, 10] },
      { kind: 'line', start: [0, 10], end: [0, 0] },
    ],
    holes: [[
      { kind: 'line', start: [3, 3], end: [7, 3] },
      { kind: 'line', start: [7, 3], end: [7, 7] },
      { kind: 'line', start: [7, 7], end: [3, 7] },
      { kind: 'line', start: [3, 7], end: [3, 3] },
    ]],
    query: '?ring',
  })
  const disk = (): Record<string, unknown> => ({
    boundary: (ring().holes as Record<string, unknown>[][])[0].map((e) => ({ ...e })),
    query: '?disk',
  })

  // C1: nest_surfaces keeps every loop as its own surface AND copies each
  // nested loop into its container's holes, so extruding the whole sketch feeds
  // the inner loop to the face builder twice. Not fixed here (that is F1); what
  // IS in place is the dump that names it. Update this when F1 lands.
  it('emits the inner loop twice, and the dump flags the duplicate', () => {
    const loops = extractProfileLoops([ring(), disk()])
    expect(loops).toHaveLength(3)
    const report = describeProfile(loops)
    expect(report.loops[2].duplicateOf).toBe(1)
    expect(report.verdict).toBe('suspect')
    // The face builder would receive one outer with TWO coincident hole wires.
    expect(report.groups).toEqual([{ outer: 0, holes: [1, 2] }])
  })

  // A single nested surface is fine: boundary + its own holes are distinct
  // loops, so the per-area gate must not refuse a plain ring.
  it('leaves a single ring surface buildable', () => {
    expect(validateSketchArea(ring())).toEqual({ buildable: true })
  })
})

// The chainer emits nothing for a boundary that never closes, and stops at the
// first closure, discarding any leftover edges. Both were silent; the
// diagnostics out-param turns them into reportable facts alongside allLoops.
describe('extractProfileLoops diagnostics', () => {
  it('reports an unclosed boundary chain by name', () => {
    const surface = {
      boundary: [
        { kind: 'line', start: [0, 0], end: [10, 0] },
        { kind: 'line', start: [10, 0], end: [10, 10] },
        // the chain walks off instead of closing back to [0, 0]
        { kind: 'line', start: [10, 10], end: [20, 20] },
      ],
      query: '?x',
    }
    const diags: ProfileLoopDiag[] = []
    // Same build result as before the guard: no loop is emitted.
    expect(extractProfileLoops([surface], diags)).toHaveLength(0)
    expect(diags).toEqual([{ kind: 'unclosed', startedAt: [0, 0], used: 3, total: 3 }])
  })

  it('reports an unclosed chain when an edge cannot be reached at all', () => {
    const surface = {
      boundary: [
        { kind: 'line', start: [0, 0], end: [10, 0] },
        { kind: 'line', start: [10, 0], end: [10, 10] },
        // a dangling edge that touches nothing the chain reached
        { kind: 'line', start: [50, 50], end: [60, 60] },
      ],
      query: '?x',
    }
    const diags: ProfileLoopDiag[] = []
    expect(extractProfileLoops([surface], diags)).toHaveLength(0)
    expect(diags).toEqual([{ kind: 'unclosed', startedAt: [0, 0], used: 2, total: 3 }])
  })

  it('reports leftover edges after the first closure', () => {
    const surface = {
      boundary: [
        { kind: 'line', start: [0, 0], end: [10, 0] },
        { kind: 'line', start: [10, 0], end: [10, 10] },
        { kind: 'line', start: [10, 10], end: [0, 10] },
        { kind: 'line', start: [0, 10], end: [0, 0] },
        // a dangling edge the closed square never consumes
        { kind: 'line', start: [50, 50], end: [60, 60] },
      ],
      query: '?x',
    }
    const diags: ProfileLoopDiag[] = []
    // The closed square still builds; only the dangling edge is reported.
    const loops = extractProfileLoops([surface], diags)
    expect(loops).toHaveLength(1)
    expect(loops[0]).toHaveLength(4)
    expect(diags).toEqual([{ kind: 'leftover', leftover: 1, total: 5 }])
  })

  it('formats the diagnostics as reasons a "no closed profile" message can join', () => {
    expect(loopDiagReasons([
      { kind: 'unclosed', startedAt: [0, 0], used: 3, total: 4 },
      { kind: 'leftover', leftover: 2, total: 6 },
    ])).toEqual([
      'a sketch-area boundary chain is unclosed (3 of 4 edges connected before the chain ran out)',
      'a sketch-area boundary left 2 of 6 edge(s) unused after its first closed loop',
    ])
  })
})

// The gate stamps `buildable`/`reason` in the solver worker, but the moment the
// user needs the sentence is when they picked that area as a profile and the
// feature refused. This is the collector the extrude/revolve leaves fold into
// their "no closed profile found" error.
describe('unbuildableAreaReasons', () => {
  it('returns nothing when every area is buildable', () => {
    expect(unbuildableAreaReasons([
      { buildable: true, query: '?a' },
      { buildable: true, reason: 'stale', query: '?b' },
    ])).toEqual([])
  })

  it('treats an unstamped surface as buildable', () => {
    // A topology stored before the gate existed must not read as broken.
    expect(unbuildableAreaReasons([{ query: '?a' }])).toEqual([])
  })

  it('collects the reason of each unbuildable area', () => {
    expect(unbuildableAreaReasons([
      { buildable: false, reason: 'joint too wide', query: '?a' },
      { buildable: true, query: '?b' },
      { buildable: false, reason: 'degenerate edge', query: '?c' },
    ])).toEqual(['joint too wide', 'degenerate edge'])
  })

  it('deduplicates: one sentence per distinct problem, not per area', () => {
    expect(unbuildableAreaReasons([
      { buildable: false, reason: 'joint too wide', query: '?a' },
      { buildable: false, reason: 'joint too wide', query: '?b' },
    ])).toEqual(['joint too wide'])
  })

  it('still reports an area marked unbuildable with no reason recorded', () => {
    expect(unbuildableAreaReasons([{ buildable: false, query: '?a' }])).toEqual(['no reason recorded'])
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

describe('resolveBody fallback resolution paths', () => {
  it('resolves a "?"-ancestry ref via its @body_ ancestor', () => {
    const store = makeStore({ body_1: 'extrude1' })
    // A viewport ancestry query carries the body as an "@body_<id>" ancestor.
    const ref = makeAncestryQuery(['@body_1', '@extrude1'], 'face')
    expect(resolveBody(ref, store).id).toBe('body_1')
  })

  it('resolves a colon-prefixed viewport ref via the created_by feature', () => {
    const store = makeStore({ body_1: 'extrude1' })
    // "face:<feat>:<query>" -> the middle token resolves through created_by.
    expect(resolveBody('face:extrude1:whatever', store).id).toBe('body_1')
  })

  it('resolves a topo-fallback element ref to the body it sits on', () => {
    // `@<body>/face|edge|vertex/<n>` is what the render layer mints for a pick
    // the kernel gave no named query for (utils/query/selectionId.ts
    // topoFallbackQuery). As a BODY ref it means the body carrying that element.
    const store = makeStore({ body_1: 'extrude1' })
    for (const ref of ['@body_1/face/0', '@body_1/edge/12', '@body_1/vertex/3']) {
      expect(resolveBody(ref, store).id).toBe('body_1')
    }
  })

  it('reads the topo-fallback leading segment as a body before a feature', () => {
    // `body_ex1` is the first sibling's own id, so the exact-id branch has to
    // win; reading it as a feature would make the ref ambiguous instead.
    const store = makeStore({ body_ex1: 'ex1', body_ex1_1: 'ex1' })
    expect(resolveBody('@body_ex1_1/face/2', store).id).toBe('body_ex1_1')
    expect(resolveBody('@body_ex1/face/2', store).id).toBe('body_ex1')
  })

  it('leaves a slash ref that is not an element index alone', () => {
    // `@sk1/left` is a sketch entity, not a body ref -- it must not be read as
    // "the body of sk1".
    const store = makeStore({ body_1: 'extrude1' })
    expect(() => resolveBody('@extrude1/left', store)).toThrow(/body not found/)
  })

  it('throws when a malformed "?"-ancestry ref cannot be parsed', () => {
    const store = makeStore({ body_1: 'extrude1' })
    // parseAncestry throws on a bad header; the catch falls through to the error.
    expect(() => resolveBody('?3;ab', store)).toThrow(/body not found/)
  })

  it('throws when a colon-prefixed ref matches no body at all', () => {
    const store = makeStore({ body_1: 'extrude1' })
    // The middle token matches no key, prefix, or created_by -> fall through.
    expect(() => resolveBody('face:nomatch:x', store)).toThrow(/body not found/)
  })
})

// `resolveBody` answers with ONE body (a boolean target, a mirror source, a
// hole target). Once a feature owns several bodies, a ref that names the
// FEATURE has no single answer, and the old "first match wins" quietly picked
// half of a split body and reported success.
describe('resolveBody ambiguity', () => {
  const split = () => makeStore({ body_ex1: 'ex1', body_ex1_1: 'ex1', body_other: 'ex2' })

  it('throws, naming the candidates, when a feature ref covers several bodies', () => {
    for (const ref of ['ex1', '@ex1']) {
      expect(() => resolveBody(ref, split())).toThrow(/ambiguous/)
      expect(() => resolveBody(ref, split())).toThrow(/body_ex1, body_ex1_1/)
    }
  })

  it('throws for a viewport-prefixed ref that names the same feature', () => {
    expect(() => resolveBody('face:ex1:whatever', split())).toThrow(/ambiguous/)
  })

  it('resolves an exact body id to that sibling', () => {
    // `body_ex1` IS the first sibling's id, so the exact-id branch has to win
    // over the feature reading -- otherwise naming a sibling is impossible.
    expect(resolveBody('body_ex1', split()).id).toBe('body_ex1')
    expect(resolveBody('@body_ex1_1', split()).id).toBe('body_ex1_1')
    expect(resolveBody('body:body_ex1_1:0', split()).id).toBe('body_ex1_1')
  })

  it('resolves a body-exact "?" query naming a sibling', () => {
    const ref = makeAncestryQuery(['@body_ex1_1', '@ex1'], 'face')
    expect(resolveBody(ref, split()).id).toBe('body_ex1_1')
  })

  it('leaves a single-body feature ref alone', () => {
    expect(resolveBody('ex2', split()).id).toBe('body_other')
  })
})

describe('surfaceEntityIds', () => {
  it('returns [] for a surface with no ancestry query', () => {
    expect(surfaceEntityIds({ query: '@sketch1/line1' })).toEqual([])
    expect(surfaceEntityIds({})).toEqual([])
  })

  it('returns [] for a malformed "?"-query', () => {
    expect(surfaceEntityIds({ query: '?3;ab' })).toEqual([])
  })

  it('returns sorted, deduped "@feat/entity" ids and drops the rest', () => {
    // Keeps only ids that start with "@" AND contain "/"; dedups and sorts.
    const query = makeAncestryQuery(
      ['@sk1/line2', '@sk1/line1', '@sk1/line1', '@body_1', 'plain'],
      'face',
    )
    expect(surfaceEntityIds({ query })).toEqual(['@sk1/line1', '@sk1/line2'])
  })
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

  // Deliberately beyond the frozen Python cases, which only ever had one body
  // per creator: a feature routinely owns several bodies once its result splits
  // (features/bodySplit.ts), and targeting the FEATURE must reach all of them.
  it('a feature id resolves to every body that feature made, not just the first', () => {
    const store = makeStore({
      body_ex1: 'ex1',
      body_ex1_1: 'ex1',
      body_ex1_2: 'ex1',
      body_other: 'ex2',
    })
    expect(resolveMergeTargets('ex1', store)).toEqual(['body_ex1', 'body_ex1_1', 'body_ex1_2'])
    expect(resolveMergeTargets('@ex1', store)).toEqual(['body_ex1', 'body_ex1_1', 'body_ex1_2'])
    // An explicit body id still means exactly that one sibling.
    expect(resolveMergeTargets('body_ex1_1', store)).toEqual(['body_ex1_1'])
  })

  // The editors write a body pick as a `?` ancestry query (the face the user
  // clicked), and that value is PERSISTED as merge_target. It has to resolve.
  it('resolves a "?" pick to the one body that owns the picked geometry', () => {
    const store = makeStore({ body_ex1: 'ex1', body_ex1_1: 'ex1' })
    const ref = makeAncestryQuery(['@body_ex1_1', '@ex1'], 'face')
    expect(resolveMergeTargets(ref, store)).toEqual(['body_ex1_1'])
  })

  it('throws for a "?" query whose bodies are gone', () => {
    const store = makeStore({ body_ex1: 'ex1' })
    const ref = makeAncestryQuery(['@body_gone', '@ex9'], 'face')
    expect(() => resolveMergeTargets(ref, store)).toThrow(/merge target/)
  })
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

  it('returns the fallbacks when a resolved edge has a degenerate direction', () => {
    // start == end -> zero-length direction -> normalize fails -> fall back even
    // though the query itself resolved to a registered element.
    const repo = repoWith({ a1: { start: [1, 2, 3], end: [1, 2, 3] } }, {})
    const [origin, direction] = resolveAxisQuery('@a1', repo, [9, 9, 9], [0, 1, 0])
    expect(origin).toEqual([9, 9, 9])
    expect(direction).toEqual([0, 1, 0])
  })
})

// The multi-sketch profile refusal compares PLANES, not sketch ids: two sketches
// on one datum plane are legitimate (the wave-7 fence fixtures), two on
// different planes are refused. The full frame must match -- same oriented
// normal, same offset, and same in-plane rotation -- because every loop is
// lifted through the FIRST sketch's frame.
describe('samePlane', () => {
  const front = { origin: [0, 0, 0], x_axis: [1, 0, 0], y_axis: [0, 1, 0], normal: [0, 0, 1] }

  it('accepts two identical frames (one datum plane, two sketches)', () => {
    expect(samePlane(front, { ...front, x_axis: [...front.x_axis], y_axis: [...front.y_axis], normal: [...front.normal] })).toBe(true)
  })

  it('refuses a frame rotated in-plane about the normal (x_axis spun 30 deg)', () => {
    // Same origin, same normal, same plane: only the in-plane rotation differs,
    // and that alone maps a second sketch's loop coords to a different 3D locus.
    const c = Math.cos(Math.PI / 6), s = Math.sin(Math.PI / 6)
    const spun = {
      origin: [0, 0, 0],
      x_axis: [c, s, 0],
      y_axis: [-s, c, 0],
      normal: [0, 0, 1],
    }
    expect(samePlane(front, spun)).toBe(false)
  })

  it('refuses parallel planes offset along the normal', () => {
    expect(samePlane(front, { ...front, origin: [0, 0, 1e-3] })).toBe(false)
  })

  it('refuses perpendicular normals', () => {
    const right = { origin: [0, 0, 0], x_axis: [0, 0, -1], y_axis: [0, 1, 0], normal: [1, 0, 0] }
    expect(samePlane(front, right)).toBe(false)
  })

  it('refuses an anti-parallel (mirrored) frame', () => {
    // A flipped normal is not the same oriented plane: its loop coords map to a
    // different 3D locus even though the un-oriented plane is identical.
    const mirrored = { origin: [0, 0, 0], x_axis: [-1, 0, 0], y_axis: [0, 1, 0], normal: [0, 0, -1] }
    expect(samePlane(front, mirrored)).toBe(false)
  })
})
