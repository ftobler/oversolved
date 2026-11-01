// Always-on partial-profile accounting tests for extrude and revolve (the D1
// report). The profile resolver is replaced with a double so the leaf sees a
// reference set containing one buildable area and one that did not build,
// without needing the area builder to produce an unbuildable face: what is
// under test is the LEAF's accounting and message, not the builder's verdict.
// The geometry it builds is real (OCC), so the volume also proves only the
// buildable area reached the kernel.

import { describe, it, expect, vi, beforeAll } from 'vitest'
import { loadOcc } from '../../occ/loadOcc'
import { SharedHarness } from '../../occ/sharedHarness'
import { setSketchSolver, resetSketchSolver } from '../../features/sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { collectExtrudeLoops } from '../faceProfile'
import { volumeOf } from '../../occ/booleans'
import { DisposeScope } from '../../occ/disposeScope'
import type { BuildResponse } from '../../builder'
import type { OccShape } from '../../occ/occTypes'

const oc = await loadOcc()
const solveBytes = loadSolver()

vi.mock('../faceProfile', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../faceProfile')>()
  return { ...actual, collectExtrudeLoops: vi.fn() }
})

const plane = {
  origin: [0, 0, 0], x_axis: [1, 0, 0], y_axis: [0, 1, 0], normal: [0, 0, 1],
}

/** A square boundary as the area builder hands it over (loop edge dicts). */
function squareLoop(x0: number, y0: number, side: number) {
  const corners = [[x0, y0], [x0 + side, y0], [x0 + side, y0 + side], [x0, y0 + side]]
  return corners.map((p, i) => {
    const q = corners[(i + 1) % corners.length]
    return { id: `e${i}`, kind: 'line', start: p, end: q }
  })
}

/** One resolved profile: the loop(s) the leaf builds, plus the referenced set. */
function resolved(side: number, broken: boolean, x0 = 0) {
  const surfaces: Array<Record<string, unknown>> = [{ boundary: squareLoop(x0, 0, side), query: '?a', buildable: true }]
  if (broken) {
    surfaces.push({ boundary: [], query: '?b', buildable: false, reason: 'gap 6.575e-6 exceeds TOL_LOOP_CLOSURE' })
  }
  return {
    loops: [squareLoop(x0, 0, side)],
    plane,
    sketchId: 'sk1',
    face: null,
    loopDiags: [],
    profileSurfaces: surfaces,
    builtSurfaces: [0],
  }
}

function plateLoop() {
  return squareLoop(0, 0, 40)
}

function extrudeSpec(distance: number, operation: string) {
  return {
    features: [
      { id: 'Origin', kind: 'origin' },
      { id: 'sk1', kind: 'sketch', plane: '@builtin_plane_front', entities: [], initial: {}, constraints: [] },
      {
        id: 'ex1', kind: 'extrude', label: 'Extrude',
        extrude: { sketch: '@sk1', distance, direction: 'normal', operation },
      },
    ],
  }
}

function revolveSpec() {
  return {
    features: [
      { id: 'Origin', kind: 'origin' },
      { id: 'skax', kind: 'sketch', plane: '@builtin_plane_front', entities: [{ id: 'ax', kind: 'line' }], initial: { ax: [0, 0, 0, 1] }, constraints: [] },
      { id: 'sk1', kind: 'sketch', plane: '@builtin_plane_front', entities: [], initial: {}, constraints: [] },
      {
        id: 'rv1', kind: 'revolve', label: 'Revolve',
        revolve: { sketch: '@sk1', angle: 360, axis: '@skax/ax', direction: 'normal', operation: 'new' },
      },
    ],
  }
}

describe.skipIf(!oc || !solveBytes)('partial profile reporting (real OCC)', () => {
  const h = new SharedHarness(oc!)
  beforeAll(() => {
    if (solveBytes) { resetSketchSolver(); setSketchSolver(solveBytes) }
  })

  function builtVolume(result: BuildResponse, featureId: string, bodyId: string): number {
    const cp = result._build_state!.checkpoints[featureId]
    const shape = h.table.get<OccShape>(cp.body_store_snapshot[bodyId].shape!)
    const scope = new DisposeScope()
    try {
      return volumeOf(oc!, scope, shape)
    } finally {
      scope.dispose()
    }
  }

  it('reports one unbuildable area of two and builds only the square', () => {
    vi.mocked(collectExtrudeLoops).mockReturnValueOnce(resolved(20, true) as never)
    const result = h.run(extrudeSpec(2, 'new'))
    const ex = h.res(result, 'ex1')
    expect(ex.status).toBe('partial')
    expect(String(ex.exception)).toContain('extrude: built 1 of 2 profile areas')
    expect(String(ex.exception)).toContain('gap 6.575e-6 exceeds TOL_LOOP_CLOSURE')
    expect(builtVolume(result, 'ex1', 'body_ex1')).toBeCloseTo(20 * 20 * 2, 6)
  })

  it('reports the same for a cut', () => {
    // First call: the plate (a clean single-area reference). Second: the cut.
    vi.mocked(collectExtrudeLoops)
      .mockReturnValueOnce({
        loops: [plateLoop()], plane, sketchId: 'sk1', face: null, loopDiags: [],
        profileSurfaces: [{ boundary: plateLoop(), query: '?p', buildable: true }], builtSurfaces: [0],
      } as never)
      .mockReturnValueOnce(resolved(20, true) as never)
    const result = h.run({
      features: [
        { id: 'Origin', kind: 'origin' },
        { id: 'sk1', kind: 'sketch', plane: '@builtin_plane_front', entities: [], initial: {}, constraints: [] },
        { id: 'plate', kind: 'extrude', label: 'Plate', extrude: { sketch: '@sk1', distance: 2, direction: 'normal', operation: 'new' } },
        { id: 'cut1', kind: 'extrude', label: 'Cut', extrude: { sketch: '@sk1', distance: 2, direction: 'normal', operation: 'cut' } },
      ],
    })
    const cut = h.res(result, 'cut1')
    expect(cut.status).toBe('partial')
    expect(String(cut.exception)).toContain('extrude: built 1 of 2 profile areas')
    // The plate is 40x40x2 and the square removed the 20x20x2 corner region.
    const cutBody = String(h.res(result, 'cut1').body_id)
    expect(builtVolume(result, 'cut1', cutBody)).toBeCloseTo(40 * 40 * 2 - 20 * 20 * 2, 6)
  })

  it('stays ok with no message when every referenced area builds', () => {
    vi.mocked(collectExtrudeLoops).mockReturnValueOnce(resolved(20, false) as never)
    const result = h.run(extrudeSpec(2, 'new'))
    const ex = h.res(result, 'ex1')
    expect(ex.status).toBe('ok')
    expect(ex.exception).toBeUndefined()
  })

  it('reports the same accounting from revolve', () => {
    // Offset from the axis (x = 0) so the profile does not cross it.
    vi.mocked(collectExtrudeLoops).mockReturnValueOnce(resolved(20, true, 10) as never)
    const result = h.run(revolveSpec())
    const rv = h.res(result, 'rv1')
    expect(rv.status).toBe('partial')
    expect(String(rv.exception)).toContain('revolve: built 1 of 2 profile areas')
  })
})
