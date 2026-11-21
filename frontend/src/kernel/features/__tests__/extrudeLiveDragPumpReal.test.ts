// @vitest-environment node
//
// The backlog guard for a live feature-handle drag, against the real kernel:
// twenty field values offered through the newest-value pump must run far fewer
// solves than offers, and the last solve must land on the released distance.
// The session and scheduler here are the production ones usePartDoc wraps; the
// node suite drives them headless so the real OCC build runs without a DOM.
//
// Skips when OCC.js or the Rust solver is absent.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createDocSession } from '@/session/DocSession'
import { createWorkerSolveScheduler } from '@/hooks/workerSolveScheduler'
import { createLiveValuePump } from '@/components/Geometry3D/liveValuePump'
import { solveLocally } from '@/kernel/solveLocally'
import { loadOcc, resetOcc } from '@/kernel/occ/loadOcc'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { resetSketchSolver, setSketchSolver } from '@/kernel/features/sketch'
import { setSolveLocalsForTest } from '@/kernel/solveLocally'
import type { BuildResponse } from '@/kernel/builder'
import type { PartDoc, SketchData } from '@/types/cad'
import { assertMeshBbox, extrudeSpec, rectSketchSk } from '@/kernel/features/extrudeRealSupport'

const oc = await loadOcc()
const solveBytes = loadSolver()

describe.skipIf(!oc || !solveBytes)('a live handle drag against the real kernel', () => {
  beforeAll(() => {
    resetSketchSolver()
    setSketchSolver(solveBytes!)
    setSolveLocalsForTest(loadOcc, resetOcc)
  })

  afterAll(() => {
    setSolveLocalsForTest(null)
    resetSketchSolver()
  })

  it('runs far fewer solves than offers and lands on the released distance', async () => {
    const doc = {
      version: 1,
      kind: 'part',
      features: [rectSketchSk('sk1', 10, 8), extrudeSpec('sk1', 'ex1', { distance: 5 })],
    } as unknown as PartDoc
    const cell: { current: PartDoc | null } = { current: doc }
    const solveResults: { current: Record<string, SketchData> } = { current: {} }

    // One worker means one solve at a time; the scheduler's reSolve is called
    // for each request, so serialise them exactly as the WorkerActor does.
    let solveCount = 0
    let lastResponse: BuildResponse | null = null
    let chain: Promise<unknown> = Promise.resolve()
    const reSolve = (next: PartDoc): Promise<void> => {
      const run = chain.then(async () => {
        solveCount += 1
        lastResponse = await solveLocally(next as unknown as Record<string, unknown>)
      })
      chain = run.catch(() => {})
      return run
    }

    const session = createDocSession({
      cloneDoc: source => structuredClone(source),
      doc: { get: () => cell.current, set: next => { cell.current = next } },
      solve: createWorkerSolveScheduler(() => reSolve),
      solveResults: { get: () => solveResults.current, set: next => { solveResults.current = next } },
      editorFacts: () => ({ editingFeatureId: 'ex1', rollbackPosition: null }),
      dirtyFacts: () => ({ dirty: false, saves: 0, savedHash: null }),
    })
    session.begin('edit', { suppressed: true })

    const pump = createLiveValuePump(value => {
      session.execute({ type: 'set_extrude_field', featureId: 'ex1', field: 'distance', value })
      return session.idle()
    })
    for (let value = 6; value <= 25; value++) pump.offer(value)

    // Release at 25: the final value lands at once, then the pump is dropped.
    pump.cancel()
    const released = session.execute({ type: 'set_extrude_field', featureId: 'ex1', field: 'distance', value: 25 })
    expect(released.ok).toBe(true)
    await session.idle()

    expect(lastResponse).not.toBeNull()
    const mesh = (lastResponse as unknown as { bodies: Record<string, { mesh: Record<string, unknown> }> })
      .bodies.body_ex1.mesh
    assertMeshBbox(mesh, [0, 10], [0, 8], [0, 25])
    // The backlog guard: the pump collapses twenty offers into the first send
    // and the release, two solves, never one solve per pointer value.
    expect(solveCount).toBe(2)
    const feature = cell.current?.features?.find(f => f.id === 'ex1')
    expect(feature && 'extrude' in feature ? feature.extrude.distance : undefined).toBe(25)
    expect(session.historyEntries().undo).toHaveLength(0)  // still open: no entry yet
  })
})
