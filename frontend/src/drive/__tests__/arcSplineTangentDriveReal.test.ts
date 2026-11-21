// @vitest-environment node
//
// The profile the mcp-practice vase run could not close: an r50 arc leaving a
// line, a fit spline leaving that arc, and the fit spline's end handle. The
// joint is a coincident at the arc's end and the spline's start plus a tangent;
// the spline's handles are dimensioned (the start one by its length, the end one
// by absolute x/y) so the sketch closes fully constrained and the revolve
// builds. Before the spline tangent row the joint held four free DOF and the
// solve ignored the constraint as an operand-kind drop.
//
// The geometry is rebuilt from the finding text, not from the practice script.
// The run is split into chunks with an event-loop yield between them: each
// solve is synchronous WASM, and one 30-step run starves the harness watchdog.
// Gated like the other real-kernel drive suites.
import { describe, it, expect } from 'vitest'
import type { PartDoc } from '@/types/cad'
import { runHeadless, emptyDriveDoc } from '../headlessOps'
import type { ScriptStep } from '../scriptRunner'
import { yieldToEventLoop } from '@/testing/yieldToEventLoop'
import { loadOcc, occInstalled } from '@/kernel/occ/loadOcc'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { loadTopology } from '@/wasm-kernel/loadTopology'
import { setOccLoader } from '@/kernel/solveLocally'
import { setSketchSolver, setSketchTopology } from '@/kernel/features/sketch'
import { nonSketchProblems } from './buildProblems'

const oc = occInstalled()
const solveBytes = loadSolver()
if (oc && solveBytes) {
  setOccLoader(loadOcc)
  setSketchSolver(solveBytes)
  setSketchTopology(loadTopology())
}
const ready = oc && solveBytes

const dimension = (
  kind: 'point_distance_x' | 'point_distance_y',
  target: string,
  value: number,
): ScriptStep => ({
  mutation: {
    type: 'add_constraint', featureId: 'sk1', kind, targets: ['@builtin_origin', target],
    value, sign: 1,
  },
})

const dimensionPoint = (
  target: string,
  x: number,
  y: number,
): ScriptStep[] => [dimension('point_distance_x', target, x), dimension('point_distance_y', target, y)]

/** The entities and the joint, in the order the practice profile drew them. */
function profileSteps(): ScriptStep[] {
  return [
    { mutation: { type: 'add_sketch', featureId: 'sk1', plane: '@builtin_plane_front' } },
    { mutation: { type: 'add_entity', featureId: 'sk1', kind: 'line', params: [0, 0, 10, 0], entityId: 'base' } },
    { mutation: { type: 'add_entity', featureId: 'sk1', kind: 'arc', params: [10, 50, 50, 270, 0], entityId: 'belly' } },
    {
      mutation: {
        type: 'add_entity', featureId: 'sk1', kind: 'fit_spline',
        params: [60, 50, 65, 55, 70, 52, 75, 45], entityId: 'flank',
      },
    },
    { mutation: { type: 'add_entity', featureId: 'sk1', kind: 'line', params: [75, 45, 0, 0], entityId: 'close' } },
    { mutation: { type: 'add_entity', featureId: 'sk1', kind: 'line', params: [0, 0, 0, 20], entityId: 'axis' } },
    { mutation: { type: 'toggle_construction', targets: ['entity:sk1:axis'] } },

    // The tangent is authored before its coincident: the add-time pair rule
    // keeps it, the solve ignores it until the shared endpoint exists, and the
    // later coincident revives the same document row.
    { mutation: { type: 'add_constraint', featureId: 'sk1', kind: 'tangent', targets: ['entity:sk1:belly', 'entity:sk1:flank'] } },
    { mutation: { type: 'add_constraint', featureId: 'sk1', kind: 'coincident', targets: ['vertex:sk1:belly:end', 'vertex:sk1:flank:start'] } },
  ]
}

