// @vitest-environment node
//
// Axis-carrier direction picks through the real kernel: a cylinder or cone face
// as a pattern direction, and the free-end rule that decides which way along
// its own axis it points. The rule is geometric (an axis has two senses and a
// pick carries no position), so these are measured on real bodies: a blind
// bore points out of its mouth, a boss out of its top, a countersink out of its
// wide end, a through hole keeps the surface's own OCC axis sense.
//
// Directive length on a face is measured too: the face's axial extent is the
// spacing (a 12 mm deep bore spaces 12), and a circle has no length to give.
//
// Skips when OCC.js or the sketch solver is absent.

import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from '../../occ/loadOcc'
import { SharedHarness } from '../../occ/sharedHarness'
import { DisposeScope } from '../../occ/disposeScope'
import { setSketchSolver, resetSketchSolver } from '../sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { shapeBndBox } from '../../occ/primitives'
import type { OccModule, OccShape } from '../../occ/occTypes'
import type { BuildResponse } from '../../builder'
import type { Body } from '../../types3d'

const oc = await loadOcc()
const solveBytes = loadSolver()

type Dict = Record<string, unknown>

/** A fully constrained w x h rectangle on the front plane. */
function rectSketch(id: string, w: number, h: number): Dict {
  const points: [number, number][] = [[0, 0], [w, 0], [w, h], [0, h]]
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
  constraints.push({ id: 'w', kind: 'length', target: { entity: 'l0' }, value: w })
  constraints.push({ id: 'h', kind: 'length', target: { entity: 'l1' }, value: h })
  return { id, kind: 'sketch', plane: '@builtin_plane_front', entities, initial, constraints }
}

/** A single drill site. The sketch is not the subject here. */
function pointSketch(id: string, x: number, y: number, plane: string): Dict {
  return { id, kind: 'sketch', plane, entities: [{ id: 'p1', kind: 'point' }], initial: { p1: [x, y] }, constraints: [] }
}

/** A circle profile; its own underconstraint is not this suite's subject. */
function circleSketch(id: string, cx: number, cy: number, r: number, plane: string): Dict {
  return {
    id, kind: 'sketch', plane,
    entities: [{ id: 'c1', kind: 'circle' }],
    initial: { c1: [cx, cy, r] },
    constraints: [{ id: 'd1', kind: 'diameter', target: { entity: 'c1' }, value: 2 * r }],
  }
}

const extrude = (id: string, sketch: string, distance: number, operation = 'new'): Dict =>
  ({ id, kind: 'extrude', extrude: { sketch, distance, direction: 'normal', operation } })
const planeAt = (id: string, offset: number): Dict =>
  ({ id, kind: 'plane', definition: { mode: 'offset', plane: '@builtin_plane_front', offset } })
/** A blind hole drilled DOWN from the top plane at z = 10 (the sketch plane's
 *  own normal points away from the material, so the bore reverses). */
const blindHole = (id: string, sketch: string, opts: Dict): Dict =>
  ({
    id, kind: 'hole',
    hole: {
      sketch, diameter: 4, depth_mode: 'blind', depth: 8, direction: 'reverse',
      target: '@body_ex1', ...opts,
    },
  })
const throughHole = (id: string, sketch: string): Dict =>
  ({ id, kind: 'hole', hole: { sketch, diameter: 4, depth_mode: 'through_all', direction: 'normal', target: '@body_ex1' } })

const pattern = (fields: Dict): Dict =>
  ({
    id: 'lp1', kind: 'linear_pattern',
    linear_pattern: { subject: 'body', source_body: '@body_ex1', operation: 'new', count: 2, ...fields },
  })

function doc(features: Dict[], fields: Dict): Record<string, unknown> {
  return { version: 9, kind: 'part', features: [...features, pattern(fields)] }
}

interface FaceView { surface_type?: string, normal?: number[], centroid?: number[] }
interface EdgeView { kind: string, start?: number[], end?: number[], center?: number[] }
interface BodyView {
  mesh?: { face_data?: FaceView[], face_queries?: string[] }
  edges?: EdgeView[]
  edge_queries?: string[]
}

