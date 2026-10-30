// @vitest-environment node
//
// add_part_pattern against the real OCC kernel and the real Rust mate solver:
// a flange with a bolt circle of four bores gets four bolts in one step, each
// seeded on its bore and held by a captured fixed mate.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { loadOcc } from '@/kernel/occ/loadOcc'
import { setSolveLocalsForTest } from '@/kernel/solveLocally'
import { setSketchSolver, resetSketchSolver } from '@/kernel/features/sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { loadPkgNodeExport, PKG_MATE } from '@/wasm-kernel/loadPkgNode'
import type { PartDoc } from '@/types/cad'
import { emptyDriveAssemblyDoc, setMateSolver, type AssemblyScriptStep } from '../headlessAssembly'
import { runAssemblyHeadless } from '../headlessOps'

const oc = await loadOcc()
const solveBytes = loadSolver()
const solveMate = loadPkgNodeExport<(input: Uint8Array) => Uint8Array>('solve_mate_bytes', PKG_MATE)
const describeReal = oc && solveBytes && solveMate ? describe : describe.skip

const BORES: Array<[number, number]> = [[20, 20], [80, 20], [80, 80], [20, 80]]

function sketchOf(id: string, entities: Array<{ id: string; kind: 'line' | 'circle' }>, initial: Record<string, number[]>) {
  return { id, kind: 'sketch' as const, label: id, plane: '@builtin_plane_front', entities, initial }
}

function extrude(sketchId: string, id: string, distance: number, operation: 'new' | 'add' | 'cut' = 'new') {
  return { id, kind: 'extrude', extrude: { sketch: `$${sketchId}`, distance, direction: 'normal', operation } }
}

// A 100 x 100 x 10 plate with four 6 mm bores cut through it.
function flangeDoc(): PartDoc {
  return {
    version: 1, kind: 'part',
    features: [
      sketchOf('sk1', [
        { id: 'bottom', kind: 'line' }, { id: 'right', kind: 'line' },
        { id: 'top', kind: 'line' }, { id: 'left', kind: 'line' },
      ], { bottom: [0, 0, 100, 0], right: [100, 0, 100, 100], top: [100, 100, 0, 100], left: [0, 100, 0, 0] }),
      extrude('sk1', 'ex1', 10),
      sketchOf('sk2', BORES.map((_, i) => ({ id: `c${i}`, kind: 'circle' as const })),
        Object.fromEntries(BORES.map(([x, y], i) => [`c${i}`, [x, y, 6]]))),
      extrude('sk2', 'ex2', 30, 'cut'),
    ],
  } as PartDoc
}

// A cap screw: an 8 mm head over a 16 mm shank, fused into one body.
function boltDoc(): PartDoc {
  return {
    version: 1, kind: 'part',
    features: [
      sketchOf('sk1', [{ id: 'c1', kind: 'circle' }], { c1: [0, 0, 8] }),
      extrude('sk1', 'ex1', 6),
      sketchOf('sk2', [{ id: 'c1', kind: 'circle' }], { c1: [0, 0, 4] }),
      extrude('sk2', 'ex2', 16, 'add'),
    ],
  } as PartDoc
}

const CIRCLE_TOP = {
  kind: 'edge' as const,
  where: { and: [{ type: 'circle' as const }, { extreme: { axis: 'z', side: 'max' as const } }] },
}

describeReal('add_part_pattern with the real kernel', () => {
  beforeAll(() => {
    resetSketchSolver()
    setSketchSolver(solveBytes!)
    setSolveLocalsForTest(async () => oc)
    setMateSolver(solveMate)
  })
  afterAll(() => {
    setMateSolver(null)
    setSolveLocalsForTest(null)
    resetSketchSolver()
  })

  it('places a bolt in every bore of the flange in one step', async () => {
    const steps: AssemblyScriptStep[] = [
      { mutation: { type: 'add_part', handle: 'flange', part: 'flange', fixed: true } },
      { mutation: {
        type: 'add_part_pattern',
        handlePrefix: 'bolt',
        part: 'bolt',
        kind: 'fixed',
        ref_a: { part: 'flange', selector: CIRCLE_TOP },
        ref_b: { selector: CIRCLE_TOP },
        // The shank tip's circle edge points down the shank, the bore's up
        // the bore: contact needs them opposed, or the bolt seeds upside down.
        flip: true,
        capture: true,
      } },
    ]
    const result = await runAssemblyHeadless({
      doc: emptyDriveAssemblyDoc(),
      parts: new Map([['flange', flangeDoc()], ['bolt', boltDoc()]]),
      steps,
    })
    expect(result.ok, JSON.stringify({ steps: result.outcome.steps, parts: result.parts, solve: result.solve })).toBe(true)
    expect(result.mates).toEqual([])
    expect(result.solve.verdict).toBe('fully_constrained')
    expect(result.solve.dof).toBe(0)
    expect(result.outcome.steps[1].createdIds).toHaveLength(2 * BORES.length)

    // Each bolt sits under the plate with its shank tip flush with the top
    // face, centred on a distinct bore.
    const bolts = result.instances.filter(instance => instance.handle.startsWith('bolt'))
    expect(bolts).toHaveLength(BORES.length)
    const centres = bolts.map(bolt => `${bolt.position[0].toFixed(3)},${bolt.position[1].toFixed(3)}`).sort()
    expect(centres).toEqual(BORES.map(([x, y]) => `${x.toFixed(3)},${y.toFixed(3)}`).sort())
    for (const bolt of bolts) expect(bolt.position[2]).toBeCloseTo(-6, 4)
    for (const mate of Object.values(result.mateFrames)) expect(mate.residual).toBeLessThan(1e-6)
    expect(JSON.stringify(result.doc)).not.toContain('selector')
  }, 240_000)
})
