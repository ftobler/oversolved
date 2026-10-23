// @vitest-environment node
//
// Self-resolution invariant: every face, edge and vertex query a build emits
// resolves to the very element the builder registered for that primitive.
//
// The query string (minted at tessellation) and the repository key (written at
// registration) are produced by two different code paths. Nothing else checks
// that they agree, and when they drifted (a fillet face registered under the
// modifying feature while its query named the body's creator) the ancestral
// tier silently stopped matching: the UUID tier hid it until the UUID died.
//
// Two passes per primitive:
//   1. the query as emitted resolves to its element (UUID tier when it has one);
//   2. the same query with its `@u|` token removed still reaches the element
//      through the ancestral net: it resolves to it, or is ambiguous among
//      siblings that include it. A miss, or a different element, fails.
//
// Skips when opencascade.js or the Rust solver is absent.
import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from '../loadOcc'
import { SharedHarness } from '../sharedHarness'
import { setSketchSolver, resetSketchSolver } from '../../features/sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { repoFromSnapshot, type BuildResponse } from '../../builder'
import {
  AmbiguousQueryError,
  isConstructionUuidId,
  makeAncestryQuery,
  parseAncestry,
  type Repository,
} from '../../query'

const oc = await loadOcc()
const solveBytes = loadSolver()

type Spec = { features: Array<Record<string, unknown>> }
type Kind = 'face' | 'edge' | 'vertex'

function rectSketch(sketchId: string, w: number, h: number, opts?: { offsetX?: number; offsetY?: number }) {
  const ox = opts?.offsetX ?? 0
  const oy = opts?.offsetY ?? 0
  return {
    id: sketchId, kind: 'sketch' as const, label: 'Rectangle', plane: '@builtin_plane_front',
    entities: [
      { id: 'bottom', kind: 'line' as const }, { id: 'right', kind: 'line' as const },
      { id: 'top', kind: 'line' as const }, { id: 'left', kind: 'line' as const },
    ],
    initial: {
      bottom: [ox, oy, ox + w, oy], right: [ox + w, oy, ox + w, oy + h],
      top: [ox + w, oy + h, ox, oy + h], left: [ox, oy + h, ox, oy],
    },
    constraints: [
      { id: 'c1', kind: 'coincident' as const, a: { entity: 'bottom', point: 'end' as const }, b: { entity: 'right', point: 'start' as const } },
      { id: 'c2', kind: 'coincident' as const, a: { entity: 'right', point: 'end' as const }, b: { entity: 'top', point: 'start' as const } },
      { id: 'c3', kind: 'coincident' as const, a: { entity: 'top', point: 'end' as const }, b: { entity: 'left', point: 'start' as const } },
      { id: 'c4', kind: 'coincident' as const, a: { entity: 'left', point: 'end' as const }, b: { entity: 'bottom', point: 'start' as const } },
      { id: 'c5', kind: 'horizontal' as const, target: { entity: 'bottom' } },
      { id: 'c6', kind: 'horizontal' as const, target: { entity: 'top' } },
      { id: 'c7', kind: 'vertical' as const, target: { entity: 'right' } },
      { id: 'c8', kind: 'vertical' as const, target: { entity: 'left' } },
      { id: 'c9', kind: 'length' as const, target: { entity: 'bottom' }, value: w },
      { id: 'c10', kind: 'length' as const, target: { entity: 'left' }, value: h },
    ],
  }
}

function circleSketch(sketchId: string, diameter: number) {
  return {
    id: sketchId, kind: 'sketch' as const, label: 'Circle', plane: '@builtin_plane_front',
    entities: [{ id: 'c1', kind: 'circle' as const }],
    initial: { c1: [0, 0, diameter / 2] },
    constraints: [
      { id: 'co1', kind: 'coincident' as const, a: `$${sketchId}c1center`, b: '@builtin_origin' },
      { id: 'd1', kind: 'diameter' as const, target: `$${sketchId}c1`, value: diameter },
    ],
  }
}

