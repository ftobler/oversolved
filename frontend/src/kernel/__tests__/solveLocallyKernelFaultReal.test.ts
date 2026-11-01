// @vitest-environment node
//
// D1 regression: one WASM trap used to poison the process for good. The OCC
// module stayed memoized, the persistent HandleTable kept pointing into its
// undefined heap, and every later solve measured "memory access out of bounds".
//
// These drive the real kernel and stand in a module whose every property read
// traps, which is the same path an out-of-bounds access takes once the first
// feature reaches OCC. Skips when OCC.js or the Rust solver is absent.

import { describe, it, expect, afterAll, beforeAll, vi } from 'vitest'
import { loadOcc } from '../occ/loadOcc'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { loadTopology } from '@/wasm-kernel/loadTopology'
import {
  solveLocally,
  setOccLoader,
  setSolveLocalsForTest,
  persistentTableForTest,
} from '../solveLocally'
import { resetSketchSolver, setSketchSolver, setSketchTopology } from '../features/sketch'
import { KernelFault } from '../errors'
import type { OccModule } from '../occ/occTypes'
import type { SolveBytes } from '@/wasm-kernel/wasmTypes'

const oc = await loadOcc()
const solveBytes = loadSolver()

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

function extrude(id: string, distance: number): Record<string, unknown> {
  return { id, kind: 'extrude', sketch: '$sk1', distance, direction: 'normal', operation: 'add' }
}

/** A module stand-in that traps on the first property the build reads. */
function trappingModule(): OccModule {
  return new Proxy({}, {
    get(): never {
      throw new WebAssembly.RuntimeError('memory access out of bounds')
    },
  }) as OccModule
}

const doc = (distance: number) => ({
  id: 'doc-kernel-fault',
  features: [rectSketch('sk1', 10, 10), extrude('ex1', distance)],
})

describe.skipIf(!oc || !solveBytes)('solveLocally kernel trap recovery (real OCC + Rust solver)', () => {
  beforeAll(() => {
    resetSketchSolver()
    setSketchSolver(solveBytes)
  })

  afterAll(() => {
    setSolveLocalsForTest(null)
    resetSketchSolver()
  })

  it('retries once on a fresh module and builds the document', async () => {
    let calls = 0
    setSolveLocalsForTest(async () => {
      calls++
      return calls === 1 ? trappingModule() : oc
    })

    const response = await solveLocally(doc(5))
    expect(calls).toBe(2)
    expect(response).not.toBeNull()
    const result = response!.result as Record<string, { status?: string }>
    expect(result.ex1.status).toBe('ok')
    expect(Object.keys(response!.bodies)).toHaveLength(1)
  })

  it('reports a second trap as a KernelFault and drops the handles without disposing them', async () => {
    setSolveLocalsForTest(async () => oc)
    const first = await solveLocally(doc(5))
    expect(first).not.toBeNull()
    const table = persistentTableForTest()
    expect(table).not.toBeNull()
    // Disposal runs delete() on the trapped heap, so recovery must drop the
    // table by reference instead of freeing it.
    const dispose = vi.spyOn(table!, 'disposeAll')

    // Same doc id: no switch reset, so the table under test survives into the
    // failing solve. A changed distance keeps the build off the clean path.
    setOccLoader(async () => trappingModule())

    await expect(solveLocally(doc(6))).rejects.toBeInstanceOf(KernelFault)
    await expect(solveLocally(doc(6))).rejects.toThrow(/kernel fault: memory access out of bounds/)
    expect(dispose).not.toHaveBeenCalled()
    expect(persistentTableForTest()).toBeNull()
  })

  it('fails when a trapped sketch solver cannot be reloaded', async () => {
    // Headless hosts inject the node bytes once; dropping them on a trap leaves
    // no loader to re-run. The retry must then be a KernelFault, not a build
    // whose sketches silently become feature exceptions.
    setSolveLocalsForTest(async () => oc)
    const trapping = (() => {
      throw new WebAssembly.RuntimeError('unreachable')
    }) as unknown as SolveBytes
    setSketchSolver(trapping)

    await expect(solveLocally(doc(5))).rejects.toThrow(/sketch solver could not be reloaded after a trap/)
    // The latch survives the failed reload: a later call must not fall back to
    // per-sketch exceptions that read as ok.
    await expect(solveLocally(doc(5))).rejects.toThrow(/sketch solver could not be reloaded after a trap/)

    // A real reload clears it and the next build succeeds.
    setSketchSolver(solveBytes)
    setSketchTopology(loadTopology())
    const recovered = await solveLocally(doc(5))
    expect((recovered!.result as Record<string, { status?: string }>).ex1.status).toBe('ok')
  })

  it('treats a topology-builder trap as a fault of the same sketch module', async () => {
    setSolveLocalsForTest(async () => oc)
    setSketchSolver(solveBytes)
    const trapping = (() => {
      throw new WebAssembly.RuntimeError('memory access out of bounds')
    }) as unknown as (input: Uint8Array) => Uint8Array
    setSketchTopology(trapping)

    await expect(solveLocally(doc(5))).rejects.toThrow(/sketch solver could not be reloaded after a trap/)
    setSketchTopology(null)
  })
})