describe.skipIf(!oc || !solveBytes)('axis carrier directions through the real kernel', () => {
  const h = new SharedHarness(oc!)
  const occ = oc as OccModule

  beforeAll(() => {
    if (!oc || !solveBytes) throw new Error('unreachable: skipIf guards this')
    resetSketchSolver()
    setSketchSolver(solveBytes)
  })

  const viewOf = (r: BuildResponse, bodyId = 'body_ex1'): BodyView => h.body(r, bodyId) as BodyView

  function faceQuery(r: BuildResponse, type: string): string {
    const mesh = viewOf(r).mesh
    const index = (mesh?.face_data ?? []).findIndex((fd) => fd.surface_type === type)
    if (index < 0) throw new Error(`no ${type} face on the body; have ${JSON.stringify((mesh?.face_data ?? []).map((fd) => fd.surface_type))}`)
    return mesh?.face_queries?.[index] ?? ''
  }

  function circleEdgeQuery(r: BuildResponse): string {
    const view = viewOf(r)
    const index = (view.edges ?? []).findIndex((edge) => edge.kind === 'circle')
    if (index < 0) throw new Error('no circular edge on the body')
    return view.edge_queries?.[index] ?? ''
  }

  function boxes(r: BuildResponse): number[][] {
    const store = r._build_state!.checkpoints.lp1.body_store_snapshot as Record<string, Body>
    const scope = new DisposeScope()
    try {
      return Object.values(store).map((body) => {
        const box = shapeBndBox(occ, scope, h.table.get<OccShape>(body.shape!))
        return [...box.min, ...box.max]
      })
    } finally {
      scope.dispose()
    }
  }

  const round = (b: number[][]): number[][] =>
    b.map((box) => box.map((n) => {
      const rounded = Math.round(n * 1e6) / 1e6
      return rounded === 0 ? 0 : rounded
    })).sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2])

  /** The block 20 x 20 x height with one hole from its top face, and a probe
   *  build that exposes the hole's faces to pick. */
  function blockWithHole(hole: Dict, sketch: Dict, height = 10): Dict[] {
    return [rectSketch('sk1', 20, 20), extrude('ex1', '@sk1', height), planeAt('pl1', height), sketch, hole]
  }

  it('a blind bore points out of its mouth', () => {
    const bore = blindHole('h1', '@sk2', { depth: 6 })
    const probe = h.run({ version: 9, kind: 'part', features: blockWithHole(bore, pointSketch('sk2', 10, 10, '@pl1')) })
    const query = faceQuery(probe, 'cylinderface')
    const r = h.run(doc(blockWithHole(bore, pointSketch('sk2', 10, 10, '@pl1')), {
      count: 2, pitch: 20, direction_query: query,
    }))
    expect(h.res(r, 'lp1').status).toBe('ok')
    // Out of the mouth is +Z, so the copy sits above the source block.
    expect(round(boxes(r))).toEqual([
      [0, 0, 0, 20, 20, 10],
      [0, 0, 20, 20, 20, 30],
    ])
  })

  it('a boss cylinder points out of its top, not its base', () => {
    const features = [
      rectSketch('sk1', 30, 30),
      extrude('ex1', '@sk1', 5),
      planeAt('pl1', 5),
      circleSketch('sk2', 15, 15, 4, '@pl1'),
      extrude('ex2', '@sk2', 10, 'add'),
    ]
    const probe = h.run({ version: 9, kind: 'part', features })
    const query = faceQuery(probe, 'cylinderface')
    const r = h.run(doc(features, { count: 2, pitch: 20, direction_query: query }))
    expect(h.res(r, 'lp1').status).toBe('ok')
    expect(round(boxes(r))).toEqual([
      [0, 0, 0, 30, 30, 15],
      [0, 0, 20, 30, 30, 35],
    ])
  })

  it('a countersink cone points out of its wide end, and its length is the cone height', () => {
    const bore = blindHole('h1', '@sk2', { depth: 8, style: 'countersink', cb_diameter: 8, cs_angle: 90 })
    const features = blockWithHole(bore, pointSketch('sk2', 10, 10, '@pl1'))
    const probe = h.run({ version: 9, kind: 'part', features })
    const query = faceQuery(probe, 'coneface')
    const toward = h.run(doc(features, { count: 2, pitch: 20, direction_query: query }))
    expect(h.res(toward, 'lp1').status).toBe('ok')
    expect(round(boxes(toward))).toEqual([
      [0, 0, 0, 20, 20, 10],
      [0, 0, 20, 20, 20, 30],
    ])
    // The 90 degree countersink widens from the 4 mm bore to 8 mm over 2 mm of
    // axial height; directive length spaces the copies by that height.
    const spaced = h.run(doc(features, { count: 2, direction_mode: 'directive_length', direction_query: query }))
    const res = h.res(spaced, 'lp1')
    expect(res.status).toBe('ok')
    expect(res.resolved_pitch as number).toBeCloseTo(2, 6)
    expect(round(boxes(spaced))).toEqual([
      [0, 0, 0, 20, 20, 10],
      [0, 0, 2, 20, 20, 12],
    ])
  })

  it('directive length on a 12 mm deep bore spaces 12', () => {
    const bore = blindHole('h1', '@sk2', { depth: 12 })
    const features = blockWithHole(bore, pointSketch('sk2', 10, 10, '@pl1'), 30)
    const probe = h.run({ version: 9, kind: 'part', features })
    const query = faceQuery(probe, 'cylinderface')
    const r = h.run(doc(features, { count: 2, direction_mode: 'directive_length', direction_query: query }))
    const res = h.res(r, 'lp1')
    expect(res.status, String(res.exception)).toBe('ok')
    expect(res.resolved_pitch as number).toBeCloseTo(12, 6)
    expect(round(boxes(r))).toEqual([
      [0, 0, 0, 20, 20, 30],
      [0, 0, 12, 20, 20, 42],
    ])
  })

  it('a through hole keeps the OCC axis sense, unchanged over a re-solve', () => {
    const features = blockWithHole(throughHole('h1', '@sk2'), pointSketch('sk2', 10, 10, '@pl1'))
    const probe = h.run({ version: 9, kind: 'part', features })
    const query = faceQuery(probe, 'cylinderface')
    const first = h.run(doc(features, { count: 2, pitch: 15, direction_query: query }))
    const firstBox = round(boxes(first))
    expect(firstBox).toHaveLength(2)
    // Both ends are free, so the sense is whatever the surface's own axis says;
    // it is not this test's business which one, only that it is one axis sense
    // and that a rebuild does not flip it.
    const offset = firstBox[1][2] - firstBox[0][2]
    expect(Math.abs(offset)).toBeCloseTo(15, 6)
    const again = h.run(doc(features, { count: 2, pitch: 15, direction_query: query }), {
      prevState: first._build_state,
    })
    expect(round(boxes(again))).toEqual(firstBox)
  })

  it('refuses a circle as a directive-length pick by name', () => {
    const features = blockWithHole(throughHole('h1', '@sk2'), pointSketch('sk2', 10, 10, '@pl1'))
    const probe = h.run({ version: 9, kind: 'part', features })
    const query = circleEdgeQuery(probe)
    // A circular edge's query carries the generic edge restriction.
    expect(query).toContain(':edge')
    const r = h.run(doc(features, { count: 2, direction_mode: 'directive_length', direction_query: query }))
    expect(String(h.res(r, 'lp1').exception ?? '')).toContain('a circle has none')
  })

  it('keeps a planar face pick as the direction it always was', () => {
    const probe = h.run({ version: 9, kind: 'part', features: blockWithHole(blindHole('h1', '@sk2', { depth: 6 }), pointSketch('sk2', 10, 10, '@pl1')) })
    // The top face's outward normal is +Z; the widening must not change it.
    const mesh = viewOf(probe).mesh
    const index = (mesh?.face_data ?? []).findIndex((fd) => fd.surface_type === 'flatface' && (fd.normal?.[2] ?? 0) > 0.9)
    const query = mesh?.face_queries?.[index] ?? ''
    const r = h.run(doc(blockWithHole(blindHole('h1', '@sk2', { depth: 6 }), pointSketch('sk2', 10, 10, '@pl1')), {
      count: 2, pitch: 7, direction_query: query,
    }))
    expect(round(boxes(r))).toEqual([
      [0, 0, 0, 20, 20, 10],
      [0, 0, 7, 20, 20, 17],
    ])
  })
})
