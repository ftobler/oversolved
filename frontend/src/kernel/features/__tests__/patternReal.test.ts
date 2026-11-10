// @vitest-environment node
//
// The pattern leaf through the production builder (SharedHarness): real OCC
// plus the Rust sketch solver. It pins the geometry a repeated add/cut really
// removes or adds, the partial report when a copy misses the body, the lineage
// names each copy gets, and the refusals that name their fix.
//
// Skips when OCC.js or the sketch solver is absent.

import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from '../../occ/loadOcc'
import { SharedHarness } from '../../occ/sharedHarness'
import { DisposeScope } from '../../occ/disposeScope'
import { setSketchSolver, resetSketchSolver } from '../sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { parseAncestry } from '../../query'
import { volumeOf } from '../../occ/volume'
import { canonicalFaces } from '../../occ/bodyNames'
import { shapeBndBox } from '../../occ/primitives'
import type { OccModule, OccShape } from '../../occ/occTypes'
import type { BuildResponse } from '../../builder'
import type { Body } from '../../types3d'

const oc = await loadOcc()
const solveBytes = loadSolver()

type Dict = Record<string, unknown>

interface FaceMesh {
  face_data?: { centroid: number[]; normal: number[]; surface_type?: string }[]
  face_queries?: string[]
}
interface BodyView {
  mesh?: FaceMesh
  modified_by?: string[]
}

const uuidTokenOf = (q: string): string | undefined =>
  parseAncestry(q)[0].find((i) => i.startsWith('@u|'))?.slice('@u|'.length)

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
      id: `c${i}`,
      kind: 'coincident',
      a: { entity: `l${i}`, point: 'end' },
      b: { entity: `l${(i + 1) % n}`, point: 'start' },
    })
    constraints.push({ id: `h${i}`, kind: a[1] === b[1] ? 'horizontal' : 'vertical', target: { entity: `l${i}` } })
  }
  return { id, kind: 'sketch', plane, entities, initial, constraints }
}

function rectSketch(id: string, w: number, h: number, x0 = 0, y0 = 0): Dict {
  return polySketch(id, [[x0, y0], [x0 + w, y0], [x0 + w, y0 + h], [x0, y0 + h]])
}

function circleSketch(id: string, cx: number, cy: number, r: number): Dict {
  return {
    id, kind: 'sketch', plane: '@builtin_plane_front',
    entities: [{ id: 'c1', kind: 'circle' }],
    initial: { c1: [cx, cy, r] },
    constraints: [{ id: 'r1', kind: 'radius', target: { entity: 'c1' } }],
  }
}

function extrude(id: string, sketch: string, distance: number, operation = 'new'): Dict {
  return { id, kind: 'extrude', extrude: { sketch, distance, direction: 'normal', operation } }
}

function pattern(id: string, sourceFeature: string, fields: Dict): Dict {
  return { id, kind: 'pattern', pattern: { subject: 'feature', source_feature: `@${sourceFeature}`, ...fields } }
}

function linear(fields: Dict): Dict {
  return { mode: 'linear', count: 2, pitch: 10, direction: [1, 0, 0], ...fields }
}

