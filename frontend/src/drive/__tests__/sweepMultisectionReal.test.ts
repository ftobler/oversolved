// @vitest-environment node
//
// The build123d handle as a drive script: the path spline, the two end circles,
// five station planes built from construction lines, and five rounded-rectangle
// sections. Without `multisection` the sweep is refused with the plane message;
// setting the field builds the handle, and undo returns to the refusal.
//
// Real kernel, gated like the other drive suites.

import { createRequire } from 'node:module'
import { describe, it, expect } from 'vitest'
import { runHeadless, emptyDriveDoc } from '../headlessOps'
import { yieldToEventLoop } from '@/testing/yieldToEventLoop'
import type { ScriptStep } from '../scriptRunner'
import type { PartDoc } from '@/types/cad'
import { loadOcc } from '@/kernel/occ/loadOcc'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { loadTopology } from '@/wasm-kernel/loadTopology'
import { setOccLoader } from '@/kernel/solveLocally'
import { setSketchSolver, setSketchTopology } from '@/kernel/features/sketch'

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

const m = (mutation: Record<string, unknown>): ScriptStep => ({ mutation } as ScriptStep)

// Station P and the in-plane normal N, from the plan's section 7 table.
const STATIONS: { p: [number, number]; n: [number, number] }[] = [
  { p: [-10, 0], n: [1, 0] },
  { p: [-8.428892, 3.8503], n: [0.600653, -0.79951] },
  { p: [-4.320748, 4.978977], n: [0.053869, -0.998548] },
  { p: [0, 5], n: [0, 1] },
  { p: [4.320748, 4.978977], n: [-0.053869, -0.998548] },
  { p: [8.428892, 3.8503], n: [-0.600653, -0.79951] },
  { p: [10, 0], n: [-1, 0] },
]

/** A 1.25 x 3 rectangle with 0.2 corner arcs, centred on the sketch origin. */
function roundedRectEntities(sketchId: string): ScriptStep[] {
  const hx = 0.625
  const hy = 1.5
  const r = 0.2
  const lines: [string, number[]][] = [
    ['l1', [-hx + r, -hy, hx - r, -hy]],
    ['l2', [hx, -hy + r, hx, hy - r]],
    ['l3', [hx - r, hy, -hx + r, hy]],
    ['l4', [-hx, hy - r, -hx, -hy + r]],
  ]
  const arcs: [string, number[]][] = [
    ['a1', [hx - r, -hy + r, r, -90, 0]],
    ['a2', [hx - r, hy - r, r, 0, 90]],
    ['a3', [-hx + r, hy - r, r, 90, 180]],
    ['a4', [-hx + r, -hy + r, r, 180, 270]],
  ]
  const out: ScriptStep[] = []
  for (const [id, params] of lines) {
    out.push(m({ type: 'add_entity', featureId: sketchId, kind: 'line', params, entityId: id }))
  }
  for (const [id, params] of arcs) {
    out.push(m({ type: 'add_entity', featureId: sketchId, kind: 'arc', params, entityId: id }))
  }
  return out
}

