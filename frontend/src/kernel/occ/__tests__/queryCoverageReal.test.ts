// @vitest-environment node
//
// Query coverage invariant: every face, edge and vertex of every body a build
// emits carries a NON-EMPTY query, and that query resolves to the very element
// the builder registered for it.
//
// An empty query is not a pick the user can make: the render layer papers over
// it with an index-keyed `topoFallbackQuery`, which no feature can resolve
// stably. A blind hole's floor did exactly that: it touches only the new bore,
// the neighbour naming pass reached the bore and never the floor, and the floor
// left the kernel with `''`. A pretty query is not required here, a real one is.
//
// The corpus is broad on purpose: the frozen regression baseline (the real user
// documents among it included), the pick-identity and array-cut bug corpora, and
// a few shapes built to hit faces no producer names directly (blind hole floors,
// pocket floors, fillet corner patches).
//
// Skips when opencascade.js or the Rust solver is absent.
import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from '../loadOcc'
import { SharedHarness } from '../sharedHarness'
import { setSketchSolver, resetSketchSolver } from '../../features/sketch'
import { unportedKinds } from '../../solverRegistry'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { repoFromSnapshot, type BuildResponse } from '../../builder'
import baseline from '@/wasm-kernel/regression-baseline.json'
import pickIdentityCorpus from '../__fixtures__/pickIdentityCorpus.json'
import arrayCutCorpus from '../../features/__fixtures__/faceExtrudeAfterArrayCut.json'

const oc = await loadOcc()
const solveBytes = loadSolver()

type Spec = { features: Array<Record<string, unknown>> }
type Kind = 'face' | 'edge' | 'vertex'

function rectSketch(sketchId: string, w: number, h: number, ox = 0, oy = 0) {
  return {
    id: sketchId, kind: 'sketch', label: 'Rectangle', plane: '@builtin_plane_front',
    entities: [
      { id: 'bottom', kind: 'line' }, { id: 'right', kind: 'line' },
      { id: 'top', kind: 'line' }, { id: 'left', kind: 'line' },
    ],
    initial: {
      bottom: [ox, oy, ox + w, oy], right: [ox + w, oy, ox + w, oy + h],
      top: [ox + w, oy + h, ox, oy + h], left: [ox, oy + h, ox, oy],
    },
    constraints: [
      { id: 'c1', kind: 'coincident', a: { entity: 'bottom', point: 'end' }, b: { entity: 'right', point: 'start' } },
      { id: 'c2', kind: 'coincident', a: { entity: 'right', point: 'end' }, b: { entity: 'top', point: 'start' } },
      { id: 'c3', kind: 'coincident', a: { entity: 'top', point: 'end' }, b: { entity: 'left', point: 'start' } },
      { id: 'c4', kind: 'coincident', a: { entity: 'left', point: 'end' }, b: { entity: 'bottom', point: 'start' } },
    ],
  }
}

function pointSketch(sketchId: string, points: Array<[number, number]>) {
  const entities = points.map((_p, i) => ({ id: `p${i}`, kind: 'point' }))
  const initial = Object.fromEntries(points.map((p, i) => [`p${i}`, p]))
  return { id: sketchId, kind: 'sketch', label: 'Drill sites', plane: '@builtin_plane_front', entities, initial, constraints: [] }
}

const box = (): Spec['features'] => [
  rectSketch('sk1', 10, 10),
  { id: 'ex1', kind: 'extrude', sketch: '$sk1', distance: 5, direction: 'normal', operation: 'new' },
]

const blindHoles = (points: Array<[number, number]>, depth = 3): Spec['features'] => [
  pointSketch('skh', points),
  { id: 'hole1', kind: 'hole', hole: { sketch: '@skh', diameter: 2, depth, target: 'body_ex1' } },
]

/** The emitted queries of one kind for a body, index-aligned with its primitives. */
function queriesOf(body: Record<string, unknown>, kind: Kind): string[] {
  if (kind === 'face') return ((body.mesh as { face_queries?: string[] } | undefined)?.face_queries) ?? []
  return (body[`${kind}_queries`] as string[] | undefined) ?? []
}

