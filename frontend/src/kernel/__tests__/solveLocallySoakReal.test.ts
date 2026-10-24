// @vitest-environment node
//
// D3 soak: the trap only appeared after ~35 minutes of one process serving six
// interleaved clients, each with its own docId, so the cross-solve cache was
// reset on almost every call. This scales that pattern down: 500 solves
// alternating six document ids, measuring the WASM heap and the live handle
// count. Either one growing without bound is the leak the trap was built on.
//
// The real kernel is required; this skips like the other gated Real suites.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { loadOcc } from '../occ/loadOcc'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { solveLocally, setSolveLocalsForTest, persistentTableForTest } from '../solveLocally'
import { resetSketchSolver, setSketchSolver } from '../features/sketch'
import type { OccModule } from '../occ/occTypes'

const oc = await loadOcc()
const solveBytes = loadSolver()

const DOC_COUNT = 6
const SOLVES = 500
// The first solves allocate the steady-shape mesh/edge buffers; compare growth
// after that rather than against zero.
const WARMUP = 30

function rectSketch(sketchId: string, w: number, h: number) {
  return {
    id: sketchId, kind: 'sketch' as const, label: 'Rectangle', plane: '@builtin_plane_front',
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

function soakyDocs(): Array<{ id: string; features: Array<Record<string, unknown>> }> {
  return Array.from({ length: DOC_COUNT }, (_, i) => {
    const size = 8 + i
    return {
      id: `soak-doc-${i}`,
      features: [
        rectSketch(`sk${i}`, size, size + 1),
        { id: `ex${i}`, kind: 'extrude', sketch: `$sk${i}`, distance: 3 + i, direction: 'normal', operation: 'add' },
      ],
    }
  })
}

/** The live module's linear-memory length in bytes. */
function heapLength(module: OccModule): number {
  const heap = (module as unknown as { HEAP8?: Uint8Array }).HEAP8
  return heap?.length ?? 0
}

describe.skipIf(!oc || !solveBytes)('solveLocally doc-switch soak (real OCC + Rust solver)', () => {
  beforeAll(() => {
    resetSketchSolver()
    setSketchSolver(solveBytes)
    setSolveLocalsForTest(async () => oc)
  })

  afterAll(() => {
    setSolveLocalsForTest(null)
    resetSketchSolver()
  })

  it('keeps the heap and the live handle count bounded across 500 alternating-doc solves', async () => {
    const docs = soakyDocs()
    let heapSteady = 0
    let liveSteady = 0
    for (let i = 0; i < WARMUP; i++) {
      const response = await solveLocally(docs[i % DOC_COUNT])
      expect(response).not.toBeNull()
      heapSteady = heapLength(oc!)
      liveSteady = persistentTableForTest()?.liveCount() ?? 0
    }
    expect(heapSteady).toBeGreaterThan(0)
    expect(liveSteady).toBeGreaterThan(0)

    let maxHeap = heapSteady
    let maxLive = liveSteady
    for (let i = 0; i < SOLVES; i++) {
      const response = await solveLocally(docs[i % DOC_COUNT])
      expect(response).not.toBeNull()
      const result = response!.result as Record<string, { status?: string }>
      expect(result[`ex${i % DOC_COUNT}`].status).toBe('ok')
      maxHeap = Math.max(maxHeap, heapLength(oc!))
      maxLive = Math.max(maxLive, persistentTableForTest()?.liveCount() ?? 0)
    }

    // Each switch frees the previous doc's table before the next build, so the
    // live count is the same per-doc steady state every time. A legitimate heap
    // growth step (wasm memory pages) is allowed, but not 500 of them.
    expect(maxLive).toBeLessThanOrEqual(liveSteady)
    expect(maxHeap).toBeLessThanOrEqual(heapSteady * 2)
  }, 600_000)
})