function handleSteps(): ScriptStep[] {
  const steps: ScriptStep[] = [
    // The spine: two cubic Beziers on the front plane.
    m({ type: 'add_sketch', featureId: 'path', plane: '@builtin_plane_front' }),
    m({
      type: 'add_entity', featureId: 'path', kind: 'spline',
      params: [-10, 0, -10, 5.590169943749474, -5, 5, 0, 5],
    }),
    m({
      type: 'add_entity', featureId: 'path', kind: 'spline',
      params: [0, 5, 5, 5, 10, 5.590169943749474, 10, 0],
    }),
    // The two end circles, r = 1, on the top plane.
    m({ type: 'add_sketch', featureId: 'c0', plane: '@builtin_plane_top' }),
    m({ type: 'add_entity', featureId: 'c0', kind: 'circle', params: [-10, 0, 1] }),
    m({ type: 'add_sketch', featureId: 'c6', plane: '@builtin_plane_top' }),
    m({ type: 'add_entity', featureId: 'c6', kind: 'circle', params: [10, 0, 1] }),
    // One construction line per station, from P along N, to define the planes.
    m({ type: 'add_sketch', featureId: 'cst', plane: '@builtin_plane_front' }),
  ]
  for (let i = 1; i <= 5; i++) {
    const { p, n } = STATIONS[i]
    steps.push(m({
      type: 'add_entity', featureId: 'cst', kind: 'line',
      params: [p[0], p[1], p[0] + n[0], p[1] + n[1]], entityId: 'n' + i,
    }))
  }
  // The station planes: line_angle at 0 degrees puts local x along the line.
  for (let i = 1; i <= 5; i++) {
    steps.push(m({
      type: 'add_plane', featureId: 'pl' + i,
      definition: { mode: 'line_angle', line: `@cst/n${i}`, angle: 0 },
    }))
  }
  // One rounded-rectangle section per station plane.
  for (let i = 1; i <= 5; i++) {
    steps.push(m({ type: 'add_sketch', featureId: 'k' + i, plane: `@pl${i}` }))
    steps.push(...roundedRectEntities('k' + i))
  }
  // The sweep: c0 first, then the five sections, then c6.
  steps.push(m({ type: 'add_sweep', featureId: 'sw', sketchQuery: '$c0', pathQuery: '$path' }))
  for (let i = 1; i <= 5; i++) {
    steps.push(m({ type: 'add_sweep_profile', featureId: 'sw', sketchQuery: `$k${i}` }))
  }
  steps.push(m({ type: 'add_sweep_profile', featureId: 'sw', sketchQuery: '$c6' }))
  return steps
}

const MULTISECTION = m({ type: 'set_sweep_field', featureId: 'sw', field: 'multisection', value: true })

type HeadlessRun = Awaited<ReturnType<typeof runHeadless>>

/**
 * Author the document (everything but the opt-in). It is a separate run so the
 * event-loop watchdog sees a macrotask turn between the authoring solves and
 * the one heavy build: the real kernel is synchronous WASM behind async
 * signatures, so a single run of every step is one long block.
 */
async function author(): Promise<HeadlessRun> {
  const run = await runHeadless({ doc: emptyDriveDoc(), steps: handleSteps() })
  await yieldToEventLoop()
  return run
}

describe.skipIf(!ready)('sweep multisection (real OCC + Rust solver)', () => {
  it('refuses the handle without the opt-in, naming the way out', async () => {
    const run = await author()
    const failed = run.features.find((f) => f.id === 'sw')
    expect(failed).toBeDefined()
    expect(failed?.message).toMatch(/spans two different sketch planes/)
    expect(failed?.message).toMatch(/set multisection to sweep through them as sections/)
  }, 180_000)

  it('builds the handle once the field is set', async () => {
    const base = await author()
    const run = await runHeadless({ doc: base.doc as PartDoc, steps: [MULTISECTION] })
    expect(run.features).toEqual([])
    // The reply already measured the changed feature, so the test does not pay
    // for a second full measurement pass over every checkpoint.
    const swept = run.featureDeltas?.find((row) => row.id === 'sw')
    expect(swept?.volume).toBeDefined()
    // build123d asserts 94.7736; the shipped 7.4 measures 94.7809299.
    expect(Math.abs((swept?.volume ?? 0) - 94.7736)).toBeLessThan(0.05)
  }, 180_000)

  it('undoing the field step returns to the refusal', async () => {
    const base = await author()
    const run = await runHeadless({
      doc: base.doc as PartDoc,
      steps: [MULTISECTION, { command: 'undo' } as ScriptStep],
    })
    const failed = run.features.find((f) => f.id === 'sw')
    expect(failed).toBeDefined()
    expect(failed?.message).toMatch(/spans two different sketch planes/)
  }, 180_000)
})
