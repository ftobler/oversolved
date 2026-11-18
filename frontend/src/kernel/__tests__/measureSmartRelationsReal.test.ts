// @vitest-environment node
//
// The kernel half of the smart-relation cells against the real kernel: a flat
// face's area, a whole body's volume, and the gap between two coplanar faces.
// The first two are compared with the same GProp reads the measure record uses,
// the third with BRepExtrema's distance, so the test pins the value rather than
// the code path only.
//
// Skips when OCC.js or the Rust sketch solver is absent.
import { beforeAll, describe, expect, it } from 'vitest'
import { loadOcc } from '@/kernel/occ/loadOcc'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { loadTopology } from '@/wasm-kernel/loadTopology'
import { resetSketchSolver, setSketchSolver, setSketchTopology } from '@/kernel/features/sketch'
import {
  measurePicksLocally,
  persistentTableForTest,
  setSolveLocalsForTest,
  solveLocally,
} from '@/kernel/solveLocally'
import { DisposeScope } from '@/kernel/occ/disposeScope'
import { resolveMeasurePick } from '@/kernel/measurePick'
import { minDistance } from '@/kernel/occ/measureExtrema'
import { surfaceAreaOf, volumeForMeasure } from '@/kernel/occ/volume'
import type { OccModule, OccShape } from '@/kernel/occ/occTypes'
import type { PartResult } from '@/types/cad'
import type { BuildState, PartSolid } from '@/kernel/types3d'

const oc = await loadOcc()
const solveBytes = loadSolver()

function rectSketch(id: string, x0: number, w: number, h: number): Record<string, unknown> {
  return {
    id, kind: 'sketch', plane: '@builtin_plane_top',
    entities: [
      { id: 'bottom', kind: 'line' }, { id: 'right', kind: 'line' },
      { id: 'top', kind: 'line' }, { id: 'left', kind: 'line' },
    ],
    initial: {
      bottom: [x0, 0, x0 + w, 0], right: [x0 + w, 0, x0 + w, h],
      top: [x0 + w, h, x0, h], left: [x0, h, x0, 0],
    },
    constraints: [
      { id: 'c1', kind: 'coincident', a: { entity: 'bottom', point: 'end' }, b: { entity: 'right', point: 'start' } },
      { id: 'c2', kind: 'coincident', a: { entity: 'right', point: 'end' }, b: { entity: 'top', point: 'start' } },
      { id: 'c3', kind: 'coincident', a: { entity: 'top', point: 'end' }, b: { entity: 'left', point: 'start' } },
      { id: 'c4', kind: 'coincident', a: { entity: 'left', point: 'end' }, b: { entity: 'bottom', point: 'start' } },
      { id: 'c5', kind: 'horizontal', target: { entity: 'bottom' } },
      { id: 'c6', kind: 'horizontal', target: { entity: 'top' } },
      { id: 'c7', kind: 'vertical', target: { entity: 'right' } },
      { id: 'c8', kind: 'vertical', target: { entity: 'left' } },
      { id: 'c9', kind: 'length', target: { entity: 'bottom' }, value: w },
      { id: 'c10', kind: 'length', target: { entity: 'left' }, value: h },
    ],
  }
}

function holeSketch(): Record<string, unknown> {
  return {
    id: 'skHole', kind: 'sketch', plane: '@builtin_plane_top',
    entities: [{ id: 'hole', kind: 'point' }],
    initial: { hole: [20, 15] },
    constraints: [],
  }
}

/** The probe plate: 40 x 30 x 10 with a d=8 through bore. */
function plateDoc(): Record<string, unknown> {
  return {
    id: 'measure-smart-relations',
    features: [
      rectSketch('sk1', 0, 40, 30),
      { id: 'ex1', kind: 'extrude', extrude: { sketch: '$sk1', distance: 10, direction: 'normal', operation: 'new' } },
      holeSketch(),
      {
        id: 'h1', kind: 'hole',
        hole: { sketch: '@skHole', diameter: 8, depth_mode: 'through_all', direction: 'normal', target: '@body_ex1' },
      },
    ],
  }
}

/** Two 10 x 10 x 10 boxes whose top faces are coplanar (both start on Top). */
function twoBoxDoc(gap: number): Record<string, unknown> {
  return {
    id: 'measure-smart-coplanar',
    features: [
      rectSketch('skA', 0, 10, 10),
      { id: 'exA', kind: 'extrude', extrude: { sketch: '$skA', distance: 10, direction: 'normal', operation: 'new' } },
      rectSketch('skB', 10 + gap, 10, 10),
      { id: 'exB', kind: 'extrude', extrude: { sketch: '$skB', distance: 10, direction: 'normal', operation: 'new' } },
    ],
  }
}

interface Solved {
  bodies: Record<string, PartResult>
  store: Record<string, PartSolid>
}

