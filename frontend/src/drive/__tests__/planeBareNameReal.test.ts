// @vitest-environment node
//
// The reported gridfinity and tea_cup failures: a bare builtin name in an
// add_plane definition used to pass the step and throw `plane not found` at the
// solve, and every plane offset from that one cascaded. These run the chain
// through the headless drive, so the boundary and the plane leaf are pinned
// together and a regression cannot hide behind either half.

import { createRequire } from 'node:module'
import { describe, it, expect } from 'vitest'
import type { PartDoc } from '@/types/cad'
import { runHeadless, seedBuiltins } from '../headlessOps'
import { loadOcc } from '@/kernel/occ/loadOcc'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { loadTopology } from '@/wasm-kernel/loadTopology'
import { setOccLoader } from '@/kernel/solveLocally'
import { setSketchSolver, setSketchTopology } from '@/kernel/features/sketch'
import type { ScriptStep } from '../scriptRunner'

function occInstalled(): boolean {
  try {
    createRequire(import.meta.url).resolve('opencascade.js/dist/opencascade.wasm.js')
    return true
  } catch {
    return false
  }
}

const oc = occInstalled()
const solveBytes = loadSolver()
if (oc && solveBytes) {
  setOccLoader(loadOcc)
  setSketchSolver(solveBytes)
  setSketchTopology(loadTopology())
}

const ready = oc && solveBytes

function emptyDoc(): PartDoc {
  return seedBuiltins({ version: 1, kind: 'part', features: [] } as PartDoc)
}

function step(mutation: Record<string, unknown>): ScriptStep {
  return { mutation } as ScriptStep
}

function close(actual: number[] | undefined, expected: number[]): void {
  expect(actual, 'frame vector missing').toBeDefined()
  actual!.forEach((v, i) => expect(v).toBeCloseTo(expected[i], 5))
}

describe.skipIf(!ready)('a bare builtin plane name in add_plane (real OCC)', () => {
  it('carries a sketch and an extrude on an offset from bare Right, matching the builtin ref', async () => {
    const run = await runHeadless({
      doc: emptyDoc(),
      steps: [
        step({ type: 'add_sketch', featureId: 'sk1', plane: 'Front' }),
        step({ type: 'add_rect', featureId: 'sk1', p0: [0, 0], p1: [20, 20] }),
        step({ type: 'add_extrude', featureId: 'ex1', sketchQuery: '$sk1', distance: 4, operation: 'new' }),
        step({
          type: 'add_plane', featureId: 'pl1', label: 'Bare right',
          definition: { mode: 'offset', plane: 'Right', offset: 21 },
        }),
        step({
          type: 'add_plane', featureId: 'pl2', label: 'Explicit right',
          definition: { mode: 'offset', plane: '@builtin_plane_right', offset: 21 },
        }),
        step({ type: 'add_sketch', featureId: 'sk2', label: 'On plane', plane: '@pl1' }),
        step({ type: 'add_rect', featureId: 'sk2', p0: [-4, -4], p1: [4, 4] }),
        step({ type: 'add_extrude', featureId: 'ex2', sketchQuery: '$sk2', distance: 3, operation: 'new' }),
      ],
    })
    expect(run.ok).toBe(true)
    expect(run.features, 'no feature reports an exception').toEqual([])

    const bare = run.frames?.pl1
    const explicit = run.frames?.pl2
    expect(bare, 'the bare-name plane frame is in the reply').toBeDefined()
    expect(explicit, 'the builtin-ref plane frame is in the reply').toBeDefined()
    close(bare!.origin, [21, 0, 0])
    close(bare!.origin, explicit!.origin)
    close(bare!.x_axis, explicit!.x_axis)
    close(bare!.y_axis, explicit!.y_axis)
    close(bare!.normal, explicit!.normal)

    const extrude = run.featureDeltas?.find(row => row.id === 'ex2')
    expect(extrude, 'the boss on the bare-name plane measured').toBeDefined()
    expect(extrude!.volume).toBeGreaterThan(0)
  }, 240_000)

  it('pins an offset from bare Top at 8.5 and builds the extrude on it', async () => {
    const run = await runHeadless({
      doc: emptyDoc(),
      steps: [
        step({
          type: 'add_plane', featureId: 'pl1', label: 'Bare top',
          definition: { mode: 'offset', plane: 'Top', offset: 8.5 },
        }),
        step({ type: 'add_sketch', featureId: 'sk1', plane: '@pl1' }),
        step({ type: 'add_rect', featureId: 'sk1', p0: [-5, -5], p1: [5, 5] }),
        step({ type: 'add_extrude', featureId: 'ex1', sketchQuery: '$sk1', distance: 2, operation: 'new' }),
      ],
    })
    expect(run.ok).toBe(true)
    expect(run.features, 'the tea-cup offset chain solves clean').toEqual([])
    const frame = run.frames?.pl1
    expect(frame, 'the plane frame is in the reply').toBeDefined()
    close(frame!.origin, [0, 8.5, 0])
    close(frame!.normal, [0, 1, 0])
    const extrude = run.featureDeltas?.find(row => row.id === 'ex1')
    expect(extrude, 'the extrude on the bare-name plane measured').toBeDefined()
    expect(extrude!.volume).toBeGreaterThan(0)
  }, 240_000)
})