/** The fixed skeleton: the base line, the belly arc, and the two handles. */
function skeletonSteps(): ScriptStep[] {
  return [
    { mutation: { type: 'add_constraint', featureId: 'sk1', kind: 'coincident', targets: ['vertex:sk1:base:start', '@builtin_origin'] } },
    { mutation: { type: 'add_constraint', featureId: 'sk1', kind: 'horizontal', targets: ['entity:sk1:base'] } },
    { mutation: { type: 'add_constraint', featureId: 'sk1', kind: 'length', targets: ['entity:sk1:base'], value: 10 } },
    { mutation: { type: 'add_constraint', featureId: 'sk1', kind: 'coincident', targets: ['vertex:sk1:base:end', 'vertex:sk1:belly:start'] } },
    { mutation: { type: 'add_constraint', featureId: 'sk1', kind: 'radius', targets: ['entity:sk1:belly'], value: 50 } },
    { mutation: { type: 'set_fit_spline_handle', featureId: 'sk1', entityId: 'flank', end: 'start', handle: [60, 45] } },
    { mutation: { type: 'set_fit_spline_handle', featureId: 'sk1', entityId: 'flank', end: 'end', handle: [80, 40] } },
  ]
}

function dimensionSteps(): ScriptStep[] {
  return [
    ...dimensionPoint('vertex:sk1:flank:start', 60, 50),
    ...dimensionPoint('vertex:sk1:flank:fit1', 65, 55),
    ...dimensionPoint('vertex:sk1:flank:fit2', 70, 52),
    ...dimensionPoint('vertex:sk1:flank:end', 75, 45),
  ]
}

function closeSteps(): ScriptStep[] {
  return [
    {
      mutation: {
        type: 'add_constraint', featureId: 'sk1', kind: 'point_distance',
        targets: ['vertex:sk1:flank:start', 'vertex:sk1:flank:c1'], value: 5,
      },
    },
    ...dimensionPoint('vertex:sk1:flank:c2', 80, 40),
    { mutation: { type: 'add_constraint', featureId: 'sk1', kind: 'coincident', targets: ['vertex:sk1:close:start', 'vertex:sk1:flank:end'] } },
    { mutation: { type: 'add_constraint', featureId: 'sk1', kind: 'coincident', targets: ['vertex:sk1:close:end', '@builtin_origin'] } },
    { mutation: { type: 'add_constraint', featureId: 'sk1', kind: 'coincident', targets: ['vertex:sk1:axis:start', '@builtin_origin'] } },
    { mutation: { type: 'add_constraint', featureId: 'sk1', kind: 'vertical', targets: ['entity:sk1:axis'] } },
    { mutation: { type: 'add_constraint', featureId: 'sk1', kind: 'length', targets: ['entity:sk1:axis'], value: 20 } },
  ]
}

function revolveSteps(): ScriptStep[] {
  return [
    { mutation: { type: 'add_revolve', featureId: 'rev1', sketchQuery: '$sk1', angle: 90, axis: '@sk1/axis', operation: 'new' } },
  ]
}

describe.skipIf(!ready)('arc to fit-spline tangent through the drive (real OCC + Rust solver)', () => {
  it('closes the vase joint fully constrained and revolves the profile', async () => {
    let doc: PartDoc = emptyDriveDoc()
    let result = await runHeadless({ doc, steps: profileSteps() })
    expect(result.doc).not.toBeNull()
    doc = result.doc!
    await yieldToEventLoop()

    result = await runHeadless({ doc, steps: skeletonSteps() })
    expect(result.doc).not.toBeNull()
    doc = result.doc!
    await yieldToEventLoop()

    result = await runHeadless({ doc, steps: dimensionSteps() })
    expect(result.doc).not.toBeNull()
    doc = result.doc!
    await yieldToEventLoop()

    result = await runHeadless({ doc, steps: closeSteps() })
    expect(result.doc).not.toBeNull()
    doc = result.doc!
    await yieldToEventLoop()

    result = await runHeadless({ doc, steps: revolveSteps(), featureDeltas: 'all' })
    expect(result.ok).toBe(true)
    expect(nonSketchProblems(result.features)).toEqual([])

    const sketchRow = result.featureDeltas?.find(row => row.id === 'sk1')
    expect(sketchRow).toBeDefined()
    expect(sketchRow!.status).toBe('fully_constrained')
    expect(sketchRow!.dof).toBe(0)

    expect(result.bodies).not.toBeNull()
    expect(result.bodies!.length).toBeGreaterThanOrEqual(1)
  }, 180_000)
})