async function solved(doc: Record<string, unknown>): Promise<Solved> {
  const response = await solveLocally(doc)
  if (!response) throw new Error('no build response')
  const failed = Object.entries(response.result)
    .filter(([, result]) => (result as { status?: string }).status === 'exception')
  if (failed.length) throw new Error(`feature exception: ${JSON.stringify(failed)}`)
  const state = response._build_state as BuildState
  const store = state.checkpoints[state.feature_order[state.feature_order.length - 1]]
    .body_store_snapshot as Record<string, PartSolid>
  return { bodies: response.bodies as Record<string, PartResult>, store }
}

/** The flat face whose normal is `normal`, as the ancestry query a pick uses. */
function faceQuery(part: PartResult, normal: [number, number, number]): string {
  const index = (part.mesh?.face_data ?? []).findIndex((face) =>
    face.surface_type === 'flatface' &&
    Math.abs(face.normal[0] - normal[0]) < 1e-6 &&
    Math.abs(face.normal[1] - normal[1]) < 1e-6 &&
    Math.abs(face.normal[2] - normal[2]) < 1e-6)
  const query = index >= 0 ? part.mesh?.face_queries?.[index] : undefined
  if (!query) throw new Error(`no face with normal ${JSON.stringify(normal)}`)
  return query
}

describe.skipIf(!oc || !solveBytes)('the kernel measure cells over a real build', () => {
  beforeAll(() => {
    if (!oc || !solveBytes) throw new Error('unreachable: skipIf guards this')
    resetSketchSolver()
    setSketchSolver(solveBytes)
    setSketchTopology(loadTopology())
    setSolveLocalsForTest(async () => oc)
  }, 180_000)

  it('reads a whole body volume and its area through the kernel', async () => {
    const occ2 = oc as OccModule
    const doc = plateDoc()
    const { bodies, store } = await solved(doc)
    const partId = Object.keys(store).find((id) => id.startsWith('body_ex'))
    if (!partId) throw new Error(`no extruded body in ${JSON.stringify(Object.keys(store))}`)
    const table = persistentTableForTest()
    if (!table) throw new Error('no handle table')
    const scope = new DisposeScope()
    try {
      const handle = store[partId].shape
      if (handle == null) throw new Error(`no shape for ${partId}`)
      const solid = table.get<OccShape>(handle)
      const volume = volumeForMeasure(occ2, scope, solid)
      const area = surfaceAreaOf(occ2, scope, solid)
      const read = await measurePicksLocally(doc, [`@${partId}`])
      expect(read?.kind).toBe('volume')
      expect(read?.value).toBeCloseTo(volume, 4)
      expect(read?.extra).toEqual([{ kind: 'area', label: 'area', value: expect.closeTo(area, 4) }])
      expect(bodies[partId]).toBeDefined()
    } finally {
      scope.dispose()
    }
  }, 300_000)

  it('reads a flat face area through the kernel', async () => {
    const occ2 = oc as OccModule
    const doc = plateDoc()
    const { bodies, store } = await solved(doc)
    const partId = Object.keys(bodies).find((id) => id.startsWith('body_ex'))
    if (!partId) throw new Error(`no extruded body in ${JSON.stringify(Object.keys(bodies))}`)
    const part = bodies[partId]
    const query = faceQuery(part, [0, -1, 0])
    const table = persistentTableForTest()
    if (!table) throw new Error('no handle table')
    const scope = new DisposeScope()
    try {
      const index = part.mesh?.face_queries?.indexOf(query) ?? -1
      const face = resolveMeasurePick(occ2, scope, table, store, { bodyId: partId, kind: 'face', index })
      expect(face).not.toBeNull()
      const area = surfaceAreaOf(occ2, scope, face as OccShape)
      const read = await measurePicksLocally(doc, [query])
      expect(read?.kind).toBe('area')
      expect(read?.value).toBeCloseTo(area, 4)
      // The plate's cap is 40 x 30 less the d=8 bore.
      expect(read?.value).toBeCloseTo(40 * 30 - Math.PI * 16, 1)
    } finally {
      scope.dispose()
    }
  }, 300_000)

  it('reads two coplanar caps as their real gap, not the infinite-plane 0', async () => {
    const occ2 = oc as OccModule
    const doc = twoBoxDoc(20)
    const { bodies, store } = await solved(doc)
    const ids = Object.keys(bodies).filter((id) => id.startsWith('body_ex'))
    expect(ids).toHaveLength(2)
    const queries = ids.map((id) => faceQuery(bodies[id], [0, -1, 0]))
    const table = persistentTableForTest()
    if (!table) throw new Error('no handle table')
    const scope = new DisposeScope()
    try {
      const shapes = ids.map((id) => {
        const index = bodies[id].mesh?.face_queries?.indexOf(faceQuery(bodies[id], [0, -1, 0])) ?? -1
        return resolveMeasurePick(occ2, scope, table, store, { bodyId: id, kind: 'face', index }) as OccShape
      })
      const direct = minDistance(occ2, shapes[0], shapes[1])
      expect(direct).not.toBeNull()
      const read = await measurePicksLocally(doc, queries)
      expect(read?.kind).toBe('distance')
      expect(read?.value).toBeCloseTo(direct!.value, 6)
      expect(read?.value).toBeCloseTo(20, 6)
    } finally {
      scope.dispose()
    }
  }, 300_000)
})
