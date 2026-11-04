// @vitest-environment node
//
// The many-instance pattern and array solves, with the production 30 s solve
// budget asserted from the feature row rather than left to the vitest timeout.
// These are the recipes from feature/pattern-instance-fuse.md (gear rack,
// circuit-board holes, din rail, MCAD jack, cutter tooth) rebuilt with
// analytic volumes where the original capture's document is not in the repo.
//
// Skips when OCC.js or the sketch solver is absent.

import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from '../../occ/loadOcc'
import { SharedHarness } from '../../occ/sharedHarness'
import { DisposeScope } from '../../occ/disposeScope'
import { volumeOf } from '../../occ/volume'
import { canonicalEdges } from '../../occ/bodyNames'
import { setSketchSolver, setSketchTopology, resetSketchSolver } from '../sketch'
import { setOccLoader } from '../../solveLocally'
import { loadTopology } from '@/wasm-kernel/loadTopology'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { SOLVE_STALL_BUDGET_MS } from '../../solverConstants'
import { emptyDriveDoc, exportHeadless, measureHeadless, runHeadless } from '@/drive/headlessOps'
import type { OccModule, OccShape } from '../../occ/occTypes'
import type { BuildResponse } from '../../builder'
import type { Body } from '../../types3d'
import type { PartDoc } from '@/types/cad'
import type { ScriptStep } from '@/drive/scriptRunner'

const oc = await loadOcc()
const solveBytes = loadSolver()
if (oc && solveBytes) {
  setOccLoader(loadOcc)
  setSketchSolver(solveBytes)
  setSketchTopology(loadTopology())
}

type Dict = Record<string, unknown>

function polySketch(id: string, points: [number, number][], plane = '@builtin_plane_front'): Dict {
  const n = points.length
  const entities: Dict[] = []
  const initial: Record<string, number[]> = {}
  const constraints: Dict[] = []
  for (let i = 0; i < n; i++) {
    const a = points[i]
    const b = points[(i + 1) % n]
    entities.push({ id: `l${i}`, kind: 'line' })
    initial[`l${i}`] = [a[0], a[1], b[0], b[1]]
    constraints.push({
      id: `c${i}`, kind: 'coincident',
      a: { entity: `l${i}`, point: 'end' },
      b: { entity: `l${(i + 1) % n}`, point: 'start' },
    })
    constraints.push({ id: `h${i}`, kind: a[1] === b[1] ? 'horizontal' : 'vertical', target: { entity: `l${i}` } })
  }
  return { id, kind: 'sketch', plane, entities, initial, constraints }
}

function rectSketch(id: string, x0: number, y0: number, w: number, h: number, plane = '@builtin_plane_front'): Dict {
  return polySketch(id, [[x0, y0], [x0 + w, y0], [x0 + w, y0 + h], [x0, y0 + h]], plane)
}

function extrude(id: string, sketch: string, distance: number, operation = 'new'): Dict {
  return { id, kind: 'extrude', extrude: { sketch, distance, direction: 'normal', operation } }
}

function featurePattern(id: string, source: string, fields: Dict): Dict {
  return { id, kind: 'pattern', pattern: { subject: 'feature', source_feature: `@${source}`, ...fields } }
}

function bodyPattern(id: string, source: string, fields: Dict): Dict {
  return { id, kind: 'pattern', pattern: { subject: 'body', source_body: source, ...fields } }
}

const BAR_VOLUME = 100 * 10.875 * 5
const TOOTH_VOLUME = 0.9347568 * 1 * 5

