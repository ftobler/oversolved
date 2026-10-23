// @vitest-environment node
//
// Regression for the MCP practice loop-classification findings. Three reports
// share the path from a sketch's region model to the OCC profile:
//
//   cast_bearing F3: two overlapping circles in one sketch extruded to ONE LOBE
//                    (the lens) instead of the union, with no warning. The
//                    crescents were nested as holes of the lens by the 1-sample
//                    chord containment.
//   key_cap F3:      two overlapping rectangles (a plus) extruded with `add`
//                    threw a raw "Expected null or instance of TopoDS_Face"
//                    from the re-prismed merged cap, which was a shape copy.
//   key_cap F2:      a circle with two crossing inner rects cut as an unsound
//                    solid (BRepCheck_Analyzer): the five plus regions reached
//                    OCC as five touching hole wires.
//
// The fixes live in profileLoops.classifyLoops (fine containment sampling, and
// dissolving adjacent holes into one wire) and in canonicalizeFaceCircles
// (return a TopoDS_Face). The Rust areas themselves are correct: the tests in
// sketch-solver/src/topology/dcel/tests.rs pin that partition.

import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from '../../occ/loadOcc'
import { SharedHarness } from '../../occ/sharedHarness'
import { setSketchSolver, resetSketchSolver } from '../../features/sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { DisposeScope } from '../../occ/disposeScope'
import { volumeOf } from '../../occ/booleans'
import { canonicalFaces } from '../../occ/bodyNames'
import type { OccShape } from '../../occ/occTypes'
import type { BuildResponse } from '../../builder'

const oc = await loadOcc()
const solveBytes = loadSolver()

function rect(id: string, x0: number, y0: number, x1: number, y1: number) {
  return {
    lines: ['a', 'b', 'c', 'd'].map((s) => ({ id: id + s, kind: 'line' })),
    initial: {
      [id + 'a']: [x0, y0, x1, y0],
      [id + 'b']: [x1, y0, x1, y1],
      [id + 'c']: [x1, y1, x0, y1],
      [id + 'd']: [x0, y1, x0, y0],
    } as Record<string, number[]>,
  }
}

function sketchOf(
  id: string,
  plane: string,
  rects: ReturnType<typeof rect>[],
  circles: { id: string; at: number[] }[] = [],
) {
  const entities: Record<string, unknown>[] = []
  const initial: Record<string, number[]> = {}
  for (const r of rects) {
    entities.push(...r.lines)
    Object.assign(initial, r.initial)
  }
  for (const c of circles) {
    entities.push({ id: c.id, kind: 'circle' })
    initial[c.id] = c.at
  }
  return { id, kind: 'sketch', plane, entities, initial, constraints: [] }
}

// The key-cap cut tool: a r4 circle with a plus of two crossing rects inside it.
function keyCapPocketSketch() {
  return sketchOf(
    'sk2',
    '@builtin_plane_top',
    [rect('h', -3, -1, 3, 1), rect('v', -1, -3, 1, 3)],
    [{ id: 'circ', at: [0, 0, 4] }],
  )
}

const LENS = 2 * 100 * Math.acos(0.4) - 4 * Math.sqrt(400 - 64)
const CIRCLE_UNION = 2 * Math.PI * 100 - LENS
const PLUS_AREA = 2 * 4.1 * 1.17 - 1.17 * 1.17
const DISK_MINUS_PLUS = Math.PI * 16 - 20

