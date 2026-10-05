// @vitest-environment node
//
// Cross-solve checkpoint cache tests for the production entry point
// ``solveLocally``. Unlike checkpointMeshReal (which drives the builder through
// SharedHarness), these go through solveLocally itself to prove it now owns a
// persistent HandleTable + last BuildState and feeds them as prevState, so an
// incremental rebuild reuses the clean-prefix checkpoints instead of rebuilding
// the whole stack.
//
// The reuse discriminator is reference identity: build() reuses the *same*
// FeatureCheckpoint object for the clean prefix (builder.ts), so a reused
// checkpoint is `===` the prior solve's checkpoint, and a rebuilt one is not.
//
// Skips when OCC.js or the Rust solver is absent.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { loadOcc } from './occ/loadOcc'
import { solveLocally, setSolveLocalsForTest, persistentTableForTest } from './solveLocally'
import { setSketchSolver, resetSketchSolver } from './features/sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'

const oc = await loadOcc()
const solveBytes = loadSolver()

function rectSketch(sketchId: string, w: number, h: number, plane = '@builtin_plane_front') {
  return {
    id: sketchId, kind: 'sketch' as const, label: 'Rectangle', plane,
    entities: [
      { id: 'bottom', kind: 'line' as const }, { id: 'right', kind: 'line' as const },
      { id: 'top', kind: 'line' as const }, { id: 'left', kind: 'line' as const },
    ],
    initial: { bottom: [0, 0, w, 0], right: [w, 0, w, h], top: [w, h, 0, h], left: [0, h, 0, 0] },
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

function extrude(sketchId: string, id: string, distance: number, operation = 'add'): Record<string, unknown> {
  return { id, kind: 'extrude', sketch: '$' + sketchId, distance, direction: 'normal', operation }
}

function checkpoints(r: Awaited<ReturnType<typeof solveLocally>>): Record<string, unknown> {
  return (r!._build_state.checkpoints ?? {}) as Record<string, unknown>
}

describe.skipIf(!oc || !solveBytes)('solveLocally cross-solve cache (real OCC + Rust solver)', () => {
  beforeAll(() => {
    resetSketchSolver()
    setSketchSolver(solveBytes)
    // Drive the production entry with the node-loaded module (loadOccWeb skips
    // under vitest) and start from a clean cache.
    setSolveLocalsForTest(async () => oc)
  })

  afterAll(() => {
    setSolveLocalsForTest(null)
    resetSketchSolver()
  })

  it('reuses the clean-prefix checkpoint when only the last feature is edited', async () => {
    const docA = {
      id: 'docA',
      features: [rectSketch('sk1', 10, 10), extrude('sk1', 'ex1', 5), extrude('sk1', 'ex2', 3, 'new')],
    }
    const r1 = await solveLocally(docA)
    expect(r1).not.toBeNull()
    expect((r1!.result as Record<string, { status?: string }>).ex2.status).toBe('ok')

    // Edit only the last feature.
    const docA2 = { ...docA, features: [docA.features[0], docA.features[1], extrude('sk1', 'ex2', 7, 'new')] }
    const r2 = await solveLocally(docA2)
    expect(r2).not.toBeNull()

    // sk1 and ex1 are the clean prefix: their checkpoints must be reused
    // (same object), proving the incremental path fired rather than a full
    // rebuild.
    expect(checkpoints(r2).sk1).toBe(checkpoints(r1).sk1)
    expect(checkpoints(r2).ex1).toBe(checkpoints(r1).ex1)
    // The edited feature is rebuilt: a fresh checkpoint object.
    expect(checkpoints(r2).ex2).not.toBe(checkpoints(r1).ex2)
    expect((r2!.result as Record<string, { status?: string }>).ex2.status).toBe('ok')
    // Anti-staleness: the rebuilt body must reflect the new distance, not serve
    // the cached 5mm geometry. (The pre-fix whitelist missed `distance`, so a
    // param edit silently returned stale geometry.)
    expect(JSON.stringify(r2!.bodies)).not.toBe(JSON.stringify(r1!.bodies))
  })

  it('re-solving an unchanged doc reuses every checkpoint', async () => {
    setSolveLocalsForTest(async () => oc)
    const doc = { id: 'docNoop', features: [rectSketch('sk1', 8, 8), extrude('sk1', 'ex1', 4)] }
    const r1 = await solveLocally(doc)
    const r2 = await solveLocally({ ...doc, features: [...doc.features] })
    expect(checkpoints(r2).sk1).toBe(checkpoints(r1).sk1)
    expect(checkpoints(r2).ex1).toBe(checkpoints(r1).ex1)
  })

  it('switching documents discards the prior cache (no stale reuse)', async () => {
    setSolveLocalsForTest(async () => oc)
    const docA = { id: 'docA', features: [rectSketch('sk1', 10, 10), extrude('sk1', 'ex1', 5)] }
    const r1 = await solveLocally(docA)

    // A different document switches the cache key, disposing docA's table.
    const docB = { id: 'docB', features: [rectSketch('skB', 6, 6), extrude('skB', 'exB', 2)] }
    const rB = await solveLocally(docB)
    expect((rB!.result as Record<string, { status?: string }>).exB.status).toBe('ok')

    // Returning to docA must rebuild from scratch (cache was reset), yielding
    // fresh checkpoint objects rather than r1's stale ones.
    const r1b = await solveLocally({ ...docA, features: [...docA.features] })
    expect(checkpoints(r1b).ex1).not.toBe(checkpoints(r1).ex1)
    expect((r1b!.result as Record<string, { status?: string }>).ex1.status).toBe('ok')
  })

  it('keeps the persistent handle table bounded across repeated incremental edits', async () => {
    // The leak gate for the clean-prefix restore copies and the superseded
    // dirty-tail shapes: every incremental build used to strand one deep
    // B-rep copy per clean-prefix body plus one registration per replaced
    // body, forever. After the per-build restore owner and the dual-owner
    // checkpoint eviction, the table returns to the same small steady state
    // no matter how many times the feature is edited.
    setSolveLocalsForTest(async () => oc)
    const doc = {
      id: 'docLeak',
      features: [
        rectSketch('skL', 10, 10),
        extrude('skL', 'exBase', 5),
        extrude('skL', 'exTop', 3, 'new'),
      ],
    }
    await solveLocally(doc)

    // Edit only the last feature; skL + exBase are the clean prefix whose
    // body is deep-copied into each rebuild.
    const docN = (distance: number) => ({
      ...doc,
      features: [doc.features[0], doc.features[1], extrude('skL', 'exTop', distance, 'new')],
    })
    let r = await solveLocally(docN(6))
    const steady = persistentTableForTest()!.liveCount()
    expect(steady).toBeGreaterThan(0)

    for (let d = 7; d <= 11; d++) {
      r = await solveLocally(docN(d))
      expect((r!.result as Record<string, { status?: string }>).exTop.status).toBe('ok')
      expect(persistentTableForTest()!.liveCount()).toBeLessThanOrEqual(steady)
    }

    // bypassCache nulls prevState, so the builder's own eviction loop cannot
    // see the outgoing generation; the cache must still come back down rather
    // than strand every retained handle.
    await solveLocally(docN(12), { bypassCache: true })
    expect(persistentTableForTest()!.liveCount()).toBeLessThanOrEqual(steady)
  })

  it('returns the persistent table to baseline after a validated solve', async () => {
    // Review-18 KE-H1: the _validate comparison build ran through the caller's
    // deps, so its full second generation landed in THIS persistent table
    // under owners (<fid>, 'cp:<fid>') that only the discarded inner
    // BuildState could ever name -- one stranded generation per validated
    // solve, and repeated alternating validates ratcheted it forever. The
    // gate: against one persistent table, a validated solve must land back on
    // the steady count, whether the rebuild was dirty or fully clean.
    setSolveLocalsForTest(async () => oc)
    const docN = (distance: number) => ({
      id: 'docValidateLeak',
      features: [
        rectSketch('skV', 10, 10),
        extrude('skV', 'exBase', 5),
        extrude('skV', 'exTop', distance, 'new'),
      ],
    })
    await solveLocally(docN(5))
    let r = await solveLocally(docN(6))
    const steady = persistentTableForTest()!.liveCount()
    expect(steady).toBeGreaterThan(0)

    // (a) A validated solve must land back on the non-validated steady count.
    r = await solveLocally(docN(7), { validate: true })
    expect(r!._validation?.passed).toBe(true)
    expect(persistentTableForTest()!.liveCount()).toBeLessThanOrEqual(steady)

    // A fully clean rebuild plateaus one step higher than a dirty one for
    // reasons that predate validation: the restore pass re-copies from the
    // carried final checkpoint while that checkpoint legitimately retains the
    // outgoing handles until the next eviction. Warm it up once and pin it.
    r = await solveLocally(docN(7), { validate: true })
    const cleanSteady = persistentTableForTest()!.liveCount()

    // (c) Repeated alternating validates (dirty / fully clean) must oscillate
    // between the two pinned levels forever, never ratchet upward.
    for (let d = 8; d <= 10; d++) {
      // Dirty-tail validate: edit the last feature, compare against a full rebuild.
      r = await solveLocally(docN(d), { validate: true })
      expect((r!.result as Record<string, { status?: string }>).exTop.status).toBe('ok')
      expect(r!._validation?.passed).toBe(true)
      expect(persistentTableForTest()!.liveCount()).toBeLessThanOrEqual(steady)
      // Fully clean validate: same doc again, nothing to rebuild.
      r = await solveLocally(docN(d), { validate: true })
      expect(r!._validation?.passed).toBe(true)
      expect(persistentTableForTest()!.liveCount()).toBeLessThanOrEqual(cleanSteady)
    }
  })

  it('returns the table to baseline after the toolbar Re-solve pairing (bypassCache + validate)', async () => {
    // Part.tsx Re-solve always pairs bypassCache:true with the validate
    // toggle, so the pre-fix hole paid DOUBLE per click: the superseded
    // generation plus a full validation generation, both stranded here.
    setSolveLocalsForTest(async () => oc)
    const doc = {
      id: 'docReSolveLeak',
      features: [rectSketch('skR', 10, 10), extrude('skR', 'exR', 5)],
    }
    const r1 = await solveLocally(doc)
    expect(r1).not.toBeNull()
    const steady = persistentTableForTest()!.liveCount()
    expect(steady).toBeGreaterThan(0)

    const r2 = await solveLocally(doc, { bypassCache: true, validate: true })
    expect(r2!._validation?.passed).toBe(true)
    expect(persistentTableForTest()!.liveCount()).toBeLessThanOrEqual(steady)

    // Repeated clicks keep landing on the same count rather than ratcheting.
    for (let i = 0; i < 3; i++) {
      await solveLocally(doc, { bypassCache: true, validate: true })
      expect(persistentTableForTest()!.liveCount()).toBeLessThanOrEqual(steady)
    }
  })

  it('keeps the table bounded when a MODIFIER of another feature body is edited repeatedly', async () => {
    // The dominant editing pattern: a fillet/cut/hole replaces a shape that
    // some OTHER feature created, and resplitBody registers the replacement
    // under body.created_by (the extrude), never under the modifier. Evicting
    // the modifier's checkpoint therefore paid only its retain; the replaced
    // solid stayed at rc=1 owned by the clean survivor until the document
    // closed -- one full OCC solid stranded PER EDIT, forever.
    setSolveLocalsForTest(async () => oc)
    const modDoc = (radius: number) => ({
      id: 'docModLeak',
      features: [
        rectSketch('skM', 10, 10),
        extrude('skM', 'exBase', 5, 'new'),
        { id: 'fiM', kind: 'fillet', edges: ['?body_exBase:edge:0'], radius },
      ],
    })
    await solveLocally(modDoc(1))
    let r = await solveLocally(modDoc(2))
    expect((r!.result as Record<string, { status?: string }>).fiM.status).toBe('ok')
    const steady = persistentTableForTest()!.liveCount()
    expect(steady).toBeGreaterThan(0)

    for (let radius = 3; radius <= 7; radius++) {
      r = await solveLocally(modDoc(radius))
      expect((r!.result as Record<string, { status?: string }>).fiM.status).toBe('ok')
      expect(persistentTableForTest()!.liveCount()).toBeLessThanOrEqual(steady)
    }
  })
})