const box = (): Spec => ({ features: [
  rectSketch('sk1', 10, 10),
  { id: 'ex1', kind: 'extrude', sketch: '$sk1', distance: 5, direction: 'normal', operation: 'new' },
] })

/** The emitted queries of one kind for a body, index-aligned with its primitives. */
function queriesOf(h: SharedHarness, r: BuildResponse, bodyId: string, kind: Kind): string[] {
  const b = h.body(r, bodyId)
  if (kind === 'face') return ((b.mesh as { face_queries?: string[] } | undefined)?.face_queries) ?? []
  return (b[`${kind}_queries`] as string[] | undefined) ?? []
}

/** The registered element for primitive `idx` of `kind` on `bodyId`. */
function registeredElement(repo: Repository, bodyId: string, kind: Kind, idx: number): unknown {
  const hits = [...repo.elements.values()].filter((el) => {
    const e = el as Record<string, unknown>
    return e?.body_id === bodyId && e[`${kind}_index`] === idx
  })
  expect(hits, `${kind} ${idx} of ${bodyId} is registered exactly once`).toHaveLength(1)
  return hits[0]
}

/** The query with its construction UUID token removed (the ancestral net alone). */
function withoutUuid(query: string): string {
  const [ids, typeRestriction] = parseAncestry(query)
  return makeAncestryQuery(ids.filter((i) => !isConstructionUuidId(i)), typeRestriction)
}