describe.skipIf(!oc || !solveBytes)('extrude with overlapping sketch loops (real OCC + Rust solver)', () => {
  const h = new SharedHarness(oc!)

  beforeAll(() => {
    if (solveBytes) { resetSketchSolver(); setSketchSolver(solveBytes) }
  })

  function gauges(result: BuildResponse, featureId: string, bodyId: string) {
    const cp = result._build_state!.checkpoints[featureId]
    expect(cp, `no checkpoint for ${featureId}`).toBeDefined()
    const shape = h.table.get<OccShape>(cp.body_store_snapshot[bodyId].shape!)
    const scope = new DisposeScope()
    try {
      return {
        volume: volumeOf(oc!, scope, shape),
        faces: canonicalFaces(oc!, scope, shape).length,
        valid: scope.track(new oc!.BRepCheck_Analyzer(shape, true)).IsValid_2(),
      }
    } finally {
      scope.dispose()
    }
  }

  it('cast_bearing F3: two overlapping circles extrude their union', () => {
    const result = h.run({
      features: [
        { id: 'Origin', kind: 'origin' },
        { id: 'Top', kind: 'plane', visible: false },
        sketchOf('osk', '@builtin_plane_top', [], [
          { id: 'oc1', at: [0, 0, 10] },
          { id: 'oc2', at: [8, 0, 10] },
        ]),
        {
          id: 'oex', kind: 'extrude',
          extrude: { sketch: ['$osk'], distance: 5, direction: 'normal' },
        },
      ],
    })
    expect(h.res(result, 'oex').status).toBe('ok')
    expect(Object.keys(result.bodies as Record<string, unknown>)).toEqual(['body_oex'])
    const g = gauges(result, 'oex', 'body_oex')
    expect(g.volume).toBeCloseTo(CIRCLE_UNION * 5, 2)
    // Two caps and the two outer arcs' walls: the stadium, not a lobe.
    expect(g.faces).toBe(4)
    expect(g.valid).toBe(true)
  })

  it('key_cap F3: two crossing rectangles extrude the plus, not a TopoDS error', () => {
    const result = h.run({
      features: [
        { id: 'Origin', kind: 'origin' },
        { id: 'Top', kind: 'plane', visible: false },
        sketchOf('sk2', '@builtin_plane_top', [
          rect('h', -2.05, -0.585, 2.05, 0.585),
          rect('v', -0.585, -2.05, 0.585, 2.05),
        ]),
        {
          id: 'ex2', kind: 'extrude',
          extrude: { sketch: ['$sk2'], distance: 3.6, direction: 'normal', operation: 'add' },
        },
      ],
    })
    expect(h.res(result, 'ex2').status).toBe('ok')
    expect(Object.keys(result.bodies as Record<string, unknown>)).toEqual(['body_ex2'])
    const g = gauges(result, 'ex2', 'body_ex2')
    expect(g.volume).toBeCloseTo(PLUS_AREA * 3.6, 2)
    expect(g.valid).toBe(true)
  })

  it('key_cap F2: crossing inner loops cut a sound pocket with a plus island', () => {
    const result = h.run({
      features: [
        { id: 'Origin', kind: 'origin' },
        { id: 'Top', kind: 'plane', visible: false },
        sketchOf('sk1', '@builtin_plane_top', [rect('box', -10, -10, 10, 10)]),
        { id: 'ex1', kind: 'extrude', extrude: { sketch: ['$sk1'], distance: 10, direction: 'normal' } },
        keyCapPocketSketch(),
        {
          id: 'ex2', kind: 'extrude',
          extrude: { sketch: ['$sk2'], distance: 5, direction: 'normal', operation: 'cut' },
        },
      ],
    })
    expect(h.res(result, 'ex2').status).toBe('ok')
    const g = gauges(result, 'ex2', 'body_ex1')
    // The tool is the disk minus the plus (the pocket), so the box keeps the
    // plus as an island.
    expect(g.volume).toBeCloseTo(4000 - DISK_MINUS_PLUS * 5, 2)
    expect(g.valid).toBe(true)
  })

  it('the crossing-loop tool itself is a sound solid', () => {
    // The cut above consumes this prism; an invalid tool is what made the
    // boolean refuse. Pin the tool independently so a regression names the
    // profile build rather than the cut.
    const result = h.run({
      features: [
        { id: 'Origin', kind: 'origin' },
        { id: 'Top', kind: 'plane', visible: false },
        keyCapPocketSketch(),
        {
          id: 'exn', kind: 'extrude',
          extrude: { sketch: ['$sk2'], distance: 5, direction: 'normal', operation: 'new' },
        },
      ],
    })
    expect(h.res(result, 'exn').status).toBe('ok')
    const g = gauges(result, 'exn', 'body_exn')
    expect(g.volume).toBeCloseTo(DISK_MINUS_PLUS * 5, 2)
    expect(g.faces).toBe(15)
    expect(g.valid).toBe(true)
  })

  it('a single inner rect still cuts a plain pocket', () => {
    // The report's control: one inner loop is a clean bore, and must keep
    // cutting after adjacent holes start to dissolve.
    const result = h.run({
      features: [
        { id: 'Origin', kind: 'origin' },
        { id: 'Top', kind: 'plane', visible: false },
        sketchOf('sk1', '@builtin_plane_top', [rect('box', -10, -10, 10, 10)]),
        { id: 'ex1', kind: 'extrude', extrude: { sketch: ['$sk1'], distance: 10, direction: 'normal' } },
        sketchOf('sk3', '@builtin_plane_top', [], [{ id: 'circ', at: [0, 0, 4] }]),
        {
          id: 'ex3', kind: 'extrude',
          extrude: { sketch: ['$sk3'], distance: 5, direction: 'normal', operation: 'cut' },
        },
      ],
    })
    expect(h.res(result, 'ex3').status).toBe('ok')
    const g = gauges(result, 'ex3', 'body_ex1')
    expect(g.volume).toBeCloseTo(4000 - Math.PI * 16 * 5, 2)
    expect(g.valid).toBe(true)
  })
})
