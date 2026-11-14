// @vitest-environment node
//
// A helical sweep fused into the coaxial cylinder it winds around. The raw
// boolean is fast; the face merge of ShapeUpgrade_UnifySameDomain (the boolean
// clean) spins forever when the helical band meets the cylinder wall, so the
// solve used to hang until the 30 s stall budget killed it. The clean now keeps
// its edge merge but skips the face merge for this geometry (see
// booleanWithDiffMany), so the thread builds.
//
// The profile is a free fixture: this test's subject is the boolean, not the
// sketch, so only the underconstrained warning is filtered.

import { createRequire } from 'node:module'
import { describe, it, expect } from 'vitest'
import type { PartDoc } from '@/types/cad'
import { runHeadless, measureHeadless, selectHeadless, emptyDriveDoc } from '../headlessOps'
import type { ScriptStep } from '../scriptRunner'
import { loadOcc } from '@/kernel/occ/loadOcc'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { loadTopology } from '@/wasm-kernel/loadTopology'
import { setOccLoader } from '@/kernel/solveLocally'
import { setSketchSolver, setSketchTopology } from '@/kernel/features/sketch'
import { nonSketchProblems } from './buildProblems'

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

// Cylinder r4, height 4, from the Front plane so the helix's axis is Z.
const CYLINDER: ScriptStep[] = [
  m({ type: 'add_sketch', featureId: 'sk1', plane: '@builtin_plane_front' }),
  m({ type: 'add_entity', featureId: 'sk1', kind: 'circle', params: [0, 0, 4] }),
  m({ type: 'add_extrude', featureId: 'ex1', sketchQuery: '$sk1', distance: 4, operation: 'new' }),
]

// The thread's axial half-height and radial span, from the practice document:
// 0.001 into the wall (the shared sliver) and 0.499 proud of it.
const PROFILE_HALF_HEIGHT = 0.25
const PROFILE_INNER = 3.999
const PROFILE_OUTER = 4.499

async function buildThreadDoc(): Promise<Awaited<ReturnType<typeof runHeadless>>> {
  const base = await runHeadless({ doc: emptyDriveDoc(), steps: CYLINDER })
  expect(base.ok).toBe(true)
  const faces = (await selectHeadless(base.doc as PartDoc, {
    kind: 'face',
    where: { type: 'cylinderface' },
  }))!.queries
  expect(faces).toHaveLength(1)
  const helix = await runHeadless({
    doc: base.doc as PartDoc,
    steps: [
      m({ type: 'add_helix', featureId: 'hx1', reference: faces[0] }),
      m({ type: 'set_helix_field', featureId: 'hx1', field: 'pitch', value: 2 }),
      m({ type: 'set_helix_field', featureId: 'hx1', field: 'turns', value: 2 }),
      m({ type: 'set_helix_field', featureId: 'hx1', field: 'start_angle', value: 90 }),
      m({ type: 'set_helix_field', featureId: 'hx1', field: 'offset', value: 0 }),
    ],
  })
  expect(helix.ok).toBe(true)
  const curve = helix.curves!.hx1
  expect(curve.radius).toBe(4)
  // The profile plane is Top (x radial, y axial) at the helix start's height.
  // The seed faces -X, so the rectangle's radial span is negative x.
  const start = curve.start
  const sign = start[0] < 0 ? -1 : 1
  return runHeadless({
    doc: helix.doc as PartDoc,
    steps: [
      m({
        type: 'add_plane',
        featureId: 'pl1',
        definition: {
          mode: 'origin_rotation',
          origin: [0, 0, start[2]],
          plane: '@builtin_plane_top',
          rotation_axis: 'z',
          rotation_angle: 0,
        },
      }),
      m({ type: 'add_sketch', featureId: 'sk2', plane: '@pl1' }),
      m({
        type: 'add_rect',
        featureId: 'sk2',
        p0: [sign * PROFILE_INNER, -PROFILE_HALF_HEIGHT],
        p1: [sign * PROFILE_OUTER, PROFILE_HALF_HEIGHT],
      }),
    ],
  })
}

