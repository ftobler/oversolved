// @vitest-environment node
//
// The heat exchanger shape in miniature through the headless drive: a plate
// with one seed tube on a pitch circle, a hole on the tube's projected centre,
// and one circular pattern of both sources. The volume must match the older
// recipe that redrew the bores as circles in a single cut sketch, which is what
// the hole-as-source rule replaces.
//
// Skips when OCC.js or the sketch solver is absent.

import { describe, it, expect } from 'vitest'
import type { PartDoc, PartFeature } from '@/types/cad'
import { runHeadless, measureHeadless, seedBuiltins, selectHeadless } from '../headlessOps'
import { loadOcc, occInstalled } from '@/kernel/occ/loadOcc'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { loadTopology } from '@/wasm-kernel/loadTopology'
import { setOccLoader } from '@/kernel/solveLocally'
import { setSketchSolver, setSketchTopology } from '@/kernel/features/sketch'
import type { ScriptStep } from '../scriptRunner'

const oc = occInstalled()
const solveBytes = loadSolver()
if (oc && solveBytes) {
  setOccLoader(loadOcc)
  setSketchSolver(solveBytes)
  setSketchTopology(loadTopology())
}
const ready = oc && solveBytes
const step = (mutation: Record<string, unknown>): ScriptStep => ({ mutation } as ScriptStep)

function rectSketch(id: string, w: number, h: number, x0 = 0, y0 = 0): PartFeature {
  const points: [number, number][] = [[x0, y0], [x0 + w, y0], [x0 + w, y0 + h], [x0, y0 + h]]
  const entities = points.map((_, i) => ({ id: `l${i}`, kind: 'line' }))
  const initial: Record<string, number[]> = {}
  const constraints: Record<string, unknown>[] = []
  points.forEach((a, i) => {
    const b = points[(i + 1) % points.length]
    initial[`l${i}`] = [a[0], a[1], b[0], b[1]]
    constraints.push({
      id: `c${i}`, kind: 'coincident',
      a: { entity: `l${i}`, point: 'end' },
      b: { entity: `l${(i + 1) % points.length}`, point: 'start' },
    })
    constraints.push({ id: `h${i}`, kind: a[1] === b[1] ? 'horizontal' : 'vertical', target: { entity: `l${i}` } })
  })
  return { id, kind: 'sketch', plane: '@builtin_plane_front', entities, initial, constraints } as unknown as PartFeature
}

/** A circle sketch at (cx, cy); its underconstraint is not this test's subject. */
function circleSketch(id: string, cx: number, cy: number, r: number, plane: string): PartFeature {
  return {
    id, kind: 'sketch', plane,
    entities: [{ id: 'c1', kind: 'circle' }],
    initial: { c1: [cx, cy, r] },
    constraints: [{ id: 'r1', kind: 'radius', target: { entity: 'c1' } }],
  } as unknown as PartFeature
}

const BORE_RADIUS = 1.5
const TUBE_RADIUS = 3
const TUBE_HEIGHT = 10
const PLATE_THICKNESS = 5
const PLATE_SIZE = 60
const PITCH_RADIUS = 25

/** Plate, a plane on its top, and one seed tube standing on it. */
function seededPlate(): PartDoc {
  return seedBuiltins({
    version: 1,
    kind: 'part',
    features: [
      rectSketch('sk_plate', PLATE_SIZE, PLATE_SIZE, -PLATE_SIZE / 2, -PLATE_SIZE / 2),
      { id: 'ex_plate', kind: 'extrude', extrude: { sketch: '@sk_plate', distance: PLATE_THICKNESS, direction: 'normal', operation: 'new' } },
      { id: 'pl_top', kind: 'plane', definition: { mode: 'offset', plane: '@builtin_plane_front', offset: PLATE_THICKNESS } },
      circleSketch('sk_tube', PITCH_RADIUS, 0, TUBE_RADIUS, '@pl_top'),
      { id: 'ex_tube', kind: 'extrude', extrude: { sketch: '@sk_tube', distance: TUBE_HEIGHT, direction: 'normal', operation: 'add' } },
    ],
  } as PartDoc)
}

const TUBE_TOP = {
  kind: 'face' as const,
  where: {
    and: [{ type: 'flatface' as const }, { parallel: [0, 0, 1] }, { extreme: { axis: [0, 0, 1], side: 'max' as const } }],
  },
}