/** How many primitives of `kind` the body has, independent of its query list. */
function primitiveCount(body: Record<string, unknown>, kind: Kind): number {
  if (kind === 'face') return ((body.mesh as { face_data?: unknown[] } | undefined)?.face_data ?? []).length
  return ((body[kind === 'edge' ? 'edges' : 'vertices'] as unknown[] | undefined) ?? []).length
}

describe.skipIf(!oc || !solveBytes)('every primitive carries a resolving query (real OCC + Rust solver)', () => {
  const h = new SharedHarness(oc!)

  beforeAll(() => {
    if (!oc || !solveBytes) throw new Error('unreachable: skipIf guards this')
    resetSketchSolver()
    setSketchSolver(solveBytes)
  })

  /** Builds `spec` and checks every query of every emitted body. Returns the number
   *  of primitives checked, so a case can prove it saw some geometry.
   *
   *  A query that fell to its last resort still resolves (it carries the
   *  registrar's `@<body>/face<N>`, `edge<N>` or `vertex<N>` index tag: the face
   *  one from buildFaceQuery, the edge and vertex ones from emitWithTiesTagged),
   *  so resolving alone would hide an element the naming passes missed. Every
   *  such element must be listed in `indexTagged` as `<bodyId>/<kind><N>`, which
   *  stays empty unless a case justifies an entry. */
  function expectFullCoverage(
    spec: Spec,
    label: string,
    opts?: { indexTagged?: readonly string[] },
  ): number {
    const r: BuildResponse = h.run(spec)
    const state = r._build_state!
    const lastFid = state.feature_order[state.feature_order.length - 1]
    const checkpoint = state.checkpoints[lastFid]
    const repo = repoFromSnapshot(checkpoint.repo_snapshot as Record<string, unknown>)
    const bodyStore = checkpoint.body_store_snapshot as Record<string, unknown>
    const elements = [...repo.elements.values()] as Array<Record<string, unknown>>

    let checked = 0
    const indexTagged: string[] = []
    for (const [bodyId, body] of Object.entries((r.bodies ?? {}) as Record<string, Record<string, unknown>>)) {
      if (!(bodyId in bodyStore)) continue  // a body the build did not keep has no registration to match
      for (const kind of ['face', 'edge', 'vertex'] as const) {
        const queries = queriesOf(body, kind)
        queries.forEach((query, idx) => {
          if (query.includes(`@${bodyId}/${kind}${idx}`)) indexTagged.push(`${bodyId}/${kind}${idx}`)
        })
        expect(queries.length, `${label}: ${bodyId} emits one ${kind} query per ${kind}`)
          .toBe(primitiveCount(body, kind))
        queries.forEach((query, idx) => {
          const where = `${label}: ${bodyId} ${kind} ${idx}`
          expect(query, `${where} has a query`).not.toBe('')
          checked++
          const hits = elements.filter((e) => e?.body_id === bodyId && e[`${kind}_index`] === idx)
          expect(hits, `${where} is registered exactly once`).toHaveLength(1)
          let resolved: unknown
          try {
            resolved = repo.query(query, null, bodyStore)
          } catch (e) {
            throw new Error(`${where}: ${query}: ${(e as Error).message}`)
          }
          expect(resolved, `${where}: ${query}`).toBe(hits[0])
        })
      }
    }
    expect(indexTagged, `${label}: elements named only by their index tag`).toEqual(opts?.indexTagged ?? [])
    return checked
  }

  // Baseline documents written in a feature schema the TS kernel no longer reads
  // (a sweep's old profile field): they build no body today, so they have no
  // query to check.
  const NO_BODY_TODAY = new Set(['sweep_straight_z'])

  describe('regression baseline', () => {
    const entries = baseline as unknown as Array<{ label: string; ok: boolean; spec: Spec }>
    for (const entry of entries) {
      const features = entry.spec?.features ?? []
      // Same gate as the parity test: a document the frozen kernel could not build,
      // or one with a kind the TS kernel does not solve, is not a coverage case.
      if (!entry.ok || unportedKinds(features).size > 0 || NO_BODY_TODAY.has(entry.label)) continue
      if (!features.some((f) => f.kind !== 'sketch' && f.kind !== 'plane')) continue  // no body
      it(entry.label, () => {
        expect(expectFullCoverage(structuredClone(entry.spec), entry.label)).toBeGreaterThan(0)
      }, 60_000)
    }
  })

  it('pick identity corpus', () => {
    expect(expectFullCoverage(structuredClone(pickIdentityCorpus) as unknown as Spec, 'pickIdentity')).toBeGreaterThan(0)
  }, 120_000)

  // One face of this body is a sliver that tessellates to no triangle, so it
  // also guards that render face indices stay equal to the registered ones.
  it('array cut corpus', () => {
    const spec = structuredClone(arrayCutCorpus) as unknown as Spec
    expect(expectFullCoverage(spec, 'arrayCut')).toBeGreaterThan(0)
  }, 120_000)

  // The edges around that sliver near-tie on their split ordering keys (one is a
  // spline, which once keyed NaN and refused its whole group), and so do two of
  // their vertices. The named faces at an edge's ends, and the named edges at a
  // vertex, tell them apart, so none needs the index-tag last resort.
  it('array cut corpus names every edge and vertex', () => {
    const r = h.run(structuredClone(arrayCutCorpus) as unknown as Spec)
    const bodies = Object.entries((r.bodies ?? {}) as Record<string, Record<string, unknown>>)
    expect(bodies.length).toBeGreaterThan(0)
    for (const [bodyId, body] of bodies) {
      for (const kind of ['edge', 'vertex'] as const) {
        const uuids = (body[`${kind}_uuids`] as (string | null)[] | undefined) ?? []
        expect(uuids.length, `${bodyId} has ${kind}s`).toBeGreaterThan(0)
        expect(uuids.flatMap((u, i) => (u ? [] : [i])), `${bodyId} unnamed ${kind}s`).toEqual([])
      }
    }
  }, 120_000)

  it('blind hole', () => {
    expect(expectFullCoverage({ features: [...box(), ...blindHoles([[5, 5]])] }, 'blind hole')).toBeGreaterThan(0)
  })

  it('several blind holes', () => {
    const spec = { features: [...box(), ...blindHoles([[2.5, 2.5], [7.5, 2.5], [5, 7.5]])] }
    expect(expectFullCoverage(spec, 'blind holes')).toBeGreaterThan(0)
  })

  // A pocket: a blind cut whose floor is the cut tool's cap, inside the body.
  it('pocket with a floor', () => {
    const spec = { features: [
      ...box(),
      rectSketch('sk2', 4, 4, 3, 3),
      { id: 'ex2', kind: 'extrude', sketch: '$sk2', distance: 2, direction: 'normal', operation: 'cut' },
    ] }
    expect(expectFullCoverage(spec, 'pocket')).toBeGreaterThan(0)
  })

  // Filleting every edge of a box grows a corner patch at each vertex, generated
  // from the vertex rather than from any filleted edge.
  it('fillet corner patches', () => {
    const edges = queriesOf(h.body(h.run({ features: box() }), 'body_ex1'), 'edge')
    expect(edges).toHaveLength(12)
    const spec = { features: [...box(), { id: 'fillet1', kind: 'fillet', edges, radius: 1 }] }
    expect(expectFullCoverage(spec, 'fillet corners')).toBeGreaterThan(0)
  })

  it('blind hole in a filleted box', () => {
    const edges = queriesOf(h.body(h.run({ features: box() }), 'body_ex1'), 'edge')
    const spec = { features: [
      ...box(),
      { id: 'fillet1', kind: 'fillet', edges: [edges[0]], radius: 1 },
      ...blindHoles([[5, 5]]),
    ] }
    expect(expectFullCoverage(spec, 'filleted blind hole')).toBeGreaterThan(0)
  })
})
