// @vitest-environment node
//
// The extensive query regression corpus for query-naming-by-construction.md
// (Stage 7b): a query is captured on an entity, an edit is applied, the repo is
// rebuilt from the last checkpoint snapshot, and the SAME persisted query must
// still resolve to the morally-same entity. Each row also asserts WHICH resolver
// tier resolved it (Repository._lastTier, wired in Stage 7a), so a silent
// UUID -> ancestral downgrade -- or a silently-wrong resolution -- is caught.
//
// Skips when OCC.js or the Rust solver is absent, like the other real-OCC gates.

import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from '../occ/loadOcc'
import { SharedHarness } from '../occ/sharedHarness'
import { setSketchSolver, resetSketchSolver } from '../features/sketch'
import { repoFromSnapshot } from '../builder'
import type { BuildResponse } from '../builder'
import type { BuildState, FeatureCheckpoint } from '../types3d'
import { mintFaceUuid, capFacePath, filletFacePath, splitFacePath, sideFacePath } from '../constructionName'
import { parseAncestry } from '../query'
import { loadSolver } from '@/wasm-kernel/loadSolver'

const oc = await loadOcc()
const solveBytes = loadSolver()

/** A rectangle sketch (four constrained lines) at an optional in-plane offset. */
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

/** The same rectangle, but with the bottom edge deleted and re-added under a new
 *  entity id ('base'). Geometry is identical; the construction slot is not. */
function rectSketchReplacedBottom(sketchId: string, w: number, h: number) {
  return {
    id: sketchId, kind: 'sketch' as const, label: 'Rectangle', plane: '@builtin_plane_front',
    entities: [
      { id: 'base', kind: 'line' as const }, { id: 'right', kind: 'line' as const },
      { id: 'top', kind: 'line' as const }, { id: 'left', kind: 'line' as const },
    ],
    initial: {
      base: [0, 0, w, 0], right: [w, 0, w, h],
      top: [w, h, 0, h], left: [0, h, 0, 0],
    },
    constraints: [
      { id: 'c1', kind: 'coincident' as const, a: { entity: 'base', point: 'end' as const }, b: { entity: 'right', point: 'start' as const } },
      { id: 'c2', kind: 'coincident' as const, a: { entity: 'right', point: 'end' as const }, b: { entity: 'top', point: 'start' as const } },
      { id: 'c3', kind: 'coincident' as const, a: { entity: 'top', point: 'end' as const }, b: { entity: 'left', point: 'start' as const } },
      { id: 'c4', kind: 'coincident' as const, a: { entity: 'left', point: 'end' as const }, b: { entity: 'base', point: 'start' as const } },
      { id: 'c5', kind: 'horizontal' as const, target: { entity: 'base' } },
      { id: 'c6', kind: 'horizontal' as const, target: { entity: 'top' } },
      { id: 'c7', kind: 'vertical' as const, target: { entity: 'right' } },
      { id: 'c8', kind: 'vertical' as const, target: { entity: 'left' } },
      { id: 'c9', kind: 'length' as const, target: { entity: 'base' }, value: w },
      { id: 'c10', kind: 'length' as const, target: { entity: 'left' }, value: h },
    ],
  }
}

const UUID_RE = /@u\|([uev]_[0-9a-f]{16})/

type ResolvedEl = { uuid?: string; created_by?: string; type?: string } | null

function faceQueries(r: BuildResponse, bodyId: string): string[] {
  const body = (r.bodies as Record<string, { mesh?: { face_queries?: string[] } }>)[bodyId]
  return body?.mesh?.face_queries ?? []
}

function edgeQueries(r: BuildResponse, bodyId: string): string[] {
  const body = (r.bodies as Record<string, { edge_queries?: string[] }>)[bodyId]
  return body?.edge_queries ?? []
}

function vertexQueries(r: BuildResponse, bodyId: string): string[] {
  const body = (r.bodies as Record<string, { vertex_queries?: string[] }>)[bodyId]
  return body?.vertex_queries ?? []
}

/** The face query carrying a specific construction UUID (the @u| token). */
function faceQueryWithUuid(r: BuildResponse, bodyId: string, uuid: string): string | undefined {
  return faceQueries(r, bodyId).find((q) => q.includes(`@u|${uuid}`))
}