describe.skipIf(!oc || !solveBytes)('solvePattern through the builder (real OCC + Rust solver)', () => {
  const h = new SharedHarness(oc!)
  const occ = oc as OccModule

  beforeAll(() => {
    if (!oc || !solveBytes) throw new Error('unreachable: skipIf guards this')
    resetSketchSolver()
    setSketchSolver(solveBytes)
  })

  const meshOf = (r: BuildResponse, bodyId: string): FaceMesh => (h.body(r, bodyId).mesh ?? {}) as FaceMesh
  const viewOf = (r: BuildResponse, bodyId: string): BodyView => h.body(r, bodyId) as BodyView

  function snapshot(r: BuildResponse, featureId: string): Record<string, Body> {
    const ckp = r._build_state!.checkpoints[featureId]
    return ckp.body_store_snapshot as Record<string, Body>
  }
  function shapeAt(r: BuildResponse, featureId: string, bodyId: string): OccShape {
    return h.table.get<OccShape>(snapshot(r, featureId)[bodyId].shape!)
  }
  function volumeAt(r: BuildResponse, featureId: string, bodyId: string): number {
    const scope = new DisposeScope()
    try { return volumeOf(occ, scope, shapeAt(r, featureId, bodyId)) } finally { scope.dispose() }
  }
  function bboxAt(r: BuildResponse, featureId: string, bodyId: string) {
    const scope = new DisposeScope()
    try { return shapeBndBox(occ, scope, shapeAt(r, featureId, bodyId)) } finally { scope.dispose() }
  }
  function faceCountAt(r: BuildResponse, featureId: string, bodyId: string): number {
    const scope = new DisposeScope()
    try { return canonicalFaces(occ, scope, shapeAt(r, featureId, bodyId)).length } finally { scope.dispose() }
  }
  function liveFaceUuids(r: BuildResponse, bodyId: string): string[] {
    return (meshOf(r, bodyId).face_queries ?? []).map(uuidTokenOf).filter((u): u is string => u !== undefined)
  }
  function expectUniqueFaceUuids(r: BuildResponse, featureId: string): void {
    const seen = new Set<string>()
    for (const [id, body] of Object.entries(snapshot(r, featureId))) {
      for (const uuid of body.face_uuids ?? []) {
        if (uuid === null) continue
        expect(seen.has(uuid), `UUID ${uuid} claimed twice, second on ${id}`).toBe(false)
        seen.add(uuid)
      }
    }
  }

  // A 40 x 20 plate on the front plane, then a 4 x 4 cut slot at (6, 6) that
  // passes through the 5 thick plate.
  const slottedPlate = (patternFeature?: Dict): { features: Dict[] } => ({
    features: [
      rectSketch('sk_plate', 40, 20),
      extrude('ex_plate', '$sk_plate', 5),
      rectSketch('sk_slot', 4, 4, 6, 6),
      extrude('ex_slot', '$sk_slot', 10, 'cut'),
      ...(patternFeature === undefined ? [] : [patternFeature]),
    ],
  })

  it('repeats a cut into the body and removes exactly four slots', () => {
    const baseline = h.run(slottedPlate())
    const r = h.run(slottedPlate(pattern('pt1', 'ex_slot', linear({ count: 4, pitch: 8 }))))
    expect(h.res(r, 'pt1').status).toBe('ok')
    expect(h.res(r, 'pt1').operation).toBe('cut')
    expect(h.res(r, 'pt1').body_ids).toEqual(['body_ex_plate'])
    // 40 x 20 x 5 plate minus four 4 x 4 x 5 slots.
    expect(volumeAt(baseline, 'ex_slot', 'body_ex_plate')).toBeCloseTo(4000 - 80, 6)
    expect(volumeAt(r, 'pt1', 'body_ex_plate')).toBeCloseTo(4000 - 320, 6)
    expect(faceCountAt(r, 'pt1', 'body_ex_plate')).toBe(6 + 4 * 4)
    // The copies' walls live under the pattern feature, in their own UUIDs.
    expect(viewOf(r, 'body_ex_plate').modified_by?.at(-1)).toBe('pt1')
    const before = new Set(liveFaceUuids(baseline, 'body_ex_plate'))
    const after = liveFaceUuids(r, 'body_ex_plate')
    expect(new Set(after).size).toBe(after.length)
    expect(after.filter((uuid) => !before.has(uuid)).length).toBeGreaterThanOrEqual(12)
    expectUniqueFaceUuids(r, 'pt1')
  })

  it('infers the feature subject on a pattern authored before the subject field', () => {
    // Old rows carry source_feature and no subject. Reading the source they
    // actually name keeps them solving without rewriting the document.
    const r = h.run({
      features: [
        rectSketch('sk_plate', 40, 20),
        extrude('ex_plate', '$sk_plate', 5),
        rectSketch('sk_slot', 4, 4, 2, 2),
        extrude('ex_slot', '$sk_slot', 10, 'cut'),
        {
          id: 'pt1', kind: 'pattern',
          pattern: { source_feature: '@ex_slot', mode: 'linear', count: 4, pitch: 8, direction: [1, 0, 0] },
        },
      ],
    })
    expect(h.res(r, 'pt1').status).toBe('ok')
    expect(volumeAt(r, 'pt1', 'body_ex_plate')).toBeCloseTo(4000 - 320, 6)
  })

  it('leaves an add copy that misses the target as its own part', () => {
    // The source boss is fused into the plate; its pattern copy sits a pitch
    // away and does not touch the plate. That used to fail with "add would
    // create island shape"; an island is a regular new part, so the pattern
    // succeeds and the copy is its own body.
    const r = h.run({
      features: [
        rectSketch('sk_plate', 10, 10, -5, -5),
        extrude('ex_plate', '$sk_plate', 5),
        rectSketch('sk_boss', 2, 2, 1, 1),
        extrude('ex_boss', '$sk_boss', 4, 'add'),
        pattern('pt1', 'ex_boss', linear({ count: 2, pitch: -20 })),
      ],
    })
    const res = h.res(r, 'pt1')
    expect(res.status).toBe('ok')
    // The island is on the NEGATIVE side, so centroid order would rank it
    // first; the target must still keep the existing id.
    expect(res.body_ids).toEqual(['body_ex_plate', 'body_ex_plate_1'])
    // The source boss sits inside the plate, so it adds no material; the island
    // copy is outside it and contributes its own 2 x 2 x 4 volume.
    expect(volumeAt(r, 'pt1', 'body_ex_plate')).toBeCloseTo(500, 6)
    expect(volumeAt(r, 'pt1', 'body_ex_plate_1')).toBeCloseTo(16, 6)
  })

  it('repeats a cut around an axis, one copy per 90 degrees', () => {
    const spec = (patternFeature?: Dict): { features: Dict[] } => ({
      features: [
        rectSketch('sk_plate', 40, 40, -20, -20),
        extrude('ex_plate', '$sk_plate', 5),
        circleSketch('sk_hole', 12, 0, 3),
        extrude('ex_hole', '$sk_hole', 10, 'cut'),
        ...(patternFeature === undefined ? [] : [patternFeature]),
      ],
    })
    const r = h.run(spec(pattern('pt1', 'ex_hole', {
      mode: 'circular', count: 4, step_angle: 90,
      axis_origin: [0, 0, 0], axis_direction: [0, 0, 1],
    })))
    expect(h.res(r, 'pt1').status).toBe('ok')
    // 40 x 40 x 5 plate minus four bores r3 through 5.
    expect(volumeAt(r, 'pt1', 'body_ex_plate')).toBeCloseTo(8000 - 4 * Math.PI * 9 * 5, 5)
    // One cylindrical wall per bore, plus the plate's six faces.
    expect(faceCountAt(r, 'pt1', 'body_ex_plate')).toBe(6 + 4)
    expectUniqueFaceUuids(r, 'pt1')
  })

  it('repeats an add and fuses every copy into the same body', () => {
    // A 40 x 20 x 4 pad plus a cylinder r2 h3 sitting on its top face at
    // (10, 10), repeated three times along X.
    const r = h.run({
      features: [
        rectSketch('sk_base', 40, 20),
        extrude('ex_base', '$sk_base', 4),
        { id: 'pl_boss', kind: 'plane', definition: { mode: 'offset', plane: '@builtin_plane_front', offset: 4 } },
        {
          id: 'sk_boss', kind: 'sketch', plane: '@pl_boss',
          entities: [{ id: 'b', kind: 'circle' }], initial: { b: [10, 10, 2] },
          constraints: [{ id: 'r', kind: 'radius', target: { entity: 'b' } }],
        },
        {
          id: 'ex_boss', kind: 'extrude',
          extrude: { sketch: '@sk_boss', distance: 3, direction: 'normal', operation: 'add' },
        },
        pattern('pt1', 'ex_boss', linear({ count: 3, pitch: 10 })),
      ],
    })
    expect(h.res(r, 'ex_boss').status).toBe('ok')
    expect(h.res(r, 'pt1').status).toBe('ok')
    expect(h.res(r, 'pt1').body_ids).toEqual(['body_ex_base'])
    // 40 x 20 x 4 plate plus three cylinders r2 h3.
    expect(volumeAt(r, 'pt1', 'body_ex_base')).toBeCloseTo(3200 + 3 * Math.PI * 4 * 3, 4)
    expectUniqueFaceUuids(r, 'pt1')
  })

  it('stops and names the copy when a cut consumes the target', () => {
    // The source cut leaves a 10 x 1 strip; the copy at y = 9 removes the rest.
    // The batch sees no solid and falls back to the per-copy path, which reports
    // the deletion and applies no later copy.
    const r = h.run({
      features: [
        rectSketch('sk_plate', 10, 10),
        extrude('ex_plate', '$sk_plate', 5),
        rectSketch('sk_slot', 10, 9, 0, 0),
        extrude('ex_slot', '$sk_slot', 10, 'cut'),
        pattern('pt1', 'ex_slot', linear({ count: 3, pitch: 9, direction: [0, 1, 0] })),
      ],
    })
    const res = h.res(r, 'pt1')
    expect(res.status).toBe('partial')
    expect(String(res.solver_warning)).toContain("copy 1 removed all of body 'body_ex_plate'")
    expect(String(res.solver_warning)).toContain('later copies were not applied')
    expect(res.body_ids).toEqual([])
  })

  it('reports a copy that misses the body as partial, naming the copy', () => {
    const r = h.run({
      features: [
        rectSketch('sk_plate', 30, 20),
        extrude('ex_plate', '$sk_plate', 5),
        rectSketch('sk_slot', 2, 2, 2, 2),
        extrude('ex_slot', '$sk_slot', 10, 'cut'),
        pattern('pt1', 'ex_slot', linear({ count: 4, pitch: 12 })),
      ],
    })
    const res = h.res(r, 'pt1')
    expect(res.status).toBe('partial')
    expect(String(res.exception)).toContain('2/3 copies applied')
    expect(String(res.exception)).toContain('copy 3')
    // The three holes that landed: x 2..4, 14..16, 26..28.
    expect(volumeAt(r, 'pt1', 'body_ex_plate')).toBeCloseTo(3000 - 3 * 20, 6)
  })

  it('fails when no copy can be applied', () => {
    const r = h.run({
      features: [
        rectSketch('sk_plate', 10, 10),
        extrude('ex_plate', '$sk_plate', 5),
        rectSketch('sk_slot', 2, 2, 2, 2),
        extrude('ex_slot', '$sk_slot', 10, 'cut'),
        pattern('pt1', 'ex_slot', linear({ count: 3, pitch: 20 })),
      ],
    })
    const res = h.res(r, 'pt1')
    expect(res.status).toBe('exception')
    expect(String(res.exception)).toContain('pattern: no copy was applied')
    // The body is untouched by the failed feature.
    expect(volumeAt(r, 'pt1', 'body_ex_plate')).toBeCloseTo(500 - 20, 6)
  })

  it('refuses a source that is missing, suppressed or not a solid producer', () => {
    const missing = h.run({
      features: [
        rectSketch('sk', 10, 10),
        extrude('ex', '$sk', 5),
        pattern('pt1', 'missing', linear({})),
      ],
    })
    expect(String(h.res(missing, 'pt1').exception)).toContain("source feature 'missing' does not exist")

    const suppressed = h.run({
      features: [
        rectSketch('sk', 10, 10),
        { ...extrude('ex', '$sk', 5), suppressed: true },
        pattern('pt1', 'ex', linear({})),
      ],
    })
    expect(String(h.res(suppressed, 'pt1').exception)).toContain('is suppressed')

    const notSolid = h.run({
      features: [
        rectSketch('sk', 10, 10),
        extrude('ex', '$sk', 5),
        pattern('pt1', 'sk', linear({})),
      ],
    })
    expect(String(h.res(notSolid, 'pt1').exception)).toContain('a feature pattern repeats an extrude, revolve or sweep')
  })

  it('names the order fix when the source comes after the pattern', () => {
    const r = h.run({
      features: [
        rectSketch('sk', 10, 10),
        extrude('ex', '$sk', 5),
        pattern('pt1', 'later', linear({})),
        rectSketch('sk2', 4, 4, 1, 1),
        extrude('later', '$sk2', 5, 'cut'),
      ],
    })
    expect(String(h.res(r, 'pt1').exception)).toContain('comes after this pattern')
    expect(String(h.res(r, 'pt1').exception)).toContain('reorder_features')
  })

  it('refuses a source that starts a new body or trims up_to', () => {
    const newBody = h.run({
      features: [
        rectSketch('sk', 10, 10),
        extrude('ex', '$sk', 5),
        pattern('pt1', 'ex', linear({})),
      ],
    })
    expect(String(h.res(newBody, 'pt1').exception)).toContain("operation 'new'")

    const upTo = h.run({
      features: [
        rectSketch('sk', 20, 20),
        extrude('ex', '$sk', 5),
        rectSketch('sk2', 4, 4, 2, 2),
        {
          id: 'up', kind: 'extrude',
          extrude: {
            sketch: '@sk2', distance: 10, direction: 'normal', operation: 'cut',
            termination: 'up_to', up_to: '@builtin_plane_top',
          },
        },
        pattern('pt1', 'up', linear({})),
      ],
    })
    expect(String(h.res(upTo, 'pt1').exception)).toContain('terminates up_to')

    const next = h.run({
      features: [
        rectSketch('sk', 20, 20),
        extrude('ex', '$sk', 5),
        rectSketch('sk2', 4, 4, 2, 2),
        {
          id: 'up',
          kind: 'extrude',
          extrude: {
            sketch: '@sk2', distance: 10, direction: 'normal', operation: 'cut',
            termination: 'up_to_next',
          },
        },
        pattern('pt1', 'up', linear({})),
      ],
    })
    expect(String(h.res(next, 'pt1').exception)).toContain('terminates up_to_next')
  })

  it('asks for target_body when the source touched more than one body', () => {
    // Two separate 10 x 10 x 5 blocks, one shallow slot across both, so the
    // source cut touches two bodies without severing either.
    const features = (target?: string): Dict[] => [
      rectSketch('sk_a', 10, 10),
      extrude('ex_a', '$sk_a', 5),
      rectSketch('sk_b', 10, 10, 20, 0),
      extrude('ex_b', '$sk_b', 5),
      rectSketch('sk_cut', 30, 2, 0, 4),
      extrude('ex_cut', '$sk_cut', 3, 'cut'),
      pattern('pt1', 'ex_cut', linear({ count: 2, pitch: 3, direction: [0, 1, 0], ...(target === undefined ? {} : { target_body: target }) })),
    ]
    const ambiguous = h.run({ features: features() })
    const message = String(h.res(ambiguous, 'pt1').exception)
    expect(message).toContain('touched 2 bodies')
    expect(message).toContain('target_body')
    expect(message).toContain('body_ex_a')
    expect(message).toContain('body_ex_b')

    // The named target takes the copy; the other block keeps only the source cut.
    const named = h.run({ features: features('@body_ex_a') })
    expect(h.res(named, 'pt1').status).toBe('ok')
    expect(h.res(named, 'pt1').body_ids).toEqual(['body_ex_a'])
    // Each block: 500 minus the source slot 10 x 2 x 3 = 60.
    // The copy at y 7..9 removes another 10 x 2 x 3 = 60 from A only.
    expect(volumeAt(named, 'pt1', 'body_ex_a')).toBeCloseTo(500 - 60 - 60, 6)
    expect(volumeAt(named, 'pt1', 'body_ex_b')).toBeCloseTo(500 - 60, 6)
    expect(bboxAt(named, 'pt1', 'body_ex_b').min[0]).toBeCloseTo(20, 6)
  })

  it('resolves the source expressions and its own count through the variable table', () => {
    const r = h.run({
      features: [
        { id: 'v_depth', kind: 'variable', label: 'depth', variable: { expression: '5' } },
        { id: 'v_count', kind: 'variable', label: 'copies', variable: { expression: '4' } },
        rectSketch('sk_plate', 40, 20),
        { id: 'ex_plate', kind: 'extrude', extrude: { sketch: '@sk_plate', distance: 'depth', direction: 'normal', operation: 'new' } },
        rectSketch('sk_slot', 4, 4, 6, 6),
        { id: 'ex_slot', kind: 'extrude', extrude: { sketch: '@sk_slot', distance: 10, direction: 'normal', operation: 'cut' } },
        pattern('pt1', 'ex_slot', linear({ count: 'copies', pitch: 8 })),
      ],
    })
    expect(h.res(r, 'pt1').status).toBe('ok')
    // The same geometry as the literal-source test: four slots in a 5 thick plate.
    expect(volumeAt(r, 'pt1', 'body_ex_plate')).toBeCloseTo(4000 - 320, 6)
  })

  it('is a no-op at count 1', () => {
    const baseline = h.run(slottedPlate())
    const r = h.run(slottedPlate(pattern('pt1', 'ex_slot', linear({ count: 1 }))))
    expect(h.res(r, 'pt1').status).toBe('ok')
    expect(volumeAt(r, 'pt1', 'body_ex_plate')).toBeCloseTo(
      volumeAt(baseline, 'ex_slot', 'body_ex_plate'), 6,
    )
  })
})
