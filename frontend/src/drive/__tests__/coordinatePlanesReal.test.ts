// @vitest-environment node
//
// The Ex013/Ex015 chain through the headless drive: a `select` kind "vertex"
// corner pick (the three-extreme idiom) feeding an `add_plane` origin_rotation
// origin, and the tilted plane carrying a sketch and an extrude. The kernel
// refusals (unresolvable origin, half a rotation pair) must reach the reply as
// feature exceptions, not as silent zero frames.

import { createRequire } from 'node:module'
import { describe, it, expect } from 'vitest'
import type { PartDoc } from '@/types/cad'
import { runHeadless, selectHeadless, seedBuiltins } from '../headlessOps'
import type { VertexGeometry } from '@/kernel/select'
import { MUTATION_EXAMPLES } from '../mutationExamples'
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
const SIN60 = Math.sin(Math.PI / 3)
const COS60 = Math.cos(Math.PI / 3)

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

// The box example is 40 x 30 on Top extruded 10 along +Y, so its corner at
// max x, max y and max z is [40, 10, 0] (the rectangle runs [0,0] to [40,30]
// and the Top plane's y is world -Z).
const CORNER = [40, 10, 0]
const CORNER_SELECTOR = {
  kind: 'vertex',
  where: {
    and: [
      { extreme: { axis: [1, 0, 0], side: 'max' } },
      { extreme: { axis: [0, 1, 0], side: 'max' } },
      { extreme: { axis: [0, 0, 1], side: 'max' } },
    ],
  },
}

async function boxDoc(): Promise<PartDoc> {
  const box = MUTATION_EXAMPLES.find(entry => entry.name === 'box')!
  const built = await runHeadless({ doc: emptyDoc(), steps: box.steps })
  expect(built.ok).toBe(true)
  return built.doc!
}

describe.skipIf(!ready)('vertex picks and origin_rotation planes through the headless drive (real OCC)', () => {
  it('pins the Ex013 corner idiom to one vertex at the known point', async () => {
    const base = await boxDoc()
    const picked = await selectHeadless(base, CORNER_SELECTOR)
    expect(picked).not.toBeNull()
    expect(picked!.queries).toHaveLength(1)
    const corner = picked!.items[0].geometry
    expect(corner.kind).toBe('vertex')
    close((corner as VertexGeometry).point, CORNER)  // EdgeGeometry.kind is `string`, so the union needs the cast
  }, 240_000)

  it('puts an origin_rotation plane on that vertex query and reports the frame', async () => {
    const base = await boxDoc()
    const picked = await selectHeadless(base, CORNER_SELECTOR)
    const run = await runHeadless({
      doc: structuredClone(base),
      steps: [step({
        type: 'add_plane', featureId: 'pl1', label: 'Corner plane',
        definition: { mode: 'origin_rotation', origin: picked!.queries[0], rotation_axis: 'z', rotation_angle: 90 },
      })],
    })
    expect(run.ok).toBe(true)
    expect(run.features).toEqual([])
    const frame = run.frames?.pl1
    expect(frame, 'the plane frame is in the reply').toBeDefined()
    close(frame!.origin, CORNER)
    // The parent world XY axes swung 90 degrees about +Z.
    close(frame!.x_axis, [0, 1, 0])
    close(frame!.y_axis, [-1, 0, 0])
    close(frame!.normal, [0, 0, 1])
  }, 240_000)

  it('carries a sketch and an extrude on the Ex015 tilt (60 degrees about world X)', async () => {
    const base = await boxDoc()
    const run = await runHeadless({
      doc: structuredClone(base),
      steps: [
        step({
          type: 'add_plane', featureId: 'pl2', label: 'Tilt',
          definition: { mode: 'origin_rotation', origin: [20, 10, -15], rotation_axis: 'x', rotation_angle: 60 },
        }),
        step({ type: 'add_sketch', featureId: 'sk2', label: 'On tilt', plane: '@pl2' }),
        step({ type: 'add_rect', featureId: 'sk2', p0: [0, -4], p1: [4, 0] }),
        step({ type: 'add_extrude', featureId: 'ex2', label: 'Tilted boss', sketchQuery: '$sk2', distance: 2 }),
      ],
    })
    expect(run.ok).toBe(true)
    expect(run.features, 'the tilted chain solves clean').toEqual([])
    const frame = run.frames?.sk2
    expect(frame, 'the sketch frame is in the reply').toBeDefined()
    close(frame!.origin, [20, 10, -15])
    close(frame!.x_axis, [1, 0, 0])
    close(frame!.y_axis, [0, COS60, SIN60])
    close(frame!.normal, [0, -SIN60, COS60])
    const extrude = run.featureDeltas?.find(row => row.id === 'ex2')
    expect(extrude, 'the extrude measured').toBeDefined()
    expect(extrude!.volume).toBeGreaterThan(0)
  }, 240_000)

  it('evaluates an expression rotation_angle at the solve, like the other plane numerics', async () => {
    const run = await runHeadless({
      doc: structuredClone(await boxDoc()),
      steps: [
        step({ type: 'add_variable', featureId: 'tilt', label: 'tilt' }),
        step({ type: 'set_variable_field', featureId: 'tilt', field: 'expression', value: '30 * 2' }),
        step({
          type: 'add_plane', featureId: 'pl3', label: 'Named tilt',
          definition: { mode: 'origin_rotation', origin: [0, 0, 0], rotation_axis: 'z', rotation_angle: 'tilt' },
        }),
      ],
    })
    expect(run.ok).toBe(true)
    expect(run.features, 'the expression angle solves clean').toEqual([])
    const frame = run.frames?.pl3
    expect(frame, 'the plane frame is in the reply').toBeDefined()
    // tilt = 60 degrees about +Z swings the world XY axes; the frame could only
    // carry this angle if the variable expression was evaluated before the leaf.
    close(frame!.x_axis, [0.5, SIN60, 0])
    close(frame!.y_axis, [-SIN60, 0.5, 0])
    close(frame!.normal, [0, 0, 1])
  }, 240_000)

  it('names the kernel refusals as feature exceptions in the reply', async () => {
    const badOrigin = await runHeadless({
      doc: structuredClone(await boxDoc()),
      steps: [step({
        type: 'add_plane', featureId: 'pl1',
        definition: { mode: 'origin_rotation', origin: '@nope', rotation_axis: 'z', rotation_angle: 45 },
      })],
    })
    expect(badOrigin.features[0]).toMatchObject({ id: 'pl1', kind: 'plane', status: 'exception' })
    expect(badOrigin.features[0].message).toContain('origin not found: "@nope"')
    expect(badOrigin.frames?.pl1).toBeUndefined()

    const halfPair = await runHeadless({
      doc: structuredClone(await boxDoc()),
      steps: [step({
        type: 'add_plane', featureId: 'pl1',
        definition: { mode: 'origin_rotation', origin: [0, 0, 0], rotation_angle: 45 },
      })],
    })
    expect(halfPair.features[0].message).toContain('rotation_angle needs rotation_axis')
  }, 240_000)
})