describe.skipIf(!oc || !solveBytes)('many-instance pattern and array solve cost (real OCC)', () => {
  const h = new SharedHarness(oc!)
  const occ = oc as OccModule

  beforeAll(() => {
    if (!oc || !solveBytes) throw new Error('unreachable: skipIf guards this')
    resetSketchSolver()
    setSketchSolver(solveBytes)
  })

  function snapshot(r: BuildResponse, featureId: string): Record<string, Body> {
    return r._build_state!.checkpoints[featureId].body_store_snapshot as Record<string, Body>
  }
  function volumeAt(r: BuildResponse, featureId: string, bodyId: string): number {
    const scope = new DisposeScope()
    try {
      return volumeOf(occ, scope, h.table.get<OccShape>(snapshot(r, featureId)[bodyId].shape!))
    } finally {
      scope.dispose()
    }
  }
  function solveMs(r: BuildResponse, featureId: string): number {
    return Number((h.res(r, featureId) as { solve_ms?: number }).solve_ms)
  }

  // A 100 x 10.875 x 5 bar with a 0.9347568 x 1 x 5 tooth on its top, repeated
  // along +X at the gear-rack pitch. The tooth is the plan's 4.673784 mm3
  // (rectangular here; the capture's 4-line/4-arc tooth is not in the repo).
  function gearRack(count: number): Dict[] {
    return [
      rectSketch('sk_bar', 0, 0, 100, 10.875),
      extrude('ex_bar', '$sk_bar', 5),
      { id: 'pl_top', kind: 'plane', definition: { mode: 'offset', plane: '@builtin_plane_front', offset: 5 } },
      rectSketch('sk_tooth', 1, 4.9, 0.9347568, 1, '@pl_top'),
      extrude('ex_tooth', '$sk_tooth', 5, 'add'),
      featurePattern('pt1', 'ex_tooth', {
        mode: 'linear', count, pitch: 1.570796, direction: [1, 0, 0],
      }),
    ]
  }

  it('63 tooth copies solve inside the 30 s budget and add exactly 63 teeth', () => {
    const r = h.run({ features: gearRack(63) })
    expect(h.res(r, 'pt1').status).toBe('ok')
    expect(solveMs(r, 'pt1')).toBeLessThan(SOLVE_STALL_BUDGET_MS)
    expect(volumeAt(r, 'pt1', 'body_ex_bar')).toBeCloseTo(BAR_VOLUME + 63 * TOOTH_VOLUME, 4)
  }, 120_000)

  it('24 tooth copies keep the exact volume delta', () => {
    const r = h.run({ features: gearRack(24) })
    expect(h.res(r, 'pt1').status).toBe('ok')
    expect(solveMs(r, 'pt1')).toBeLessThan(SOLVE_STALL_BUDGET_MS)
    expect(volumeAt(r, 'pt1', 'body_ex_bar')).toBeCloseTo(BAR_VOLUME + 24 * TOOTH_VOLUME, 4)
  }, 120_000)

  it('13 copies of a four-hole cut row stay inside the budget', () => {
    const holes: Dict[] = [
      rectSketch('sk_plate', 0, 0, 70, 30),
      extrude('ex_plate', '$sk_plate', 3),
    ]
    const entities: Dict[] = []
    const initial: Record<string, number[]> = {}
    const constraints: Dict[] = []
    const ys = [6, 10, 14, 18]
    ys.forEach((y, i) => {
      entities.push({ id: `h${i}`, kind: 'circle' })
      initial[`h${i}`] = [5, y, 1]
      constraints.push({ id: `r${i}`, kind: 'radius', target: { entity: `h${i}` } })
    })
    const features = [
      ...holes,
      { id: 'sk_holes', kind: 'sketch', plane: '@builtin_plane_front', entities, initial, constraints },
      extrude('ex_holes', '$sk_holes', 10, 'cut'),
      featurePattern('pt1', 'ex_holes', {
        mode: 'linear', count: 13, pitch: 5, direction: [1, 0, 0],
      }),
    ]
    const r = h.run({ features })
    expect(h.res(r, 'pt1').status).toBe('ok')
    expect(solveMs(r, 'pt1')).toBeLessThan(SOLVE_STALL_BUDGET_MS)
    expect(volumeAt(r, 'pt1', 'body_ex_plate')).toBeCloseTo(70 * 30 * 3 - 13 * 4 * Math.PI * 3, 4)
  }, 120_000)

  it('a 5 x 5 array of touching bodies fuses inside the budget', () => {
    // 10 mm cubes at pitch 10: every copy shares a face with its neighbour, the
    // touching-copy case that used to time out one union at a time.
    const r = h.run({
      features: [
        rectSketch('sk_jack', 0, 0, 10, 10),
        extrude('ex_jack', '$sk_jack', 10),
        bodyPattern('ar1', 'body_ex_jack', {
          mode: 'rectangular', count_x: 5, count_y: 5, pitch_x: 10, pitch_y: 10,
          direction_x: [1, 0, 0], direction_y: [0, 1, 0], operation: 'add', include_source: true,
        }),
      ],
    })
    expect(h.res(r, 'ar1').status).toBe('ok')
    expect(solveMs(r, 'ar1')).toBeLessThan(SOLVE_STALL_BUDGET_MS)
    expect(volumeAt(r, 'ar1', 'body_ex_jack')).toBeCloseTo(25 * 1000, 4)
  }, 120_000)

  it('a 25-copy circular add array of an overlapping tooth solves inside the budget', () => {
    // A tooth reaching the axis, rotated 25 times: every copy overlaps the
    // centre, so the union is much smaller than the operand sum and this is a
    // real fuse set rather than 25 islands.
    const r = h.run({
      features: [
        rectSketch('sk_tooth', 0, -1, 20, 2),
        extrude('ex_tooth', '$sk_tooth', 2),
        bodyPattern('ar1', 'body_ex_tooth', {
          mode: 'circular', count: 25, step_angle: 14.4,
          axis_origin: [0, 0, 0], axis_direction: [0, 0, 1],
          operation: 'add', include_source: true,
        }),
      ],
    })
    expect(h.res(r, 'ar1').status).toBe('ok')
    expect(solveMs(r, 'ar1')).toBeLessThan(SOLVE_STALL_BUDGET_MS)
    expect((h.res(r, 'ar1').body_ids as string[]).length).toBe(1)
  }, 120_000)

  it('a 39-slot rail cold-builds, keeps its topology, and exports', async () => {
    const features: Dict[] = [
      rectSketch('sk_rail', 0, 0, 1000, 10),
      extrude('ex_rail', '$sk_rail', 5),
      rectSketch('sk_slot', 10, 2, 2, 6),
      extrude('ex_slot', '$sk_slot', 5, 'cut'),
      featurePattern('pt1', 'ex_slot', {
        mode: 'linear', count: 39, pitch: 25, direction: [1, 0, 0],
      }),
    ]
    const r = h.run({ features })
    expect(h.res(r, 'pt1').status).toBe('ok')
    expect(solveMs(r, 'pt1')).toBeLessThan(SOLVE_STALL_BUDGET_MS)
    expect(volumeAt(r, 'pt1', 'body_ex_rail')).toBeCloseTo(50000 - 39 * 2 * 6 * 5, 4)
    const scope = new DisposeScope()
    try {
      const shape = h.table.get<OccShape>(snapshot(r, 'pt1').body_ex_rail.shape!)
      expect(canonicalEdges(occ, scope, shape).length).toBeGreaterThan(300)
    } finally {
      scope.dispose()
    }

    // The production path, from a document with no checkpoint cache: a cold
    // full build plus the export that used to fail after the pattern.
    const m = (mutation: Record<string, unknown>): ScriptStep => ({ mutation } as ScriptStep)
    const setField = (field: string, value: unknown) =>
      m({ type: 'set_pattern_field', featureId: 'pt1', field, value })
    const built = await runHeadless({
      doc: emptyDriveDoc(),
      steps: [
        m({ type: 'add_sketch', featureId: 'sk_rail', plane: '@builtin_plane_front' }),
        m({ type: 'add_rect', featureId: 'sk_rail', p0: [0, 0], p1: [1000, 10] }),
        m({ type: 'add_extrude', featureId: 'ex_rail', sketchQuery: '$sk_rail', distance: 5, operation: 'new' }),
        m({ type: 'add_sketch', featureId: 'sk_slot', plane: '@builtin_plane_front' }),
        m({ type: 'add_rect', featureId: 'sk_slot', p0: [10, 2], p1: [12, 8] }),
        m({ type: 'add_extrude', featureId: 'ex_slot', sketchQuery: '$sk_slot', distance: 5, operation: 'cut' }),
        m({ type: 'add_pattern', featureId: 'pt1', subject: 'feature', mode: 'linear' }),
        setField('source_feature', '@ex_slot'),
        setField('count', 39),
        setField('pitch', 25),
        setField('direction', [1, 0, 0]),
      ],
    })
    expect(built.features).toEqual([])
    const doc = built.doc as PartDoc
    const measured = await measureHeadless(doc)
    expect(measured?.measures.volume).toBeCloseTo(50000 - 39 * 2 * 6 * 5, 3)
    const exported = await exportHeadless(doc, { format: 'step' })
    expect(exported?.ok).toBe(true)
    expect(exported?.bytes?.length ?? 0).toBeGreaterThan(0)
  }, 180_000)
})