describe.skipIf(!oc || !solveBytes)('query self-resolution (real OCC + Rust solver)', () => {
  const h = new SharedHarness(oc!)

  beforeAll(() => {
    if (!oc || !solveBytes) throw new Error('unreachable: skipIf guards this')
    resetSketchSolver()
    setSketchSolver(solveBytes)
  })

  /** The last run solved only the features `spec` adds to `prefix`: the prefix came
   *  back from its checkpoint. A silent fall back to a full build would make every
   *  restored-vs-full comparison pass for nothing. */
  function expectRestored(prefix: Spec, spec: Spec): void {
    const clean = new Set(prefix.features.map((f) => f.id))
    expect(h.lastSolved, 'the incremental build solved only the tail')
      .toEqual(spec.features.map((f) => String(f.id)).filter((fid) => !clean.has(fid)))
  }

  /** Builds `tail` in full and on top of `prefix`'s checkpoints, and expects both to
   *  emit the same face, edge and vertex queries for `bodyId`. */
  function expectRestoredMatchesFull(prefix: Spec, tail: Spec, bodyId: string): void {
    const full = h.run(tail)
    const restored = h.run(tail, { prevState: h.run(prefix)._build_state })
    expectRestored(prefix, tail)
    for (const kind of ['face', 'edge', 'vertex'] as const) {
      expect(queriesOf(h, restored, bodyId, kind), `${kind} queries, restored vs full`)
        .toEqual(queriesOf(h, full, bodyId, kind))
    }
  }

  /** Returns how many checked primitives are owned by a feature other than the
   *  first extrude, so the modifier cases can prove they exercised one. With
   *  `restoreFrom`, that spec is built first and `spec` incrementally on top, so
   *  its clean prefix comes back from the checkpoint copy (no `brep_diff`). */
  function expectSelfResolution(spec: Spec, bodyId: string, opts?: { restoreFrom?: Spec }): number {
    const prevState = opts?.restoreFrom ? h.run(opts.restoreFrom)._build_state : null
    const r = h.run(spec, { prevState })
    if (opts?.restoreFrom) expectRestored(opts.restoreFrom, spec)
    const state = r._build_state!
    const lastFid = state.feature_order[state.feature_order.length - 1]
    // Sketches report their constraint state (often 'underconstrained'); only
    // the solid-producing features have to have succeeded.
    for (const fid of state.feature_order) {
      if (fid.startsWith('sk')) continue
      expect((h.res(r, fid) as { status?: string }).status, `feature ${fid}`).toBe('ok')
    }
    const checkpoint = state.checkpoints[lastFid]
    const repo = repoFromSnapshot(checkpoint.repo_snapshot as Record<string, unknown>)
    const bodyStore = checkpoint.body_store_snapshot as Record<string, unknown>

    let checked = 0
    let modifierOwned = 0
    for (const kind of ['face', 'edge', 'vertex'] as const) {
      const queries = queriesOf(h, r, bodyId, kind)
      expect(queries.length, `${bodyId} emits ${kind} queries`).toBeGreaterThan(0)
      queries.forEach((query, idx) => {
        const element = registeredElement(repo, bodyId, kind, idx)
        const label = `${kind} ${idx}: ${query}`

        expect(repo.query(query, null, bodyStore), label).toBe(element)
        if (query.includes('@u|')) expect(repo._lastTier, label).toBe('uuid')

        // The ancestral net alone: the element or an ambiguity that includes it.
        const stripped = withoutUuid(query)
        try {
          expect(repo.query(stripped, null, bodyStore), `ancestral net of ${label}`).toBe(element)
        } catch (e) {
          if (!(e instanceof AmbiguousQueryError)) throw e
          // Ambiguous among siblings is fine only when the element is one of them.
          expect(repo.queryAll(stripped, null, bodyStore), `ancestral candidates of ${label}`).toContain(element)
        }
        if ((element as { created_by?: string }).created_by !== spec.features.find((f) => f.kind === 'extrude')?.id) {
          modifierOwned++
        }
        checked++
      })
    }
    expect(checked).toBeGreaterThan(0)
    return modifierOwned
  }

  it('box', () => {
    expectSelfResolution(box(), 'body_ex1')
  })

  it('cylinder', () => {
    expectSelfResolution({ features: [
      circleSketch('sk1', 10),
      { id: 'ex1', kind: 'extrude', sketch: '$sk1', distance: 8, direction: 'normal', operation: 'new' },
    ] }, 'body_ex1')
  })

  // The modifier case: the fillet's own faces, edges and vertices are
  // registered under the fillet while the body is still the extrude's.
  it('filleted box', () => {
    const base = box()
    const edges = queriesOf(h, h.run(base), 'body_ex1', 'edge')
    const modifierOwned = expectSelfResolution({ features: [
      ...base.features,
      { id: 'fillet1', kind: 'fillet', edges: [edges[0]], radius: 1 },
    ] }, 'body_ex1')
    expect(modifierOwned).toBeGreaterThan(0)
  })

  // The fillet restored from its checkpoint copy: the live `brep_diff` is gone,
  // so the fillet's elements must stay attributed to it through the canonical
  // indices the body carries (`Body.brep_new`), or the incremental build mints
  // other queries than the full one.
  it('filleted box restored from its checkpoint', () => {
    const base = box()
    const edges = queriesOf(h, h.run(base), 'body_ex1', 'edge')
    const filleted: Spec = { features: [
      ...base.features,
      { id: 'fillet1', kind: 'fillet', edges: [edges[0]], radius: 1 },
    ] }
    const withTail: Spec = { features: [...filleted.features, rectSketch('sk9', 2, 2)] }
    const modifierOwned = expectSelfResolution(withTail, 'body_ex1', { restoreFrom: filleted })
    expect(modifierOwned).toBeGreaterThan(0)
    expectRestoredMatchesFull(filleted, withTail, 'body_ex1')
  })

  // A hole drilled after a fillet, rebuilt with only the hole dirty. The restored
  // body has no `brep_diff`, so a hole that seeded its own diff with the body's
  // previous one credited the surviving fillet elements to itself in a full build
  // and not in the incremental one.
  it('hole after a fillet, restored from the fillet checkpoint', () => {
    const base = box()
    const edges = queriesOf(h, h.run(base), 'body_ex1', 'edge')
    const filleted: Spec = { features: [
      ...base.features,
      { id: 'fillet1', kind: 'fillet', edges: [edges[0]], radius: 1 },
    ] }
    const drilled: Spec = { features: [
      ...filleted.features,
      {
        id: 'skh', kind: 'sketch', label: 'Drill site', plane: '@builtin_plane_front',
        entities: [{ id: 'p1', kind: 'point' }], initial: { p1: [5, 5] }, constraints: [],
      },
      { id: 'hole1', kind: 'hole', hole: { sketch: '@skh', diameter: 2, depth: 3, target: 'body_ex1' } },
    ] }
    expectSelfResolution(drilled, 'body_ex1', { restoreFrom: filleted })
    expectRestoredMatchesFull(filleted, drilled, 'body_ex1')
  })

  // A blind hole's floor touches only the new bore, itself a new face: a neighbour
  // pass that reads only the producer's names reaches the bore and never the floor,
  // which then emitted an empty query.
  const blindHole = (): Spec => ({ features: [
    ...box().features,
    {
      id: 'skh', kind: 'sketch', label: 'Drill site', plane: '@builtin_plane_front',
      entities: [{ id: 'p1', kind: 'point' }], initial: { p1: [5, 5] }, constraints: [],
    },
    { id: 'hole1', kind: 'hole', hole: { sketch: '@skh', diameter: 2, depth: 3, target: 'body_ex1' } },
  ] })

  // The face queries of body_ex1 that name `holeId` as their creator, by surface type.
  function holeFaceQueries(spec: Spec, holeId: string): Record<string, string[]> {
    const out: Record<string, string[]> = {}
    for (const q of queriesOf(h, h.run(spec), 'body_ex1', 'face')) {
      const [ids, type] = parseAncestry(q)
      if (ids.includes(`@${holeId}`)) (out[type ?? ''] ??= []).push(q)
    }
    return out
  }

  // The hole names its own faces from the drill site, the way an extrude names a
  // side face from its sketch entity: the bore and the floor carry a construction
  // uuid and the site's entity as ancestry, not whatever their neighbours were.
  it('blind hole', () => {
    const modifierOwned = expectSelfResolution(blindHole(), 'body_ex1')
    expect(modifierOwned).toBeGreaterThan(0)
    const faces = holeFaceQueries(blindHole(), 'hole1')
    expect(faces.cylinderface, 'one bore').toHaveLength(1)
    expect(faces.flatface, 'one floor').toHaveLength(1)
    for (const q of [...faces.cylinderface, ...faces.flatface]) {
      expect(q).toContain('@u|')
      expect(parseAncestry(q)[0], q).toContain('@skh/p1')
    }
  })

  // A circle names its own drill site and diameter; its bore is named from it.
  it('blind hole drilled at a picked circle', () => {
    const spec: Spec = { features: [
      ...box().features,
      {
        id: 'skh', kind: 'sketch', label: 'Drill circle', plane: '@builtin_plane_front',
        entities: [{ id: 'c1', kind: 'circle' }], initial: { c1: [5, 5, 1.5] }, constraints: [],
      },
      { id: 'hole1', kind: 'hole', hole: { sketch: 'entity:skh:c1', diameter: 2, depth: 3, target: 'body_ex1' } },
    ] }
    expectSelfResolution(spec, 'body_ex1')
    const faces = holeFaceQueries(spec, 'hole1')
    expect(faces.cylinderface).toHaveLength(1)
    expect(faces.flatface).toHaveLength(1)
    for (const q of [...faces.cylinderface, ...faces.flatface]) {
      expect(q).toContain('@u|')
      expect(parseAncestry(q)[0], q).toContain('@skh/c1')
    }
  })

  const drillSites = (points: Array<[string, [number, number]]>, hole: Record<string, unknown>): Spec => ({ features: [
    ...box().features,
    {
      id: 'skh', kind: 'sketch', label: 'Drill sites', plane: '@builtin_plane_front',
      entities: points.map(([id]) => ({ id, kind: 'point' })),
      initial: Object.fromEntries(points), constraints: [],
    },
    { id: 'hole1', kind: 'hole', hole: { sketch: '@skh', diameter: 2, target: 'body_ex1', ...hole } },
  ] })

  // The hole cuts its sites one at a time, and both bores run between the same
  // two caps. Named off that neighbour set, the second bore was handed the uuid
  // the first already held, and both picks failed as a collision by construction.
  it('two through holes between the same two faces', () => {
    expectSelfResolution(drillSites([['p1', [3, 3]], ['p2', [7, 6]]], { depth_mode: 'through_all' }), 'body_ex1')
  })

  it('two through holes restored from the box checkpoint', () => {
    const spec = drillSites([['p1', [3, 3]], ['p2', [7, 6]]], { depth_mode: 'through_all' })
    const base: Spec = { features: spec.features.filter((f) => f.id !== 'hole1') }
    expectSelfResolution(spec, 'body_ex1', { restoreFrom: base })
    expectRestoredMatchesFull(base, spec, 'body_ex1')
  })

  /** Each hole face's uuid, keyed by where the face is (test-side only: it pairs
   *  the same face across two documents, it identifies nothing in the kernel). */
  function holeFaceUuidsByPlace(spec: Spec): Map<string, string> {
    const mesh = h.body(h.run(spec), 'body_ex1').mesh as {
      face_data: Array<{ centroid: number[]; normal: number[] }>
      face_uuids: (string | null)[]
      face_queries: string[]
    }
    const out = new Map<string, string>()
    mesh.face_queries.forEach((q, i) => {
      if (!parseAncestry(q)[0].includes('@hole1')) return
      const fd = mesh.face_data[i]
      const place = [...fd.centroid, ...fd.normal].map((v) => v.toFixed(3).replace('-0.000', '0.000')).join(',')
      out.set(place, mesh.face_uuids[i] ?? '')
    })
    return out
  }

  // A bore's identity is its own drill site, not its rank among the hole's cuts.
  // Named off its neighbours, the second bore took the first one's uuid as soon as
  // the first site was deleted or the points were reordered, and a stored pick on
  // it silently moved to another bore.
  for (const hole of [{ depth: 3 }, { depth_mode: 'through_all' }]) {
    const mode = 'depth_mode' in hole ? 'through' : 'blind'
    it(`${mode} hole: a bore keeps its uuid when another site is deleted or reordered`, () => {
      const both = holeFaceUuidsByPlace(drillSites([['p1', [3, 3]], ['p2', [7, 6]]], hole))
      const swapped = holeFaceUuidsByPlace(drillSites([['p2', [7, 6]], ['p1', [3, 3]]], hole))
      const onlySecond = holeFaceUuidsByPlace(drillSites([['p2', [7, 6]]], hole))
      expect(both.size, 'faces of both bores').toBeGreaterThanOrEqual(2)
      expect(swapped).toEqual(both)
      expect(onlySecond.size).toBeGreaterThan(0)
      for (const [place, uuid] of onlySecond) expect(both.get(place), place).toBe(uuid)
    })
  }

  it('blind hole restored from the box checkpoint', () => {
    const base: Spec = { features: blindHole().features.filter((f) => f.id !== 'hole1') }
    expectSelfResolution(blindHole(), 'body_ex1', { restoreFrom: base })
    expectRestoredMatchesFull(base, blindHole(), 'body_ex1')
  })

  // A joined extrude's cap: the tool's cap face is attributed to the extrude
  // that produced it, and its ancestry names that feature's own sketch. Both
  // sides of the hand-off have to agree for the cap to resolve through the
  // ancestral tier (join-cap-lineage).
  it('joined boss cap', () => {
    const modifierOwned = expectSelfResolution({ features: [
      rectSketch('sk1', 10, 10),
      { id: 'ex1', kind: 'extrude', sketch: '$sk1', distance: 10, direction: 'normal', operation: 'new' },
      circleSketch('sk2', 6),
      { id: 'ex2', kind: 'extrude', sketch: '$sk2', distance: 15, direction: 'normal', operation: 'add' },
    ] }, 'body_ex1')
    expect(modifierOwned).toBeGreaterThan(0)
  })

  // The cut's walls, rim edges and corners belong to the cut. The old
  // geometry-hash attribution never matched a boolean's edges (it threw on the
  // uncast sub-shapes and swallowed it), so this also guards that regression.
  it('boolean cut', () => {
    const modifierOwned = expectSelfResolution({ features: [
      rectSketch('sk1', 10, 10),
      { id: 'ex1', kind: 'extrude', sketch: '$sk1', distance: 10, direction: 'normal', operation: 'add' },
      rectSketch('sk2', 4, 4, { offsetX: 3, offsetY: 3 }),
      { id: 'ex2', kind: 'extrude', sketch: '$sk2', distance: 12, direction: 'normal', operation: 'cut' },
    ] }, 'body_ex1')
    expect(modifierOwned).toBeGreaterThan(0)
  })

  // A ring groove cut into the bottom face leaves the outer floor and the
  // island disc coplanar with one centroid and one normal. Identity that keyed
  // on geometry collapsed such a pair onto one name; both must keep their own
  // uuid and resolve to themselves.
  it('two faces with one centroid and normal', () => {
    const ring = {
      id: 'sk2', kind: 'sketch' as const, label: 'Ring', plane: '@builtin_plane_front',
      entities: [{ id: 'a', kind: 'circle' as const }, { id: 'b', kind: 'circle' as const }],
      initial: { a: [0, 0, 3], b: [0, 0, 6] },
      constraints: [
        { id: 'k1', kind: 'coincident' as const, a: '$sk2acenter', b: '@builtin_origin' },
        { id: 'k2', kind: 'coincident' as const, a: '$sk2bcenter', b: '@builtin_origin' },
        { id: 'k3', kind: 'diameter' as const, target: '$sk2a', value: 6 },
        { id: 'k4', kind: 'diameter' as const, target: '$sk2b', value: 12 },
      ],
    }
    const base: Spec = { features: [
      rectSketch('sk1', 20, 20, { offsetX: -10, offsetY: -10 }),
      { id: 'ex1', kind: 'extrude', sketch: '$sk1', distance: 10, direction: 'normal', operation: 'new' },
      ring,
    ] }
    // The ring region is the sketch surface with a hole.
    const surfaces = (h.res(h.run(base), 'sk2').topology as { surfaces: Array<{ query: string; holes?: unknown[] }> }).surfaces
    const ringQuery = surfaces.find((s) => (s.holes ?? []).length > 0)!.query
    const spec: Spec = { features: [
      ...base.features,
      { id: 'ex2', kind: 'extrude', sketch: [ringQuery], distance: 3, direction: 'normal', operation: 'cut' },
    ] }
    expectSelfResolution(spec, 'body_ex1')

    const mesh = h.body(h.run(spec), 'body_ex1').mesh as {
      face_data: Array<{ centroid: number[]; normal: number[] }>
      face_uuids: (string | null)[]
    }
    const key = (i: number): string =>
      [...mesh.face_data[i].centroid, ...mesh.face_data[i].normal].map((v) => v.toFixed(4).replace('-0.0000', '0.0000')).join(',')
    const twins = mesh.face_data.map((_fd, i) => i).filter((i) => mesh.face_data.some((_g, j) => j !== i && key(j) === key(i)))
    expect(twins, 'faces sharing centroid and normal').toHaveLength(2)
    const uuids = twins.map((i) => mesh.face_uuids[i])
    expect(uuids.every((u) => u !== null), 'both twins are named').toBe(true)
    expect(new Set(uuids).size, 'the twins keep distinct uuids').toBe(2)
  })

  it('explicit boolean union', () => {
    expectSelfResolution({ features: [
      rectSketch('sk1', 10, 10),
      { id: 'ex1', kind: 'extrude', sketch: '$sk1', distance: 10, direction: 'normal', operation: 'new' },
      rectSketch('sk2', 4, 4, { offsetX: 8, offsetY: 3 }),
      { id: 'ex2', kind: 'extrude', sketch: '$sk2', distance: 6, direction: 'normal', operation: 'new' },
      { id: 'bool1', kind: 'boolean', boolean: { operation: 'union', target: '@body_ex1', tools: ['@body_ex2'] } },
    ] }, 'body_ex1')
  })
})
