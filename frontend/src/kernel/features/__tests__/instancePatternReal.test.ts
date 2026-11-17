// @vitest-environment node
//
// The instance pattern through the real kernel: a source copied onto a sketch's
// points and onto picked faces, under both orientations. The placement law is
// pinned pure in instancePatternPlacement.test.ts; here the copies are measured
// and their construction names compared, so a law that reads right and places
// wrong still fails.
//
// Skips when OCC.js or the sketch solver is absent.

import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from '../../occ/loadOcc'
import { SharedHarness } from '../../occ/sharedHarness'
import { DisposeScope } from '../../occ/disposeScope'
import { setSketchSolver, resetSketchSolver } from '../sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { applyAddPatternSource } from '@/utils/yamlMutations'
import type { PartDoc } from '@/types/cad'
import { shapeBndBox } from '../../occ/primitives'
import { volumeOf } from '../../occ/volume'
import type { OccModule, OccShape } from '../../occ/occTypes'
import type { BuildResponse } from '../../builder'
import type { Body } from '../../types3d'

const oc = await loadOcc()
const solveBytes = loadSolver()

type Dict = Record<string, unknown>

const FRONT = '@builtin_plane_front'

/** A closed rectangle at (x0, y0) on the front plane, extruded upwards. */
function rectSketch(id: string, w: number, h: number, x0 = 0, y0 = 0): Dict {
  const points: [number, number][] = [[x0, y0], [x0 + w, y0], [x0 + w, y0 + h], [x0, y0 + h]]
  const entities = points.map((_, i) => ({ id: `l${i}`, kind: 'line' }))
  const initial: Record<string, number[]> = {}
  const constraints: Dict[] = []
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
  return { id, kind: 'sketch', plane: FRONT, entities, initial, constraints }
}

/** A sketch of points only, in the authored order: the instance target list. */
function pointSketch(id: string, points: [number, number][], construction: number[] = [], plane = FRONT): Dict {
  const entities = points.map((_, i) => ({
    id: `p${i}`, kind: 'point', ...(construction.includes(i) ? { construction: true } : {}),
  }))
  return {
    id, kind: 'sketch', plane, entities,
    initial: Object.fromEntries(points.map(([x, y], i) => [`p${i}`, [x, y]])),
    constraints: [],
  }
}

/** The same, with explicit entity ids so a "deleted first point" keeps the
 *  later ids: the naming key is the id, which is the fact under test. */
function namedPointSketch(id: string, points: { eid: string; xy: [number, number] }[]): Dict {
  return {
    id, kind: 'sketch', plane: FRONT,
    entities: points.map((p) => ({ id: p.eid, kind: 'point' })),
    initial: Object.fromEntries(points.map((p) => [p.eid, p.xy])),
    constraints: [],
  }
}

function circleSketch(id: string, x: number, y: number, r: number, plane = FRONT): Dict {
  return { id, kind: 'sketch', plane, entities: [{ id: 'c1', kind: 'circle' }], initial: { c1: [x, y, r] }, constraints: [] }
}

function extrude(id: string, sketch: string, distance: number, operation = 'new'): Dict {
  return { id, kind: 'extrude', extrude: { sketch: `@${sketch}`, distance, direction: 'normal', operation } }
}

const topPlane = (z: number): Dict => ({
  id: 'plTop', kind: 'plane', definition: { mode: 'offset', plane: FRONT, offset: z },
})

/** A plate from z 0 to 10, the standard body the picked-face cases target. */
const plate = (): Dict[] => [rectSketch('skPlate', 60, 60), extrude('exPlate', 'skPlate', 10)]

/** A separate boss body sitting on the plate top (z 10) and rising 8 mm. */
const boss = (): Dict[] => [
  topPlane(10),
  circleSketch('skBoss', 0, 0, 5, '@plTop'),
  extrude('exBoss', 'skBoss', 8),
]

