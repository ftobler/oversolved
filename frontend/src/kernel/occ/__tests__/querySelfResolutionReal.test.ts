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

  /** Returns how many checked primitives are owned by a feature other than the
   *  first extrude, so the modifier cases can prove they exercised one. */
  function expectSelfResolution(spec: Spec, bodyId: string): number {
    const r = h.run(spec)
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

  it('boolean cut', () => {
    expectSelfResolution({ features: [
      rectSketch('sk1', 10, 10),
      { id: 'ex1', kind: 'extrude', sketch: '$sk1', distance: 10, direction: 'normal', operation: 'add' },
      rectSketch('sk2', 4, 4, { offsetX: 3, offsetY: 3 }),
      { id: 'ex2', kind: 'extrude', sketch: '$sk2', distance: 12, direction: 'normal', operation: 'cut' },
    ] }, 'body_ex1')
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
