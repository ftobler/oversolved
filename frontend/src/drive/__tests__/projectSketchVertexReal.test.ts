// @vitest-environment node
//
// A foreign sketch's vertex is projectable for every point key the entity really
// has. Before this guard the apply-time check accepted an ellipse or spline
// vertex the solve never registered, and refused an arc end the solve did
// register. Each key here is projected as a point and its solved position is
// asserted, so the two sides can only agree by resolving real geometry.
import { describe, it, expect } from 'vitest'
import type { PartDoc, SketchFeature } from '@/types/cad'
import { runHeadless, emptyDriveDoc, type HeadlessRunResult } from '../headlessOps'
import type { ScriptStep } from '../scriptRunner'
import { loadOcc, occInstalled } from '@/kernel/occ/loadOcc'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { loadTopology } from '@/wasm-kernel/loadTopology'
import { setOccLoader } from '@/kernel/solveLocally'
import { setSketchSolver, setSketchTopology } from '@/kernel/features/sketch'

const oc = occInstalled()
const solveBytes = loadSolver()
if (oc && solveBytes) {
  setOccLoader(loadOcc)
  setSketchSolver(solveBytes)
  setSketchTopology(loadTopology())
}
const ready = oc && solveBytes

// [-15, 20, 17, 90, 270]: start (-15, 37), end (-15, 3).
const ARC = [-15, 20, 17, 90, 270]
// On-axis ellipse: major1 (24.5, 40), minor1 (4.5, 48).
const ELLIPSE = [4.5, 40, 20, 8, 0]
// Rotated 30 degrees: major1 (4.5 + 20 cos30, 50), minor2 (8.5, 40 - 8 cos30).
const ROTATED = [4.5, 40, 20, 8, 30]
// Cubic control points at slots 0/1, 2/3, 4/5 and 6/7.
const SPLINE = [0, 0, 10, 20, 20, 20, 30, 0]
// Three fit points, then the start and end handles.
const FIT = [0, 0, 5, 4, 10, 0, 0, -2, 10, 2]

function sourceSketch(): SketchFeature {
  return {
    id: 'sk1', kind: 'sketch', plane: '@builtin_plane_front',
    entities: [
      { id: 'A', kind: 'arc' },
      { id: 'E', kind: 'ellipse' },
      { id: 'R', kind: 'ellipse' },
      { id: 'S', kind: 'spline' },
      { id: 'F', kind: 'fit_spline', handles: 'both' },
    ],
    initial: { A: ARC, E: ELLIPSE, R: ROTATED, S: SPLINE, F: FIT },
    constraints: [],
  }
}

function doc(): PartDoc {
  const built = emptyDriveDoc()
  built.features!.push(
    sourceSketch(),
    { id: 'sk2', kind: 'sketch', plane: '@builtin_plane_front', entities: [], initial: {}, constraints: [] },
    { id: 'pl1', kind: 'plane', definition: { mode: 'offset', plane: '@builtin_plane_right', offset: -15 } },
  )
  return built
}

/** One point projection per named source; the target id is the key's own name. */
function project(featureId: string, entries: Array<[string, string]>): ScriptStep[] {
  return entries.map(([targetId, source]) => ({
    mutation: { type: 'add_projected_entity', featureId, kind: 'point', source, entityId: targetId },
  }))
}

const FRONT_SOURCES: Array<[string, string]> = [
  ['arcEnd', '@sk1/A/end'],
  ['arcStart', '@sk1/A/start'],
  ['ellipseMajor', '@sk1/E/major1'],
  ['ellipseMinor', '@sk1/E/minor1'],
  ['rotatedMajor', '@sk1/R/major1'],
  ['rotatedMinor', '@sk1/R/minor2'],
  ['splineC1', '@sk1/S/c1'],
  ['fitInterior', '@sk1/F/fit1'],
  ['fitHandle', '@sk1/F/c1'],
]

function paramsOf(resultDoc: PartDoc, featureId: string, entityId: string): number[] {
  const feature = resultDoc.features?.find(candidate => candidate.id === featureId)
  if (feature?.kind !== 'sketch') throw new Error(`missing sketch ${featureId}`)
  const params = (feature.initial ?? {})[entityId]
  if (params === undefined) throw new Error(`missing ${featureId}/${entityId}`)
  return params
}

// The fixture source sketch is deliberately free, so its own underconstrained
// warning is not this suite's subject; every other row is a failure here.
function problemsBeyondFreeSource(result: HeadlessRunResult) {
  return result.features.filter(feature => !(feature.id === 'sk1' && feature.status === 'underconstrained'))
}

describe.skipIf(!ready)('a foreign vertex projection resolves every point key (real OCC + Rust solver)', () => {
  it('solves arc, ellipse, spline and fit-spline vertex projections on the same plane', async () => {
    const built = await runHeadless({
      doc: doc(),
      docId: 'project-sketch-vertex-front',
      steps: project('sk2', FRONT_SOURCES),
    })
    expect(built.ok).toBe(true)
    const resultDoc = built.doc as PartDoc
    const expected: Record<string, [number, number]> = {
      arcEnd: [-15, 3],
      arcStart: [-15, 37],
      ellipseMajor: [24.5, 40],
      ellipseMinor: [4.5, 48],
      rotatedMajor: [4.5 + 20 * Math.cos(Math.PI / 6), 50],
      rotatedMinor: [8.5, 40 - 8 * Math.cos(Math.PI / 6)],
      splineC1: [10, 20],
      fitInterior: [5, 4],
      fitHandle: [0, -2],
    }
    for (const [entityId, [x, y]] of Object.entries(expected)) {
      const params = paramsOf(resultDoc, 'sk2', entityId)
      expect(params[0], `${entityId} x`).toBeCloseTo(x, 6)
      expect(params[1], `${entityId} y`).toBeCloseTo(y, 6)
    }
    // A resolved projection leaves no problem row: none is unpositioned.
    expect(problemsBeyondFreeSource(built)).toEqual([])
  }, 180_000)

  it('projects the same arc end onto an offset perpendicular plane', async () => {
    const built = await runHeadless({
      doc: doc(),
      docId: 'project-sketch-vertex-right',
      steps: [
        { mutation: { type: 'add_sketch', featureId: 'sk3', label: 'Offset', plane: '@pl1' } },
        ...project('sk3', [['arcEnd', '@sk1/A/end']]),
      ],
    })
    expect(built.ok).toBe(true)
    // Right-plane x is world -Z and y is world Y, so the Front arc end (-15, 3)
    // lands at (0, 3) whatever the plane's offset along its normal.
    const params = paramsOf(built.doc as PartDoc, 'sk3', 'arcEnd')
    expect(params[0]).toBeCloseTo(0, 6)
    expect(params[1]).toBeCloseTo(3, 6)
    expect(problemsBeyondFreeSource(built)).toEqual([])
  }, 180_000)
})