/** Helix arc length over two turns at r4, pitch 2. */
function helixLength(): number {
  return 2 * Math.hypot(2 * Math.PI * 4, 2)
}

/** Wood the thread's inner 0.001 meets inside the cylinder wall. */
function sharedSliver(): number {
  return (PROFILE_OUTER - PROFILE_INNER === 0
    ? 0
    : (4 - PROFILE_INNER) * (2 * PROFILE_HALF_HEIGHT)) * helixLength()
}

describe.skipIf(!ready)('a helical sweep fused into its coaxial cylinder (real OCC)', () => {
  it('the explicit boolean unions the thread and builds one body', async () => {
    const sketched = await buildThreadDoc()
    expect(sketched.ok).toBe(true)
    const swept = await runHeadless({
      doc: sketched.doc as PartDoc,
      steps: [
        m({ type: 'add_sweep', featureId: 'sw1', sketchQuery: '$sk2', pathQuery: '@hx1', operation: 'new' }),
      ],
    })
    expect(swept.ok).toBe(true)
    expect(nonSketchProblems(swept.features)).toEqual([])
    expect(swept.bodies).toEqual(['body_ex1', 'body_sw1'])
    const cylinderVolume = (await measureHeadless(sketched.doc as PartDoc))!.measures.volume
    const bothVolume = (await measureHeadless(swept.doc as PartDoc))!.measures.volume
    const sweepVolume = bothVolume - cylinderVolume
    expect(sweepVolume).toBeGreaterThan(0)

    const union = await runHeadless({
      doc: swept.doc as PartDoc,
      steps: [
        m({
          type: 'add_boolean',
          featureId: 'bo1',
          operation: 'union',
          target: 'body_ex1',
          tools: ['body_sw1'],
        }),
      ],
    })
    expect(nonSketchProblems(union.features)).toEqual([])
    expect(union.ok).toBe(true)
    expect(union.bodies).toEqual(['body_ex1'])
    const unionVolume = (await measureHeadless(union.doc as PartDoc))!.measures.volume
    // The union is the cylinder plus the screw thread minus the sliver the
    // thread shares with the wall: the profile's radial overlap is 0.001 over
    // its 0.5 height, run along the helix.
    const expected = cylinderVolume + sweepVolume - sharedSliver()
    expect(unionVolume).toBeLessThan(bothVolume)
    expect(Math.abs(unionVolume - expected)).toBeLessThan(1e-3 * expected)
  }, 180_000)

  it('an add sweep onto the same cylinder builds instead of stalling', async () => {
    const sketched = await buildThreadDoc()
    expect(sketched.ok).toBe(true)
    const before = (await measureHeadless(sketched.doc as PartDoc))!.measures.volume
    // The same tool as its own body names the material it brings; the add then
    // has to keep exactly that outside the cylinder.
    const separate = await runHeadless({
      doc: sketched.doc as PartDoc,
      steps: [
        m({ type: 'add_sweep', featureId: 'sw1', sketchQuery: '$sk2', pathQuery: '@hx1', operation: 'new' }),
      ],
    })
    expect(separate.ok).toBe(true)
    const both = (await measureHeadless(separate.doc as PartDoc))!.measures.volume
    const sweepVolume = both - before

    const added = await runHeadless({
      doc: sketched.doc as PartDoc,
      steps: [
        m({ type: 'add_sweep', featureId: 'sw1', sketchQuery: '$sk2', pathQuery: '@hx1', operation: 'add' }),
      ],
    })
    expect(nonSketchProblems(added.features)).toEqual([])
    expect(added.ok).toBe(true)
    expect(added.bodies).toEqual(['body_ex1'])
    const after = (await measureHeadless(added.doc as PartDoc))!.measures.volume
    const expected = before + sweepVolume - sharedSliver()
    expect(Math.abs(after - expected)).toBeLessThan(1e-3 * expected)
  }, 180_000)
})