/** Rebuild the global repo from the last feature's checkpoint snapshot. */
function repoOf(r: BuildResponse) {
  const state = r._build_state as BuildState
  const order = state.feature_order
  let snap: Record<string, unknown> | null = null
  for (let i = order.length - 1; i >= 0; i--) {
    const cp = state.checkpoints[order[i]] as FeatureCheckpoint | undefined
    if (cp?.repo_snapshot) { snap = cp.repo_snapshot; break }
  }
  if (snap === null) throw new Error('no checkpoint repo snapshot')
  return repoFromSnapshot(snap)
}

function uuidOf(query: string): string {
  const m = UUID_RE.exec(query)
  if (m === null) throw new Error(`query carries no @u| token: ${query}`)
  return m[1]
}

describe.skipIf(!oc || !solveBytes)('naming-by-construction corpus (real OCC + Rust solver)', () => {
  const h = new SharedHarness(oc!)
  beforeAll(() => {
    if (!oc || !solveBytes) throw new Error('unreachable: skipIf guards this')
    resetSketchSolver()
    setSketchSolver(solveBytes!)
  })

  it('extrude length 10->11: a side/cap face resolves by UUID', () => {
    // A pure length change moves geometry but touches no construction slot, so
    // the face keeps its exact minted UUID: the query resolves on the primary tier.
    const s1 = { features: [rectSketch('sk1', 10, 10), { id: 'ex1', kind: 'extrude', sketch: '$sk1', distance: 10, direction: 'normal', operation: 'new' }] }
    const r1 = h.run(s1)
    const q = faceQueries(r1, 'body_ex1').find((x) => UUID_RE.test(x))
    expect(q, 'a face query should carry a @u| token').toBeDefined()
    const capturedUuid = uuidOf(q!)

    const s2 = { features: [rectSketch('sk1', 10, 10), { id: 'ex1', kind: 'extrude', sketch: '$sk1', distance: 11, direction: 'normal', operation: 'new' }] }
    const r2 = h.run(s2, { prevState: r1._build_state })

    const repo = repoOf(r2)
    const el = repo.query(q!) as ResolvedEl
    expect(el, 'the captured query must still resolve after the edit').not.toBeNull()
    expect(el?.uuid, 'it must resolve to the same construction slot').toBe(capturedUuid)
    expect(repo._lastTier, 'a stable-UUID face resolves on the primary UUID tier').toBe('uuid')
  })

  it('prism cap (empty ancestry list): emitted cap query carries the profile tokens exactly as the builder registers them', () => {
    // A prism cap face carries an EMPTY ancestry token list (prismLineage.ts:
    // faceLineage[gh] = [] for a cap). classifyFace must treat that as "no
    // ancestry" so the emitted query falls back to the profile tokens -- the
    // SAME tokens the builder's registered key carries. Without them a stale
    // cap UUID resolves against the bare createdBy+bodyId net shared by every
    // face of the body (ambiguous or silently-wrong).
    const s1 = { features: [rectSketch('sk1', 10, 10), { id: 'ex1', kind: 'extrude', sketch: '$sk1', distance: 10, direction: 'normal', operation: 'new' }] }
    const r1 = h.run(s1)
    const capUuid = mintFaceUuid(capFacePath('ex1', 'start'))
    const q = faceQueryWithUuid(r1, 'body_ex1', capUuid)
    expect(q, 'the start cap should carry its minted UUID').toBeDefined()

    const [ids] = parseAncestry(q!)
    const profileTokens = ids.filter((i) => i.startsWith('@sk1/'))
    expect(profileTokens.length, 'the emitted cap query must carry the profile tokens (empty ancestry list = fallback)').toBeGreaterThan(0)

    const repo = repoOf(r1)
    const el = repo.query(q!) as ResolvedEl
    expect(el, 'the cap query must resolve in the repo').not.toBeNull()

    // The registered ancestral key covering the cap query's non-uuid,
    // non-classifier ids must contain the profile tokens: the emitted query and
    // the builder's key are one string, so a stale UUID can recover here.
    const queryAncestors = new Set(ids.filter((i) => !i.startsWith('@u|') && !i.startsWith('@cls_')))
    const covering = [...repo.ancestral.values()].filter((entry) => {
      for (const id of queryAncestors) if (!entry.set.has(id)) return false
      return true
    })
    expect(covering.length, 'some registered ancestral set must cover the cap query ids').toBeGreaterThan(0)
    for (const entry of covering) {
      for (const t of profileTokens) {
        expect(entry.set.has(t), 'the registered ancestral set must contain the profile tokens').toBe(true)
      }
    }
  })

  it('box vertices: every vertex query carries a unique @u| UUID', () => {
    // A box's 8 corner vertices each meet exactly 3 named faces, so each earns a
    // construction UUID (Stage 7c). The set must be unique -- a duplicate vertex
    // query is the exact "grouped selection" defect the coverage lock guards.
    const s1 = { features: [rectSketch('sk1', 10, 10), { id: 'ex1', kind: 'extrude', sketch: '$sk1', distance: 10, direction: 'normal', operation: 'new' }] }
    const r1 = h.run(s1)
    const vqs = vertexQueries(r1, 'body_ex1')
    expect(vqs.length, 'a box has 8 vertices').toBe(8)
    const withUuid = vqs.filter((q) => UUID_RE.test(q))
    expect(withUuid.length, 'every box vertex meets 3 named faces, so all earn a @u| UUID').toBe(8)
    const uuids = withUuid.map((q) => uuidOf(q))
    expect(new Set(uuids).size, 'the 8 vertex UUIDs must be unique').toBe(8)
    for (const u of uuids) expect(u.startsWith('v_'), 'vertex UUIDs use the v_ prefix').toBe(true)
  })

  it('no geometry token anywhere: box face/edge/vertex queries carry zero @gd*/@g*_ floats', () => {
    // The whole point of query-naming-by-construction: a persisted query holds
    // only construction UUIDs + ancestral tokens, never a geometry-identity token.
    // Stage 7d dropped the last one (the @gdv| vertex descriptor), so a freshly
    // built box exposes NO geometry-identity substring on any pickable primitive.
    const GEOM_TOKEN = /@gd[fev]\||@gface_|@gedge_|@gvertex_|@gnormal_/
    const s1 = { features: [rectSketch('sk1', 10, 10), { id: 'ex1', kind: 'extrude', sketch: '$sk1', distance: 10, direction: 'normal', operation: 'new' }] }
    const r1 = h.run(s1)
    const all = [
      ...faceQueries(r1, 'body_ex1'),
      ...edgeQueries(r1, 'body_ex1'),
      ...vertexQueries(r1, 'body_ex1'),
    ]
    expect(all.length, 'the box exposes face + edge + vertex queries').toBeGreaterThan(0)
    for (const q of all) {
      expect(GEOM_TOKEN.test(q), `query must carry no geometry-identity token: ${q}`).toBe(false)
    }
  })

  it('extrude length 10->11: a vertex resolves by UUID', () => {
    // A vertex is named by the set of faces meeting at it, all length-independent,
    // so the corner keeps its exact minted UUID across a pure length edit and the
    // persisted query resolves on the primary UUID tier.
    const s1 = { features: [rectSketch('sk1', 10, 10), { id: 'ex1', kind: 'extrude', sketch: '$sk1', distance: 10, direction: 'normal', operation: 'new' }] }
    const r1 = h.run(s1)
    const q = vertexQueries(r1, 'body_ex1').find((x) => UUID_RE.test(x))
    expect(q, 'a vertex query should carry a @u| token').toBeDefined()
    const capturedUuid = uuidOf(q!)

    const s2 = { features: [rectSketch('sk1', 10, 10), { id: 'ex1', kind: 'extrude', sketch: '$sk1', distance: 11, direction: 'normal', operation: 'new' }] }
    const r2 = h.run(s2, { prevState: r1._build_state })

    const repo = repoOf(r2)
    const el = repo.query(q!) as ResolvedEl
    expect(el, 'the captured vertex query must still resolve after the edit').not.toBeNull()
    expect(el?.uuid, 'it must resolve to the same construction slot').toBe(capturedUuid)
    expect(el?.type, 'the resolved element is a vertex').toBe('vertex')
    expect(repo._lastTier, 'a stable-UUID vertex resolves on the primary UUID tier').toBe('uuid')
  })

  it('extrude length 10->11: a rim edge resolves by UUID', () => {
    // An edge is named by its adjacent face-pair UUIDs, both length-independent.
    const s1 = { features: [rectSketch('sk1', 10, 10), { id: 'ex1', kind: 'extrude', sketch: '$sk1', distance: 10, direction: 'normal', operation: 'new' }] }
    const r1 = h.run(s1)
    const q = edgeQueries(r1, 'body_ex1').find((x) => UUID_RE.test(x))
    expect(q, 'an edge query should carry a @u| token').toBeDefined()
    const capturedUuid = uuidOf(q!)

    const s2 = { features: [rectSketch('sk1', 10, 10), { id: 'ex1', kind: 'extrude', sketch: '$sk1', distance: 11, direction: 'normal', operation: 'new' }] }
    const r2 = h.run(s2, { prevState: r1._build_state })

    const repo = repoOf(r2)
    const el = repo.query(q!) as ResolvedEl
    expect(el).not.toBeNull()
    expect(el?.uuid).toBe(capturedUuid)
    expect(repo._lastTier).toBe('uuid')
  })

  it('sketch dimension edit (width 10->12): a side face resolves by UUID', () => {
    // The sketch entity ids are unchanged by a length-constraint edit, so the
    // derived construction UUID is unchanged: the query resolves on the UUID tier.
    const s1 = { features: [rectSketch('sk1', 10, 10), { id: 'ex1', kind: 'extrude', sketch: '$sk1', distance: 5, direction: 'normal', operation: 'new' }] }
    const r1 = h.run(s1)
    const q = faceQueries(r1, 'body_ex1').find((x) => UUID_RE.test(x))
    expect(q).toBeDefined()
    const capturedUuid = uuidOf(q!)

    const s2 = { features: [rectSketch('sk1', 12, 10), { id: 'ex1', kind: 'extrude', sketch: '$sk1', distance: 5, direction: 'normal', operation: 'new' }] }
    const r2 = h.run(s2, { prevState: r1._build_state })

    const repo = repoOf(r2)
    const el = repo.query(q!) as ResolvedEl
    expect(el, 'the captured query must still resolve after the dimension edit').not.toBeNull()
    expect(el?.uuid).toBe(capturedUuid)
    expect(repo._lastTier).toBe('uuid')
  })

  it('boolean add (fuse): an inherited target face keeps its UUID', () => {
    // The base box bottom cap is untouched by a bump fused onto its top, so its
    // minted UUID is carried across the fuse by OCC subshape identity (Modified),
    // NOT geometry: the persisted query resolves on the UUID tier after the fuse.
    const s1 = { features: [rectSketch('sk1', 20, 20), { id: 'ex1', kind: 'extrude', sketch: '$sk1', distance: 10, direction: 'normal', operation: 'new' }] }
    const r1 = h.run(s1)
    const capUuid = mintFaceUuid(capFacePath('ex1', 'start'))
    const q = faceQueryWithUuid(r1, 'body_ex1', capUuid)
    expect(q, 'the base box bottom cap should carry its minted UUID').toBeDefined()

    const s2 = {
      features: [
        rectSketch('sk1', 20, 20),
        { id: 'ex1', kind: 'extrude', sketch: '$sk1', distance: 10, direction: 'normal', operation: 'new' },
        rectSketch('sk2', 6, 6, { offsetX: 7, offsetY: 7 }),
        { id: 'ex2', kind: 'extrude', sketch: '$sk2', distance: 5, direction: 'normal', operation: 'add', merge_target: 'body_ex1' },
      ],
    }
    const r2 = h.run(s2, { prevState: r1._build_state })

    const repo = repoOf(r2)
    const el = repo.query(q!) as ResolvedEl
    expect(el, 'the inherited bottom cap must still resolve after the fuse').not.toBeNull()
    expect(el?.uuid, 'it kept its UUID across the boolean').toBe(capUuid)
    expect(repo._lastTier, 'an inherited face resolves on the primary UUID tier').toBe('uuid')
  })

  it('fillet on an edge: the fillet face resolves by role=fillet UUID and a neighbour keeps its UUID', () => {
    const base = { features: [rectSketch('sk1', 10, 10), { id: 'ex1', kind: 'extrude', sketch: '$sk1', distance: 5, direction: 'normal', operation: 'new' }] }
    const r0 = h.run(base)
    const filletEdgeQ = edgeQueries(r0, 'body_ex1').find((x) => UUID_RE.test(x))
    expect(filletEdgeQ, 'the box should expose a UUID-carrying edge to fillet').toBeDefined()
    const filletedEdgeUuid = uuidOf(filletEdgeQ!)

    const s1 = { features: [...base.features, { id: 'fillet1', kind: 'fillet', edges: [filletEdgeQ], radius: 1 }] }
    const r1 = h.run(s1)
    // The generated fillet face is named role=fillet, slotted by the filleted
    // edge's UUID -- both symbolic, so the query is geometry-free.
    const filletFaceUuid = mintFaceUuid(filletFacePath('fillet1', filletedEdgeUuid))
    const filletQ = faceQueryWithUuid(r1, 'body_ex1', filletFaceUuid)
    expect(filletQ, 'the fillet face should carry its role=fillet UUID').toBeDefined()
    // A neighbour untouched by the fillet: the bottom cap keeps its own UUID.
    const capUuid = mintFaceUuid(capFacePath('ex1', 'start'))
    const capQ = faceQueryWithUuid(r1, 'body_ex1', capUuid)
    expect(capQ, 'the untouched bottom cap should carry its UUID').toBeDefined()

    // Edit: grow the fillet radius. Neither UUID depends on the radius.
    const s2 = { features: [...base.features, { id: 'fillet1', kind: 'fillet', edges: [filletEdgeQ], radius: 2 }] }
    const r2 = h.run(s2, { prevState: r1._build_state })

    const repo = repoOf(r2)
    const fEl = repo.query(filletQ!) as ResolvedEl
    expect(fEl, 'the fillet face must still resolve after the radius edit').not.toBeNull()
    expect(fEl?.uuid).toBe(filletFaceUuid)
    expect(repo._lastTier, 'the fillet face resolves on the primary UUID tier').toBe('uuid')

    const nEl = repo.query(capQ!) as ResolvedEl
    expect(nEl, 'the neighbour cap must still resolve after the radius edit').not.toBeNull()
    expect(nEl?.uuid).toBe(capUuid)
    expect(repo._lastTier, 'the neighbour keeps its own UUID tier').toBe('uuid')
  })

  it('boolean cut splitting a face: each half resolves to its own split-index UUID', () => {
    // A full-width, narrow, shallow cut across the bottom of the box removes a
    // band z[0,3], y[4,6] spanning the whole X, splitting the original bottom cap
    // into two disjoint strips (y[0,4] and y[6,10]) while the body stays intact
    // above the groove. The two children share identical ancestry, so only the
    // confined split-index UUID (ordered by their relative position in the parent
    // face's frame) can tell them apart -- and it survives an unrelated edit.
    const base = [
      rectSketch('sk1', 10, 10),
      { id: 'ex1', kind: 'extrude', sketch: '$sk1', distance: 10, direction: 'normal', operation: 'new' },
    ]
    const tool = [
      rectSketch('sk2', 12, 2, { offsetX: -1, offsetY: 4 }),
      { id: 'ex2', kind: 'extrude', sketch: '$sk2', distance: 3, direction: 'normal', operation: 'cut' },
    ]
    const r1 = h.run({ features: [...base, ...tool] })

    const parentUuid = mintFaceUuid(capFacePath('ex1', 'start'))
    const child0 = mintFaceUuid(splitFacePath(parentUuid, 0))
    const child1 = mintFaceUuid(splitFacePath(parentUuid, 1))
    const q0 = faceQueryWithUuid(r1, 'body_ex1', child0)
    const q1 = faceQueryWithUuid(r1, 'body_ex1', child1)
    expect(q0, 'the first split half should carry its :split:0 UUID').toBeDefined()
    expect(q1, 'the second split half should carry its :split:1 UUID').toBeDefined()
    expect(q0).not.toBe(q1)

    // Edit: grow the base height. The bottom cut (and its split) is untouched.
    const base2 = [
      rectSketch('sk1', 10, 10),
      { id: 'ex1', kind: 'extrude', sketch: '$sk1', distance: 12, direction: 'normal', operation: 'new' },
    ]
    const r2 = h.run({ features: [...base2, ...tool] }, { prevState: r1._build_state })

    const repo = repoOf(r2)
    const el0 = repo.query(q0!) as ResolvedEl
    expect(el0, 'the first half must still resolve after the edit').not.toBeNull()
    expect(el0?.uuid).toBe(child0)
    expect(repo._lastTier, 'a split child resolves on the primary UUID tier').toBe('uuid')

    const el1 = repo.query(q1!) as ResolvedEl
    expect(el1, 'the second half must still resolve after the edit').not.toBeNull()
    expect(el1?.uuid).toBe(child1)
    expect(repo._lastTier).toBe('uuid')

    // The two halves did not collapse onto one another.
    expect(el0).not.toBe(el1)
  })

  it('sketch entity replaced: the old query fails loud (no silently-wrong sibling)', () => {
    // The side face is named from sketch entity 'bottom'. Deleting that edge and
    // re-adding it as 'base' changes the construction slot: BOTH the UUID (derived
    // from the entity id) and the ancestral token (@sk1/bottom) name nothing live.
    // The body still exists with five sibling faces, so a geometry-guessing
    // resolver could latch onto one. It must not: the honest outcome is a miss
    // (documented fail-loud), never a silently-wrong sibling.
    const s1 = { features: [rectSketch('sk1', 10, 10), { id: 'ex1', kind: 'extrude', sketch: '$sk1', distance: 5, direction: 'normal', operation: 'new' }] }
    const r1 = h.run(s1)
    const sideUuid = mintFaceUuid(sideFacePath('ex1', 'sk1/bottom'))
    const q = faceQueryWithUuid(r1, 'body_ex1', sideUuid)
    expect(q, 'the side face from entity bottom should carry its UUID').toBeDefined()

    const s2 = { features: [rectSketchReplacedBottom('sk1', 10, 10), { id: 'ex1', kind: 'extrude', sketch: '$sk1', distance: 5, direction: 'normal', operation: 'new' }] }
    const r2 = h.run(s2, { prevState: r1._build_state })

    const repo = repoOf(r2)
    const el = repo.query(q!) as ResolvedEl
    expect(el, 'the replaced-entity face must not resolve to a sibling').toBeNull()
    expect(repo._lastTier, 'the construction slot is gone: the honest fail-loud outcome').toBe('miss')
  })

  it('feature reorder (independent bodies): a face UUID is unchanged', () => {
    // Two independent extrudes make two separate bodies. Swapping their order in
    // the feature list changes nothing about either construction path, so the
    // captured face still resolves on the UUID tier to the same slot.
    const skA = rectSketch('skA', 10, 10)
    const exA = { id: 'exA', kind: 'extrude', sketch: '$skA', distance: 5, direction: 'normal', operation: 'new' }
    const skB = rectSketch('skB', 8, 8, { offsetX: 30, offsetY: 0 })
    const exB = { id: 'exB', kind: 'extrude', sketch: '$skB', distance: 5, direction: 'normal', operation: 'new' }

    const r1 = h.run({ features: [skA, exA, skB, exB] })
    const capUuid = mintFaceUuid(capFacePath('exA', 'start'))
    const q = faceQueryWithUuid(r1, 'body_exA', capUuid)
    expect(q, 'body A cap should carry its UUID').toBeDefined()

    // Reorder: build B before A.
    const r2 = h.run({ features: [skB, exB, skA, exA] }, { prevState: r1._build_state })

    const repo = repoOf(r2)
    const el = repo.query(q!) as ResolvedEl
    expect(el, 'the face must still resolve after the reorder').not.toBeNull()
    expect(el?.uuid, 'the reorder did not change the construction path').toBe(capUuid)
    expect(repo._lastTier).toBe('uuid')
  })

  it('delete feature: a query into a deleted body fails loud, not silently wrong', () => {
    // Two independent bodies; a face of body B is captured, then feature exB is
    // deleted. The captured query names an entity that no longer exists. It must
    // fail loud (resolve to nothing) rather than silently latch onto body A's
    // morally-different face.
    const skA = rectSketch('skA', 10, 10)
    const exA = { id: 'exA', kind: 'extrude', sketch: '$skA', distance: 5, direction: 'normal', operation: 'new' }
    const skB = rectSketch('skB', 8, 8, { offsetX: 30, offsetY: 0 })
    const exB = { id: 'exB', kind: 'extrude', sketch: '$skB', distance: 5, direction: 'normal', operation: 'new' }

    const r1 = h.run({ features: [skA, exA, skB, exB] })
    const capUuid = mintFaceUuid(capFacePath('exB', 'start'))
    const q = faceQueryWithUuid(r1, 'body_exB', capUuid)
    expect(q, 'body B cap should carry its UUID').toBeDefined()

    // Delete exB (and its sketch): body_exB no longer exists.
    const r2 = h.run({ features: [skA, exA] }, { prevState: r1._build_state })

    const repo = repoOf(r2)
    const el = repo.query(q!) as ResolvedEl
    expect(el, 'a query into a deleted body must not resolve to a surviving body').toBeNull()
    expect(repo._lastTier, 'nothing resolved: the honest fail-loud outcome').toBe('miss')
  })
})