describe.skipIf(!ready)('a hole as a pattern source through the drive (real OCC + Rust solver)', () => {
  it('builds the 6x tube ring with one patterned hole source', async () => {
    const base = seededPlate()
    const topFace = (await selectHeadless(base, TUBE_TOP))!.queries[0]
    const patterned = await runHeadless({
      doc: base,
      steps: [
        step({ type: 'add_sketch', featureId: 'sk_bore', label: 'Bore site', plane: topFace }),
        step({
          type: 'add_projected_entity', featureId: 'sk_bore', kind: 'point',
          source: '@sk_tube/c1/center', entityId: 'p1',
        }),
        step({
          type: 'add_hole', featureId: 'h_bore', label: 'Tube bore', sketch: 'entity:sk_bore:p1',
          diameter: 2 * BORE_RADIUS, depth_mode: 'through_all', direction: 'reverse',
        }),
        step({
          type: 'add_circular_pattern', featureId: 'pt1', label: 'Tube ring', subject: 'feature',
          source_features: ['@ex_tube', '@h_bore'], count: 6,
          axis_origin: [0, 0, 0], axis_direction: [0, 0, 1],
        }),
      ],
    })
    expect(patterned.ok).toBe(true)
    expect(patterned.features.find((problem) => problem.id === 'pt1')).toBeUndefined()
    expect(patterned.doc?.features?.find((feature) => feature.id === 'pt1')).toMatchObject({
      kind: 'circular_pattern',
      circular_pattern: { subject: 'feature', source_features: ['@ex_tube', '@h_bore'], count: 6 },
    })
    const measured = await measureHeadless(patterned.doc!)
    expect(measured?.ok).toBe(true)
    expect(measured!.features.find((problem) => problem.id === 'pt1')).toBeUndefined()
    expect(measured!.measures.bodies).toBe(1)

    // The same part with the bores drawn as circles and cut in one extrude:
    // six tube sketches and extrudes written out, then the six-circle cut.
    const ring = Array.from({ length: 6 }, (_, i) => {
      const angle = (i * Math.PI) / 3
      return [PITCH_RADIUS * Math.cos(angle), PITCH_RADIUS * Math.sin(angle)] as [number, number]
    })
    const cutDoc = seedBuiltins({
      version: 1,
      kind: 'part',
      features: [
        rectSketch('sk_plate', PLATE_SIZE, PLATE_SIZE, -PLATE_SIZE / 2, -PLATE_SIZE / 2),
        { id: 'ex_plate', kind: 'extrude', extrude: { sketch: '@sk_plate', distance: PLATE_THICKNESS, direction: 'normal', operation: 'new' } },
        { id: 'pl_top', kind: 'plane', definition: { mode: 'offset', plane: '@builtin_plane_front', offset: PLATE_THICKNESS } },
        ...ring.flatMap(([x, y], i) => [
          circleSketch(`sk_tube_${i}`, x, y, TUBE_RADIUS, '@pl_top'),
          { id: `ex_tube_${i}`, kind: 'extrude', extrude: { sketch: `@sk_tube_${i}`, distance: TUBE_HEIGHT, direction: 'normal', operation: 'add' } },
        ]),
        { id: 'pl_ring_top', kind: 'plane', definition: { mode: 'offset', plane: '@builtin_plane_front', offset: PLATE_THICKNESS + TUBE_HEIGHT } },
        {
          id: 'sk_circles', kind: 'sketch', plane: '@pl_ring_top',
          entities: ring.map((_, i) => ({ id: `c${i}`, kind: 'circle' })),
          initial: Object.fromEntries(ring.map(([x, y], i) => [`c${i}`, [x, y, BORE_RADIUS]])),
          constraints: ring.map((_, i) => ({ id: `r${i}`, kind: 'radius', target: { entity: `c${i}` }, value: BORE_RADIUS })),
        },
      ],
    } as PartDoc)
    const cut = await runHeadless({
      doc: cutDoc,
      steps: [step({
        type: 'add_extrude', featureId: 'ex_bores', label: 'Bores', sketchQuery: '@sk_circles',
        termination: 'through_all', direction: 'reverse', operation: 'cut',
      })],
    })
    expect(cut.ok, cut.outcome.steps.map((entry) => entry.error?.message).join('; ')).toBe(true)
    const cutMeasured = await measureHeadless(cut.doc!)
    expect(cutMeasured?.ok).toBe(true)
    expect(measured!.measures.volume).toBeCloseTo(cutMeasured!.measures.volume, 4)

    // 60 x 60 x 5 plate plus six r3 x 10 tubes minus six r1.5 bores through the
    // 15 mm of material each one meets.
    const expected = PLATE_SIZE * PLATE_SIZE * PLATE_THICKNESS
      + 6 * Math.PI * TUBE_RADIUS * TUBE_RADIUS * TUBE_HEIGHT
      - 6 * Math.PI * BORE_RADIUS * BORE_RADIUS * (PLATE_THICKNESS + TUBE_HEIGHT)
    expect(measured!.measures.volume).toBeCloseTo(expected, 3)
  }, 300_000)
})
