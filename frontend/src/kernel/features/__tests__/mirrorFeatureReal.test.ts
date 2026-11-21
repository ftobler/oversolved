// @vitest-environment node
//
// The mirror's feature subject through the production builder (SharedHarness):
// the same reapplication a feature pattern uses, with ONE reflection instance.
// It pins the geometry a mirrored cut or add really removes or adds across a
// plane, the union of several sources, the coincidence warning when a source is
// symmetric about the plane, the lineage names (stable across a re-solve and
// disjoint from a pattern's), and the refusals that name their fix.
//
// Skips when OCC.js or the sketch solver is absent.

import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from '../../occ/loadOcc'
import { SharedHarness } from '../../occ/sharedHarness'
import { DisposeScope } from '../../occ/disposeScope'
import { setSketchSolver, resetSketchSolver } from '../sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { volumeOf } from '../../occ/volume'
import { canonicalFaces } from '../../occ/partNames'
import { parseAncestry } from '../../query'
import type { OccModule, OccShape } from '../../occ/occTypes'
import type { BuildResponse } from '../../builder'
import type { PartSolid } from '../../types3d'

const oc = await loadOcc()
const solveBytes = loadSolver()

type Dict = Record<string, unknown>

interface FaceDatum {
  centroid: number[]
  normal: number[]
  surface_type?: string
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

function rectSketch(id: string, w: number, h: number, x0 = 0, y0 = 0, plane = '@builtin_plane_front'): Dict {
  return polySketch(id, [[x0, y0], [x0 + w, y0], [x0 + w, y0 + h], [x0, y0 + h]], plane)
}

function circleSketch(id: string, cx: number, cy: number, r: number, plane = '@builtin_plane_front'): Dict {
  return {
    id, kind: 'sketch', plane,
    entities: [{ id: 'c1', kind: 'circle' }],
    initial: { c1: [cx, cy, r] },
    constraints: [{ id: 'r1', kind: 'radius', target: { entity: 'c1' } }],
  }
}

function extrude(id: string, sketch: string, distance: number, operation = 'new'): Dict {
  return { id, kind: 'extrude', extrude: { sketch, distance, direction: 'normal', operation } }
}

// The plate's mid plane: @builtin_plane_right sits at x = 0 with +X normal, so
// a 20 mm offset is x = 20, the middle of the 40 wide plate.
const midPlane = (): Dict => ({
  id: 'pl_mid', kind: 'plane',
  definition: { mode: 'offset', plane: '@builtin_plane_right', offset: 20 },
})

function featureMirror(fields: Dict = {}): Dict {
  return {
    id: 'mi1', kind: 'mirror',
    mirror: { subject: 'feature', source_features: ['@ex_hole'], plane: '@pl_mid', ...fields },
  }
}

// A 40 x 20 x 5 plate with one off-centre through hole at (10, 10), r3.
function holedPlate(mirrorFeature: Dict | null = null): { features: Dict[] } {
  return {
    features: [
      rectSketch('sk_plate', 40, 20),
      extrude('ex_plate', '$sk_plate', 5),
      circleSketch('sk_hole', 10, 10, 3),
      extrude('ex_hole', '$sk_hole', 10, 'cut'),
      midPlane(),
      ...(mirrorFeature === null ? [] : [mirrorFeature]),
    ],
  }
}

describe.skipIf(!oc || !solveBytes)('the mirror feature subject through the builder (real OCC + Rust solver)', () => {
  const h = new SharedHarness(oc!)
  const occ = oc as OccModule

  beforeAll(() => {
    if (!oc || !solveBytes) throw new Error('unreachable: skipIf guards this')
    resetSketchSolver()
    setSketchSolver(solveBytes)
  })

  function snapshot(r: BuildResponse, featureId: string): Record<string, PartSolid> {
    return r._build_state!.checkpoints[featureId].body_store_snapshot as Record<string, PartSolid>
  }
  function shapeAt(r: BuildResponse, featureId: string, partId: string): OccShape {
    return h.table.get<OccShape>(snapshot(r, featureId)[partId].shape!)
  }
  function volumeAt(r: BuildResponse, featureId: string, partId: string): number {
    const scope = new DisposeScope()
    try { return volumeOf(occ, scope, shapeAt(r, featureId, partId)) } finally { scope.dispose() }
  }
  function faceCountAt(r: BuildResponse, featureId: string, partId: string): number {
    const scope = new DisposeScope()
    try { return canonicalFaces(occ, scope, shapeAt(r, featureId, partId)).length } finally { scope.dispose() }
  }
  function faceData(r: BuildResponse, partId: string): FaceDatum[] {
    const mesh = (h.part(r, partId).mesh ?? {}) as { face_data?: FaceDatum[] }
    return mesh.face_data ?? []
  }
  function liveFaceUuids(r: BuildResponse, partId: string): string[] {
    const mesh = (h.part(r, partId).mesh ?? {}) as { face_queries?: string[] }
    return (mesh.face_queries ?? []).map(uuidTokenOf).filter((u): u is string => u !== undefined)
  }

  it('mirrors a cut feature and removes the same hole a second time', () => {
    const baseline = h.run(holedPlate())
    const r = h.run(holedPlate(featureMirror()))
    const res = h.res(r, 'mi1')
    expect(res.status, String(res.exception)).toBe('ok')
    expect(res.operation).toBe('cut')
    expect(res.body_ids).toEqual(['body_ex_plate'])
    // One hole before, two after, both through the 5 thick plate.
    expect(volumeAt(baseline, 'ex_hole', 'body_ex_plate')).toBeCloseTo(4000 - Math.PI * 9 * 5, 5)
    expect(volumeAt(r, 'mi1', 'body_ex_plate')).toBeCloseTo(4000 - 2 * Math.PI * 9 * 5, 5)
    expect(faceCountAt(r, 'mi1', 'body_ex_plate')).toBe(6 + 2)
    // The source sits at x 10, its mirror at x 30.
    const bores = faceData(r, 'body_ex_plate').filter((face) => face.surface_type === 'cylinderface')
    expect(bores).toHaveLength(2)
    expect(bores.map((face) => face.centroid[0]).sort((a, b) => a - b)).toEqual([
      expect.closeTo(10, 5), expect.closeTo(30, 5),
    ])
  })

  it('mirrors an add feature into the same body', () => {
    const r = h.run({
      features: [
        rectSketch('sk_plate', 40, 20),
        extrude('ex_plate', '$sk_plate', 4),
        // The boss sits on the plate's top face, at (10, 10).
        { id: 'pl_top', kind: 'plane', definition: { mode: 'offset', plane: '@builtin_plane_front', offset: 4 } },
        circleSketch('sk_boss', 10, 10, 2, '@pl_top'),
        extrude('ex_boss', '$sk_boss', 3, 'add'),
        midPlane(),
        featureMirror({ source_features: ['@ex_boss'] }),
      ],
    })
    const res = h.res(r, 'mi1')
    expect(res.status, String(res.exception)).toBe('ok')
    expect(res.body_ids).toEqual(['body_ex_plate'])
    // 40 x 20 x 4 plate plus two r2 h3 bosses.
    expect(volumeAt(r, 'mi1', 'body_ex_plate')).toBeCloseTo(3200 + 2 * Math.PI * 4 * 3, 4)
  })

  it('mirrors several sources as the union of their tools', () => {
    const r = h.run({
      features: [
        rectSketch('sk_plate', 40, 20),
        extrude('ex_plate', '$sk_plate', 5),
        rectSketch('sk_slot_a', 4, 4, 6, 2),
        extrude('ex_slot_a', '$sk_slot_a', 10, 'cut'),
        rectSketch('sk_slot_b', 4, 4, 6, 14),
        extrude('ex_slot_b', '$sk_slot_b', 10, 'cut'),
        midPlane(),
        featureMirror({ source_features: ['@ex_slot_a', '@ex_slot_b'] }),
      ],
    })
    const res = h.res(r, 'mi1')
    expect(res.status, String(res.exception)).toBe('ok')
    expect(res.body_ids).toEqual(['body_ex_plate'])
    // Four slots in all: the two sources plus one mirrored copy of each.
    expect(volumeAt(r, 'mi1', 'body_ex_plate')).toBeCloseTo(4000 - 4 * 80, 6)
    expect(faceCountAt(r, 'mi1', 'body_ex_plate')).toBe(6 + 4 * 4)
  })

  it('mirrors a sweep source', () => {
    // A 2 x 2 bar swept along +X from x 5 to 15 on the front plane, profile on
    // the right plane. Half the bar sits inside the 5 thick plate, so the fused
    // source adds 20 (40 bar minus 20 overlap); the mirrored bar adds 20 more.
    const r = h.run({
      features: [
        rectSketch('sk_plate', 40, 20),
        extrude('ex_plate', '$sk_plate', 5),
        // The right-plane origin is x = 0, so the profile sits at x = 5.
        { id: 'pl_prof', kind: 'plane', definition: { mode: 'offset', plane: '@builtin_plane_right', offset: 5 } },
        rectSketch('sk_prof', 2, 2, -1, 9, '@pl_prof'),
        { id: 'sk_path', kind: 'sketch', plane: '@builtin_plane_front',
          entities: [{ id: 'p1', kind: 'line' }], initial: { p1: [5, 10, 15, 10] },
          constraints: [{ id: 'h1', kind: 'horizontal', target: { entity: 'p1' } }] },
        {
          id: 'ex_sweep', kind: 'sweep',
          sweep: { sketch: ['@sk_prof'], path: ['@sk_path'], transition: 'mitre', operation: 'add' },
        },
        midPlane(),
        featureMirror({ source_features: ['@ex_sweep'] }),
      ],
    })
    const res = h.res(r, 'mi1')
    expect(res.status, String(res.exception)).toBe('ok')
    expect(volumeAt(r, 'mi1', 'body_ex_plate')).toBeCloseTo(4000 + 40, 4)
    expect(res.body_ids).toEqual(['body_ex_plate'])
  })

  it('asks for target_body when a source touched more than one body', () => {
    // A slot from x 6 to 24 crosses both blocks: it cuts 6..10 out of A and
    // 20..24 out of B. The mirror plane at x = 5 maps the slot to -14..4, so
    // the copy cuts a different 0..4 strip out of A.
    const features = (target?: string): Dict[] => [
      rectSketch('sk_a', 10, 10),
      extrude('ex_a', '$sk_a', 5),
      rectSketch('sk_b', 10, 10, 20, 0),
      extrude('ex_b', '$sk_b', 5),
      rectSketch('sk_cut', 18, 2, 6, 4),
      extrude('ex_cut', '$sk_cut', 3, 'cut'),
      { id: 'pl_five', kind: 'plane', definition: { mode: 'offset', plane: '@builtin_plane_right', offset: 5 } },
      featureMirror({
        source_features: ['@ex_cut'], plane: '@pl_five',
        ...(target === undefined ? {} : { target_body: target }),
      }),
    ]
    const ambiguous = h.run({ features: features() })
    const message = String(h.res(ambiguous, 'mi1').exception)
    expect(message).toContain('touched 2 parts')
    expect(message).toContain('target_body')
    expect(message).toContain('body_ex_a')
    expect(message).toContain('body_ex_b')

    const named = h.run({ features: features('@body_ex_a') })
    const res = h.res(named, 'mi1')
    expect(res.status, String(res.exception)).toBe('ok')
    expect(res.body_ids).toEqual(['body_ex_a'])
    // A: 500 minus the source 4 x 2 x 3 strip and the mirrored one.
    expect(volumeAt(named, 'mi1', 'body_ex_a')).toBeCloseTo(500 - 24 - 24, 6)
    // B keeps only the source's own cut.
    expect(volumeAt(named, 'mi1', 'body_ex_b')).toBeCloseTo(500 - 24, 6)
  })

  it('warns instead of failing when a source is symmetric about the plane', () => {
    const r = h.run({
      features: [
        rectSketch('sk_plate', 40, 20),
        extrude('ex_plate', '$sk_plate', 5),
        // 4 wide, centred on x = 20: its reflection is itself.
        rectSketch('sk_slot', 4, 4, 18, 8),
        extrude('ex_slot', '$sk_slot', 10, 'cut'),
        midPlane(),
        featureMirror({ source_features: ['@ex_slot'] }),
      ],
    })
    const res = h.res(r, 'mi1')
    expect(res.status).toBe('ok')
    expect(res.exception).toBeUndefined()
    expect(String(res.solver_warning)).toContain("the mirrored feature 'ex_slot' coincides with the original")
    expect(String(res.solver_warning)).toContain('nothing changed')
    // The source's own cut is the only one.
    expect(volumeAt(r, 'mi1', 'body_ex_plate')).toBeCloseTo(4000 - 80, 6)
    expect(res.body_ids).toEqual(['body_ex_plate'])
  })

  it('follows a later edit of the source feature', () => {
    const spec = (holeX: number): { features: Dict[] } => ({
      features: [
        rectSketch('sk_plate', 40, 20),
        extrude('ex_plate', '$sk_plate', 5),
        circleSketch('sk_hole', holeX, 10, 3),
        extrude('ex_hole', '$sk_hole', 10, 'cut'),
        midPlane(),
        featureMirror(),
      ],
    })
    const r = h.run(spec(5))
    expect(h.res(r, 'mi1').status, String(h.res(r, 'mi1').exception)).toBe('ok')
    const bores = faceData(r, 'body_ex_plate').filter((face) => face.surface_type === 'cylinderface')
    // The source moved to x 5, so its mirrored copy moved to x 35.
    expect(bores.map((face) => face.centroid[0]).sort((a, b) => a - b)).toEqual([
      expect.closeTo(5, 5), expect.closeTo(35, 5),
    ])
  })

  it('keeps the mirrored copy UUIDs stable across a re-solve', () => {
    const first = h.run(holedPlate(featureMirror()))
    const second = h.run(holedPlate(featureMirror()))
    expect(h.res(first, 'mi1').status).toBe('ok')
    expect(liveFaceUuids(second, 'body_ex_plate')).toEqual(liveFaceUuids(first, 'body_ex_plate'))
  })

  it('mints mirrored copy UUIDs disjoint from an equivalent pattern copy', () => {
    const baselineUuids = new Set(liveFaceUuids(h.run(holedPlate()), 'body_ex_plate'))
    const mirrored = liveFaceUuids(h.run(holedPlate(featureMirror())), 'body_ex_plate')
      .filter((uuid) => !baselineUuids.has(uuid))
    // A linear pattern at pitch 20 lands the copy at the same x = 30, so only
    // the construction path can tell the two copies apart.
    const patterned = h.run({
      features: [
        ...holedPlate().features,
        {
          id: 'pt1', kind: 'linear_pattern',
          linear_pattern: {
            subject: 'feature', source_features: ['@ex_hole'],
            count: 2, pitch: 20, direction: [1, 0, 0],
          },
        },
      ],
    })
    expect(h.res(patterned, 'pt1').status).toBe('ok')
    const patternUuids = liveFaceUuids(patterned, 'body_ex_plate')
      .filter((uuid) => !baselineUuids.has(uuid))
    expect(mirrored.length).toBeGreaterThanOrEqual(1)
    expect(patternUuids.length).toBeGreaterThanOrEqual(1)
    expect(mirrored.filter((uuid) => patternUuids.includes(uuid))).toEqual([])
  })

  it('refuses the whole-body flags by name on a feature mirror', () => {
    for (const field of ['keep_original', 'merge'] as const) {
      const r = h.run(holedPlate(featureMirror({ [field]: true })))
      const message = String(h.res(r, 'mi1').exception)
      expect(message).toContain(`${field} means nothing for a feature mirror`)
      expect(message).toContain('the original always stays')
    }
  })

  it('refuses a source that is not an extrude, revolve, sweep or wrap', () => {
    const r = h.run(holedPlate(featureMirror({ source_features: ['@sk_plate'] })))
    const message = String(h.res(r, 'mi1').exception)
    expect(message).toContain("'sk_plate' is a sketch")
    expect(message).toContain('a mirror source repeats an extrude, revolve, sweep, wrap or hole')
  })

  it('leaves the body subject unchanged when the subject is absent', () => {
    const r = h.run({
      features: [
        rectSketch('sk_plate', 10, 10),
        extrude('ex_plate', '$sk_plate', 5),
        midPlane(),
        {
          id: 'mi1', kind: 'mirror',
          mirror: { body: '@body_ex_plate', plane: '@pl_mid', keep_original: true, merge: true },
        },
      ],
    })
    const res = h.res(r, 'mi1')
    expect(res.status).toBe('ok')
    // The reflection is disjoint from the source, so the fuse leaves two parts.
    expect(res.body_ids).toHaveLength(2)
  })
})