describe.skipIf(!oc || !solveBytes)('instance pattern through the real kernel', () => {
  const h = new SharedHarness(oc!)
  const occ = oc as OccModule

  beforeAll(() => {
    if (!oc || !solveBytes) throw new Error('unreachable: skipIf guards this')
    resetSketchSolver()
    setSketchSolver(solveBytes)
  })

  function store(r: BuildResponse, featureId: string): Record<string, Body> {
    return r._build_state!.checkpoints[featureId].body_store_snapshot as Record<string, Body>
  }

  function boxOf(r: BuildResponse, featureId: string, bodyId: string): number[] {
    const truth = store(r, featureId)
    expect(Object.keys(truth)).toContain(bodyId)
    const scope = new DisposeScope()
    try {
      const box = shapeBndBox(occ, scope, h.table.get<OccShape>(truth[bodyId].shape!))
      // OCCT hands back -0 for a face on the origin; a box is zero there.
      return [...box.min, ...box.max].map((n) => {
        const rounded = Math.round(n * 1e6) / 1e6
        return rounded === 0 ? 0 : rounded
      })
    } finally {
      scope.dispose()
    }
  }

  function volumeOfStore(r: BuildResponse, featureId: string): number {
    const scope = new DisposeScope()
    try {
      return Object.values(store(r, featureId))
        .map((body) => volumeOf(occ, scope, h.table.get<OccShape>(body.shape!)))
        .reduce((a, b) => a + b, 0)
    } finally {
      scope.dispose()
    }
  }

  function faceUuids(r: BuildResponse, featureId: string, bodyId: string): string[] {
    return [...(store(r, featureId)[bodyId].face_uuids ?? [])]
      .filter((uuid): uuid is string => uuid !== null)
      .sort()
  }

  // A face of the running body's render payload, by predicate over its data.
  function faceQuery(r: BuildResponse, bodyId: string, predicate: (data: Dict) => boolean): string {
    const body = h.body(r, bodyId) as { mesh?: { face_data?: Dict[]; face_queries?: string[] } }
    const data = body.mesh?.face_data ?? []
    const queries = body.mesh?.face_queries ?? []
    const index = data.findIndex(predicate)
    if (index < 0) throw new Error(`no face of ${bodyId} matched the predicate`)
    return queries[index]
  }

  const fourPoints: [number, number][] = [[0, 0], [20, 0], [40, 0], [0, 20]]

  function pointPatternDoc(extra: Dict = {}, points = fourPoints, construction: number[] = []): Record<string, unknown> {
    return {
      version: 9, kind: 'part',
      features: [
        rectSketch('sk1', 4, 4),
        extrude('ex1', 'sk1', 5),
        pointSketch('skPts', points, construction),
        {
          id: 'ip1', kind: 'instance_pattern',
          instance_pattern: {
            subject: 'body', source_body: '@body_ex1', operation: 'new',
            targets: ['@skPts'], reference: 'entity:skPts:p0', ...extra,
          },
        },
      ],
    }
  }

  /** The same pattern authored the retired way: a `sketch` key instead of the
   *  sketch's target row. The loader migrates it, but a hand-built doc can still
   *  carry it, and the kernel reads it as the leading target. */
  function legacySketchDoc(extra: Dict = {}): Record<string, unknown> {
    return {
      version: 9, kind: 'part',
      features: [
        rectSketch('sk1', 4, 4),
        extrude('ex1', 'sk1', 5),
        pointSketch('skPts', fourPoints),
        {
          id: 'ip1', kind: 'instance_pattern',
          instance_pattern: {
            subject: 'body', source_body: '@body_ex1', operation: 'new',
            sketch: '@skPts', reference: 'entity:skPts:p0', ...extra,
          },
        },
      ],
    }
  }

  it('copies the source onto every sketch point, the source slot making no copy', () => {
    const r = h.run(pointPatternDoc())
    expect(h.res(r, 'ip1').status).toBe('ok')
    expect(h.res(r, 'ip1').orientation).toBe('normal')
    expect(h.res(r, 'ip1').target_count).toBe(4)
    // The source is instance 0; the other three points carry one copy each.
    expect(Object.keys(store(r, 'ip1')).sort()).toEqual(['body_ex1', 'body_ip1', 'body_ip1_1', 'body_ip1_2'])
    expect(boxOf(r, 'ip1', 'body_ip1')).toEqual([20, 0, 0, 24, 4, 5])
    expect(boxOf(r, 'ip1', 'body_ip1_1')).toEqual([40, 0, 0, 44, 4, 5])
    expect(boxOf(r, 'ip1', 'body_ip1_2')).toEqual([0, 20, 0, 4, 24, 5])
    expect(volumeOfStore(r, 'ip1')).toBeCloseTo(4 * 4 * 5 * 4, 6)
  })

  it('skips the second target by its position in the list', () => {
    const r = h.run(pointPatternDoc({ skip: [2] }))
    expect(h.res(r, 'ip1').status).toBe('ok')
    expect(Object.keys(store(r, 'ip1')).sort()).toEqual(['body_ex1', 'body_ip1', 'body_ip1_1'])
    expect(boxOf(r, 'ip1', 'body_ip1')).toEqual([40, 0, 0, 44, 4, 5])
    expect(boxOf(r, 'ip1', 'body_ip1_1')).toEqual([0, 20, 0, 4, 24, 5])
  })

  it('ignores construction points in a sketch target row', () => {
    const r = h.run(pointPatternDoc({}, [[0, 0], [20, 0], [90, 90]], [2]))
    expect(h.res(r, 'ip1').status).toBe('ok')
    expect(Object.keys(store(r, 'ip1')).sort()).toEqual(['body_ex1', 'body_ip1'])
    expect(boxOf(r, 'ip1', 'body_ip1')).toEqual([20, 0, 0, 24, 4, 5])
  })

  it('keeps the remaining copies named by entity id when the first point is deleted', () => {
    const before = h.run(pointPatternDoc())
    const beforeP2 = faceUuids(before, 'ip1', 'body_ip1_1')
    const beforeP3 = faceUuids(before, 'ip1', 'body_ip1_2')
    // p0 is gone, so p1 is now the first point and the source slot; p2 and p3
    // keep their ids while the reference moves.
    const after = h.run({
      version: 9, kind: 'part',
      features: [
        rectSketch('sk1', 4, 4),
        extrude('ex1', 'sk1', 5),
        namedPointSketch('skPts', [
          { eid: 'p1', xy: [20, 0] },
          { eid: 'p2', xy: [40, 0] },
          { eid: 'p3', xy: [0, 20] },
        ]),
        {
          id: 'ip1', kind: 'instance_pattern',
          instance_pattern: {
            subject: 'body', source_body: '@body_ex1', operation: 'new',
            targets: ['@skPts'], reference: 'entity:skPts:p1',
          },
        },
      ],
    })
    expect(h.res(after, 'ip1').status).toBe('ok')
    // The copies moved with the new reference, but their names did not: the key
    // is the entity id, not the array position.
    expect(faceUuids(after, 'ip1', 'body_ip1')).toEqual(beforeP2)
    expect(faceUuids(after, 'ip1', 'body_ip1_1')).toEqual(beforeP3)
  })

  it('places a sketch target row exactly where the retired sketch form did', () => {
    // The sketch ref is a target that expands to the sketch's points. The
    // migration rewrites the old field into that row, so the two documents must
    // build the same bodies under the same names.
    const legacy = h.run(legacySketchDoc())
    const targets = h.run(pointPatternDoc())
    expect(h.res(legacy, 'ip1').status).toBe('ok')
    expect(h.res(targets, 'ip1').status).toBe('ok')
    expect(Object.keys(store(targets, 'ip1')).sort()).toEqual(Object.keys(store(legacy, 'ip1')).sort())
    for (const bodyId of ['body_ip1', 'body_ip1_1', 'body_ip1_2']) {
      expect(boxOf(targets, 'ip1', bodyId)).toEqual(boxOf(legacy, 'ip1', bodyId))
      expect(faceUuids(targets, 'ip1', bodyId)).toEqual(faceUuids(legacy, 'ip1', bodyId))
    }
    expect(h.res(targets, 'ip1').target_count).toBe(4)
  })

  it('treats a lingering sketch key as the leading target, not a second form', () => {
    // The kernel still reads the retired key so a hand-built document (the
    // fuzz used to author one) cannot fail on it. It merges, sketch first.
    const r = h.run(legacySketchDoc({ targets: ['entity:skPts:p1'] }))
    const result = h.res(r, 'ip1')
    expect(result.status).toBe('ok')
    expect(result.target_count).toBe(4)
    // p1 is reached twice; the copy list is the sketch's own, deduped.
    expect(String(result.solver_warning)).toContain("target 'entity:skPts:p1' is the same point as an earlier target")
  })

  it('expands a sketch row in place, so a sketch plus a vertex numbers N+1', () => {
    const pre = h.run({
      version: 9, kind: 'part',
      features: [...plate(), ...boss()],
    })
    const body = h.body(pre, 'body_exPlate') as { vertices?: number[][]; vertex_queries?: string[] }
    const vertexIndex = (body.vertices ?? []).findIndex((v) => v[0] > 25 && v[1] > 25 && v[2] > 9)
    expect(vertexIndex).toBeGreaterThanOrEqual(0)
    const vertexQuery = (body.vertex_queries ?? [])[vertexIndex]!
    const r = h.run({
      version: 9, kind: 'part',
      features: [
        ...plate(),
        ...boss(),
        pointSketch('skPts', [[0, 0], [20, 0]]),
        {
          id: 'ip1', kind: 'instance_pattern',
          instance_pattern: {
            subject: 'body', source_body: '@body_exBoss', operation: 'new',
            targets: ['@skPts', vertexQuery], reference: 'entity:skPts:p0',
          },
        },
      ],
    })
    const result = h.res(r, 'ip1')
    expect(result.status).toBe('ok')
    expect(result.target_count).toBe(3)
    expect(result.resolved_targets).toEqual(['1 = p0', '2 = p1', '3 = vertex'])
    // The source slot is p0; p1 and the vertex each carry one copy.
    const copies = Object.keys(store(r, 'ip1')).filter((id) => id.startsWith('body_ip1')).sort()
    expect(copies).toEqual(['body_ip1', 'body_ip1_1'])
    const p1Box = boxOf(r, 'ip1', 'body_ip1')
    expect((p1Box[0] + p1Box[3]) / 2).toBeCloseTo(20, 6)
  })

  it('counts expanded points when numbering a skip', () => {
    const r = h.run(pointPatternDoc({ skip: [3] }))
    expect(h.res(r, 'ip1').status).toBe('ok')
    expect(Object.keys(store(r, 'ip1')).sort()).toEqual(['body_ex1', 'body_ip1', 'body_ip1_1'])
    expect(boxOf(r, 'ip1', 'body_ip1')).toEqual([20, 0, 0, 24, 4, 5])
    expect(boxOf(r, 'ip1', 'body_ip1_1')).toEqual([0, 20, 0, 4, 24, 5])
  })

  it('drops a sketch with no point target and builds the rest', () => {
    const r = h.run({
      version: 9, kind: 'part',
      features: [
        rectSketch('sk1', 4, 4),
        extrude('ex1', 'sk1', 5),
        { id: 'skL', kind: 'sketch', plane: FRONT, entities: [{ id: 'l1', kind: 'line' }], initial: { l1: [0, 0, 10, 0] }, constraints: [] },
        pointSketch('skPts', [[20, 0]]),
        {
          id: 'ip1', kind: 'instance_pattern',
          instance_pattern: {
            subject: 'body', source_body: '@body_ex1', operation: 'new',
            targets: ['@skL', 'entity:skPts:p0'],
          },
        },
      ],
    })
    const result = h.res(r, 'ip1')
    expect(result.status).toBe('ok')
    expect(result.target_count).toBe(1)
    expect(String(result.solver_warning)).toContain("target '@skL' did not resolve to a point")
    // No reference pick: the source body's centroid (2, 2, 2.5) lands on the one
    // target at (20, 0, 0), so the copy is the 4 x 4 x 5 block centred there.
    expect(boxOf(r, 'ip1', 'body_ip1')).toEqual([18, -2, -2.5, 22, 2, 2.5])
  })

  it('fails on no target only when nothing is left', () => {
    const r = h.run({
      version: 9, kind: 'part',
      features: [
        rectSketch('sk1', 4, 4),
        extrude('ex1', 'sk1', 5),
        { id: 'skL', kind: 'sketch', plane: FRONT, entities: [{ id: 'l1', kind: 'line' }], initial: { l1: [0, 0, 10, 0] }, constraints: [] },
        {
          id: 'ip1', kind: 'instance_pattern',
          instance_pattern: { subject: 'body', source_body: '@body_ex1', operation: 'new', targets: ['@skL'] },
        },
      ],
    })
    const result = h.res(r, 'ip1')
    expect(result.status).toBe('exception')
    expect(String(result.exception)).toContain('no target resolved')
    expect(String(result.exception)).toContain("target '@skL' did not resolve to a point")
  })

  it('keeps a point reached twice once, with one warning naming it', () => {
    const r = h.run(pointPatternDoc({ targets: ['@skPts', 'entity:skPts:p1'] }))
    const result = h.res(r, 'ip1')
    expect(result.status).toBe('ok')
    expect(result.target_count).toBe(4)
    expect(Object.keys(store(r, 'ip1')).sort()).toEqual(['body_ex1', 'body_ip1', 'body_ip1_1', 'body_ip1_2'])
    const warning = String(result.solver_warning)
    expect(warning).toContain("target 'entity:skPts:p1' is the same point as an earlier target")
    expect(warning.match(/same point as an earlier target/g)).toHaveLength(1)
  })

  it('makes a flat sketch-points pattern identical under normal and fixed', () => {
    const normal = h.run(pointPatternDoc({ orientation: 'normal' }))
    const fixed = h.run(pointPatternDoc({ orientation: 'fixed' }))
    expect(h.res(normal, 'ip1').status).toBe('ok')
    expect(h.res(fixed, 'ip1').status).toBe('ok')
    for (const bodyId of ['body_ip1', 'body_ip1_1', 'body_ip1_2']) {
      expect(boxOf(fixed, 'ip1', bodyId)).toEqual(boxOf(normal, 'ip1', bodyId))
    }
  })

  it('repeats a cut feature from the source tool centroid', () => {
    // A plate with one 4 x 4 through cut at x 30. The source sketch has no
    // point, so the reference is the scratch tool's centroid (32, 2, 2.5); the
    // target at (52, 2) carries the copy 20 mm along.
    const r = h.run({
      version: 9, kind: 'part',
      features: [
        rectSketch('skPlate', 80, 40),
        extrude('ex1', 'skPlate', 5),
        rectSketch('sk2', 4, 4, 30, 0),
        { id: 'ex2', kind: 'extrude', extrude: { sketch: '@sk2', distance: 5, direction: 'normal', operation: 'cut', termination: 'through_all' } },
        // The target points sit on the tool's own centroid plane (z 2.5), so the
        // copy is the pure in-plane translation the centroid rule intends.
        topPlane(2.5),
        pointSketch('skPts', [[52, 2]], [], '@plTop'),
        {
          id: 'ip1', kind: 'instance_pattern',
          instance_pattern: {
            subject: 'feature', source_features: ['@ex2'],
            targets: ['@skPts'], orientation: 'fixed',
          },
        },
      ],
    })
    expect(h.res(r, 'ip1').status).toBe('ok')
    expect(h.res(r, 'ip1').reference_rule).toBe('the source tool\'s centroid')
    expect(volumeOfStore(r, 'ip1')).toBeCloseTo(80 * 40 * 5 - 2 * 4 * 4 * 5, 6)
  })

  it('reapplies a source named through the add-pattern-source mutation', () => {
    // The Feature tab writes the source through the chip's mutation, not as
    // inline YAML: the same two cuts as the case above prove the authored row
    // reaches the kernel intact.
    const doc = {
      version: 9, kind: 'part',
      features: [
        rectSketch('skPlate', 80, 40),
        extrude('ex1', 'skPlate', 5),
        rectSketch('sk2', 4, 4, 30, 0),
        { id: 'ex2', kind: 'extrude', extrude: { sketch: '@sk2', distance: 5, direction: 'normal', operation: 'cut', termination: 'through_all' } },
        topPlane(2.5),
        pointSketch('skPts', [[52, 2]], [], '@plTop'),
        {
          id: 'ip1', kind: 'instance_pattern',
          instance_pattern: { subject: 'feature', targets: ['@skPts'], orientation: 'fixed' },
        },
      ],
    }
    applyAddPatternSource(doc as unknown as PartDoc, 'ip1', '@ex2')
    const r = h.run(doc)
    expect(h.res(r, 'ip1').status).toBe('ok')
    expect(volumeOfStore(r, 'ip1')).toBeCloseTo(80 * 40 * 5 - 2 * 4 * 4 * 5, 6)
  })

  it('turns a boss onto a side face under normal and leaves it upright under fixed', () => {
    // The source boss sits on the plate top at the origin and rises 8 mm; its
    // reference is its own top face, so the source normal is +Z.
    const pre = h.run({
      version: 9, kind: 'part',
      features: [...plate(), ...boss()],
    })
    expect(h.res(pre, 'exBoss').status).toBe('ok')
    const sideQuery = faceQuery(pre, 'body_exPlate', (data) =>
      data.surface_type === 'flatface' && (data.normal as number[])[0] > 0.99)
    // The boss's own circle centre is its base point on the plate top, with the
    // sketch plane normal +Z: the reference the copy is carried from, so the
    // boss stands out of the face rather than hanging behind it.
    const doc = (orientation: string): Record<string, unknown> => ({
      version: 9, kind: 'part',
      features: [
        ...plate(),
        ...boss(),
        {
          id: 'ip1', kind: 'instance_pattern',
          instance_pattern: {
            subject: 'body', source_body: '@body_exBoss', operation: 'new',
            targets: [sideQuery], reference: 'entity:skBoss:c1', orientation,
          },
        },
      ],
    })
    const normal = h.run(doc('normal'))
    const fixed = h.run(doc('fixed'))
    expect(h.res(normal, 'ip1').status).toBe('ok')
    expect(h.res(fixed, 'ip1').status).toBe('ok')
    const turned = boxOf(normal, 'ip1', 'body_ip1')
    const upright = boxOf(fixed, 'ip1', 'body_ip1')
    // Turned: the 8 mm axis now runs along +X, out of the side face.
    expect(turned[3] - turned[0]).toBeCloseTo(8, 2)
    expect(turned[3]).toBeGreaterThan(60 + 7)
    // Fixed: the boss stays upright, its 8 mm axis along Z and straddling the
    // side (translated by the pick minus its base at z 10).
    expect(upright[5] - upright[2]).toBeCloseTo(8, 2)
    expect(upright[2]).toBeCloseTo(5, 2)
    expect(upright[5]).toBeCloseTo(13, 2)
  })

  it('keeps an antiparallel copy deterministic across re-solves', () => {
    const pre = h.run({
      version: 9, kind: 'part',
      features: [...plate(), ...boss()],
    })
    const topQuery = faceQuery(pre, 'body_exPlate', (data) =>
      data.surface_type === 'flatface' && (data.normal as number[])[2] > 0.99 && (data.centroid as number[])[2] > 9)
    const bottomQuery = faceQuery(pre, 'body_exPlate', (data) =>
      data.surface_type === 'flatface' && (data.normal as number[])[2] < -0.99)
    const doc: Record<string, unknown> = {
      version: 9, kind: 'part',
      features: [
        ...plate(),
        ...boss(),
        {
          id: 'ip1', kind: 'instance_pattern',
          instance_pattern: {
            subject: 'body', source_body: '@body_exBoss', operation: 'new',
            targets: [bottomQuery], reference: topQuery, orientation: 'normal',
          },
        },
      ],
    }
    const first = h.run(doc)
    const second = h.run(doc)
    expect(h.res(first, 'ip1').status).toBe('ok')
    expect(h.res(second, 'ip1').status).toBe('ok')
    expect(boxOf(second, 'ip1', 'body_ip1')).toEqual(boxOf(first, 'ip1', 'body_ip1'))
    expect(faceUuids(second, 'ip1', 'body_ip1')).toEqual(faceUuids(first, 'ip1', 'body_ip1'))
  })

  it('copies a mixed face and vertex list, the vertex target moved only and quietly', () => {
    const pre = h.run({
      version: 9, kind: 'part',
      features: [...plate(), ...boss()],
    })
    const topQuery = faceQuery(pre, 'body_exPlate', (data) =>
      data.surface_type === 'flatface' && (data.normal as number[])[2] > 0.99 && (data.centroid as number[])[2] > 9)
    const capQuery = faceQuery(pre, 'body_exBoss', (data) =>
      data.surface_type === 'flatface' && (data.normal as number[])[2] > 0.99)
    const body = h.body(pre, 'body_exPlate') as { vertices?: number[][]; vertex_queries?: string[] }
    const vertexIndex = (body.vertices ?? []).findIndex((v) => v[0] > 25 && v[1] > 25 && v[2] > 9)
    expect(vertexIndex).toBeGreaterThanOrEqual(0)
    const vertexQuery = (body.vertex_queries ?? [])[vertexIndex]
    const r = h.run({
      version: 9, kind: 'part',
      features: [
        ...plate(),
        ...boss(),
        {
          id: 'ip1', kind: 'instance_pattern',
          instance_pattern: {
            subject: 'body', source_body: '@body_exBoss', operation: 'new',
            targets: [topQuery, vertexQuery], reference: capQuery, orientation: 'normal',
          },
        },
      ],
    })
    const result = h.res(r, 'ip1')
    expect(result.status).toBe('ok')
    expect(result.solver_warning).toBeUndefined()
    expect(Object.keys(store(r, 'ip1')).filter((id) => id.startsWith('body_ip1'))).toHaveLength(2)
  })

  it('puts a screw into each blind hole, shank collinear with the bore axis and head at the mouth', () => {
    // Two blind holes on the plate top, and a screw body (a 6 mm shank plus a
    // 10 mm head) whose reference is a point on its head base plane. The bore
    // face's free end is the mouth, so each copy lands head-up with its shank
    // down the hole. reverse_normal turns the heads inside the part.
    const screw = (): Dict[] => [
      circleSketch('skShank', 0, 0, 3, '@plTop'),
      { id: 'exShank', kind: 'extrude', extrude: { sketch: '@skShank', distance: 10, direction: 'reverse', operation: 'new' } },
      circleSketch('skHead', 0, 0, 5, '@plTop'),
      { id: 'exHead', kind: 'extrude', extrude: { sketch: '@skHead', distance: 3, operation: 'add', merge_target: '@body_exShank' } },
      pointSketch('skRef', [[0, 0]], [], '@plTop'),
    ]
    const holes = (): Dict[] => [
      pointSketch('skHole1', [[20, 20]], [], '@plTop'),
      pointSketch('skHole2', [[40, 20]], [], '@plTop'),
      { id: 'ho1', kind: 'hole', hole: { sketch: '@skHole1', diameter: 6, depth_mode: 'blind', depth: 5, direction: 'reverse', target: '@body_exPlate' } },
      { id: 'ho2', kind: 'hole', hole: { sketch: '@skHole2', diameter: 6, depth_mode: 'blind', depth: 5, direction: 'reverse', target: '@body_exPlate' } },
    ]
    const pre = h.run({ version: 9, kind: 'part', features: [...plate(), topPlane(10), ...holes(), ...screw()] })
    expect(h.res(pre, 'exHead').status).toBe('ok')
    const bores = (h.body(pre, 'body_exPlate') as { mesh?: { face_data?: Dict[]; face_queries?: string[] } })
    const boreQueries = (bores.mesh?.face_data ?? [])
      .map((data, index) => ({ data, query: bores.mesh?.face_queries?.[index] ?? '' }))
      .filter((row) => row.data.surface_type === 'cylinderface')
      .map((row) => row.query)
    expect(boreQueries).toHaveLength(2)

    const doc = (extra: Dict): Record<string, unknown> => ({
      version: 9, kind: 'part',
      features: [
        ...plate(), topPlane(10), ...holes(), ...screw(),
        {
          id: 'ip1', kind: 'instance_pattern',
          instance_pattern: {
            subject: 'body', source_body: '@body_exShank', operation: 'new',
            targets: boreQueries, reference: 'entity:skRef:p0', orientation: 'normal', ...extra,
          },
        },
      ],
    })
    const r = h.run(doc({}))
    expect(h.res(r, 'ip1').status).toBe('ok')
    // The source's head base is at z 10; a hole mouth is at z 10, so each copy
    // keeps the screw upright: shank through the plate, head above the top.
    expect(boxOf(r, 'ip1', 'body_ip1')).toEqual([15, 15, 0, 25, 25, 13])
    expect(boxOf(r, 'ip1', 'body_ip1_1')).toEqual([35, 15, 0, 45, 25, 13])
    // The shank's own cylinder axis is on the bore axis.
    const copied = h.body(r, 'body_ip1') as { mesh?: { face_data?: Dict[] } }
    const shank = (copied.mesh?.face_data ?? []).find((data) =>
      data.surface_type === 'cylinderface'
      && Math.abs(((data.surface_frame as Dict).radius as number) - 3) < 1e-6)!
    const frame = shank.surface_frame as Dict
    expect((frame.origin as number[])[0]).toBeCloseTo(20, 6)
    expect((frame.origin as number[])[1]).toBeCloseTo(20, 6)

    const reversed = h.run(doc({ reverse_normal: true }))
    expect(h.res(reversed, 'ip1').status).toBe('ok')
    // Heads inside the part: the 3 mm head now runs z 7..10 under the mouth,
    // and the 10 mm shank stands up out of it.
    const reversedBox = boxOf(reversed, 'ip1', 'body_ip1')
    expect(reversedBox[2]).toBeCloseTo(7, 6)
    expect(reversedBox[5]).toBeCloseTo(20, 6)
  })

  it('takes the first face target normal when the reference is the source centroid', () => {
    const pre = h.run({
      version: 9, kind: 'part',
      features: [...plate(), ...boss()],
    })
    const sideQuery = faceQuery(pre, 'body_exPlate', (data) =>
      data.surface_type === 'flatface' && Math.abs((data.normal as number[])[0]) > 0.99)
    const r = h.run({
      version: 9, kind: 'part',
      features: [
        ...plate(),
        ...boss(),
        {
          id: 'ip1', kind: 'instance_pattern',
          instance_pattern: {
            subject: 'body', source_body: '@body_exBoss', operation: 'new',
            targets: [sideQuery], orientation: 'normal',
          },
        },
      ],
    })
    expect(h.res(r, 'ip1').status).toBe('ok')
    expect(h.res(r, 'ip1').source_normal_rule).toBe('first target')
    // Source normal = the target's own normal, so the copy is a pure translation.
    const box = boxOf(r, 'ip1', 'body_ip1')
    expect(box[5] - box[2]).toBeCloseTo(8, 2)
  })
})
