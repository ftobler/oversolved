// @vitest-environment node
//
// Extrude taper (draft angle): the kernel volumes, the closed-form checks and
// the surfaces that carry the field. The builder path is the
// BRepOffsetAPI_ThruSections fallback; the LocOpe_DPrism spike at the bottom
// records why that binding is not the shipped one.
//
// Skips when OCC.js or the Rust solver is absent.

import { describe, it, expect } from 'vitest'
import type { BuildResponse } from '../../builder'
import { DisposeScope } from '../../occ/disposeScope'
import { canonicalFaces } from '../../occ/bodyNames'
import { volumeOf } from '../../occ/booleans'
import { shapeBbox } from '../../occ/faceBounds'
import type { OccModule, OccShape } from '../../occ/occTypes'
import { sketchLoopsToFace } from '../../occ/prismLineage'
import type { PlaneLike } from '../shared/planes'
import type { LoopEdge } from '../../profileLoops'
import { oc, solveBytes, extrudeTestHarness } from '../extrudeRealSupport'

interface Dict { [key: string]: unknown }

function rectSketch(id: string, plane: string, x0: number, y0: number, x1: number, y1: number): Dict {
  const lines = ['b', 'r', 't', 'l'].map((s) => ({ id: id + s, kind: 'line' }))
  return {
    id, kind: 'sketch', plane,
    entities: lines,
    initial: {
      [id + 'b']: [x0, y0, x1, y0],
      [id + 'r']: [x1, y0, x1, y1],
      [id + 't']: [x1, y1, x0, y1],
      [id + 'l']: [x0, y1, x0, y0],
    },
    constraints: [],
  }
}

function circleSketch(id: string, plane: string, circles: { id: string; at: number[] }[]): Dict {
  return {
    id, kind: 'sketch', plane,
    entities: circles.map((c) => ({ id: c.id, kind: 'circle' })),
    initial: Object.fromEntries(circles.map((c) => [c.id, c.at])),
    constraints: [],
  }
}

function extrude(id: string, sketch: string | string[], opts: Dict = {}): Dict {
  return {
    id, kind: 'extrude',
    extrude: { sketch, distance: 10, direction: 'normal', operation: 'new', ...opts },
  }
}

/** A right prismatoid: the frustum volume of a profile that scales uniformly. */
function frustumVolume(baseArea: number, topArea: number, height: number): number {
  const midArea = (baseArea + topArea + 2 * Math.sqrt(baseArea * topArea)) / 4
  return (height / 6) * (baseArea + 4 * midArea + topArea)
}

const SQ = 18
const TAPER_15_VOLUME = frustumVolume(SQ * SQ, (SQ - 2 * 10 * Math.tan(Math.PI / 12)) ** 2, 10)

describe.skipIf(!oc || !solveBytes)('extrude taper (real OCC + Rust solver)', () => {
  const h = extrudeTestHarness()

  interface Gauges {
    volume: number
    faces: number
    edges: number
    bbox: number[]
    mesh: Dict
  }

  function gauges(result: BuildResponse, featureId: string, bodyId: string): Gauges {
    const cp = result._build_state!.checkpoints[featureId]
    expect(cp, `no checkpoint for ${featureId}`).toBeDefined()
    const shape = h.table.get<OccShape>(cp.body_store_snapshot[bodyId].shape!)
    const scope = new DisposeScope()
    try {
      return {
        volume: volumeOf(oc!, scope, shape),
        faces: canonicalFaces(oc!, scope, shape).length,
        edges: ((h.body(result, bodyId).edges as unknown[]) ?? []).length,
        bbox: shapeBbox(oc!, scope, shape),
        mesh: (h.body(result, bodyId).mesh as Dict) ?? {},
      }
    } finally {
      scope.dispose()
    }
  }

  function topVertices(g: Gauges, y: number): number[][] {
    const verts = (g.mesh.vertices as number[][]) ?? []
    return verts.filter((v) => Math.abs(v[1] - y) < 0.02)
  }

  function squareTaperSpec(taper: number | string, direction = 'normal'): Dict {
    return {
      features: [
        rectSketch('sk1', '@builtin_plane_top', -SQ / 2, -SQ / 2, SQ / 2, SQ / 2),
        extrude('ex1', '@sk1', { distance: 10, taper, direction }),
      ],
    }
  }

  it('tapered square: prismatoid volume, top span and 6 faces / 12 edges', () => {
    const result = h.run(squareTaperSpec(15))
    expect(h.res(result, 'ex1').status).toBe('ok')
    const g = gauges(result, 'ex1', 'body_ex1')
    expect(g.volume).toBeCloseTo(TAPER_15_VOLUME, 4)
    expect(g.faces).toBe(6)
    expect(g.edges).toBe(12)
    const top = topVertices(g, 10)
    expect(top.length).toBeGreaterThan(0)
    expect(Math.max(...top.map((v) => v[0]))).toBeCloseTo(6.320508, 5)
    expect(Math.min(...top.map((v) => v[0]))).toBeCloseTo(-6.320508, 5)
  })

  it('tapered circle: cone frustum volume and top radius', () => {
    const result = h.run({
      features: [
        circleSketch('sk1', '@builtin_plane_top', [{ id: 'c1', at: [0, 0, 10] }]),
        extrude('ex1', '@sk1', { distance: 10, taper: 10 }),
      ],
    })
    expect(h.res(result, 'ex1').status).toBe('ok')
    const g = gauges(result, 'ex1', 'body_ex1')
    const topR = 10 - 10 * Math.tan((10 * Math.PI) / 180)
    expect(g.volume).toBeCloseTo((Math.PI * 10 / 3) * (100 + 10 * topR + topR * topR), 3)
    const top = topVertices(g, 10)
    const radius = Math.max(...top.map((v) => Math.hypot(v[0], v[2])))
    expect(radius).toBeCloseTo(topR, 4)
  })

  it('negative taper widens with sharp corners', () => {
    const result = h.run({
      features: [
        rectSketch('sk1', '@builtin_plane_top', -10, -5, 10, 5),
        extrude('ex1', '@sk1', { distance: 8, taper: -5 }),
      ],
    })
    expect(h.res(result, 'ex1').status).toBe('ok')
    const g = gauges(result, 'ex1', 'body_ex1')
    const offset = 8 * Math.tan((5 * Math.PI) / 180)
    const topX = 20 + 2 * offset
    const topZ = 10 + 2 * offset
    const midArea = (20 + offset) * (10 + offset)
    const topArea = topX * topZ
    const expected = (8 / 6) * (200 + 4 * midArea + topArea)
    expect(g.volume).toBeCloseTo(expected, 3)
    expect(g.faces).toBe(6)
    expect(((h.body(result, 'body_ex1').vertices as unknown[]) ?? []).length).toBe(8)
    const top = topVertices(g, 8)
    expect(Math.max(...top.map((v) => v[0])) - Math.min(...top.map((v) => v[0]))).toBeCloseTo(topX, 4)
    expect(Math.max(...top.map((v) => v[2])) - Math.min(...top.map((v) => v[2]))).toBeCloseTo(topZ, 4)
  })

  it('washer: the outer wall narrows and the hole widens', () => {
    const result = h.run({
      features: [
        circleSketch('sk1', '@builtin_plane_top', [
          { id: 'outer', at: [0, 0, 10] },
          { id: 'hole', at: [0, 0, 4] },
        ]),
        extrude('ex1', '@sk1', { distance: 5, taper: 10 }),
      ],
    })
    expect(h.res(result, 'ex1').status).toBe('ok')
    const g = gauges(result, 'ex1', 'body_ex1')
    const outerTop = 10 - 5 * Math.tan((10 * Math.PI) / 180)
    const holeTop = 4 + 5 * Math.tan((10 * Math.PI) / 180)
    const expected = frustumVolume(Math.PI * 100, Math.PI * outerTop ** 2, 5) -
      frustumVolume(Math.PI * 16, Math.PI * holeTop ** 2, 5)
    expect(g.volume).toBeCloseTo(expected, 3)
    expect(g.faces).toBe(4)
  })

  it('reverse direction: same volume, swept to the other side', () => {
    const result = h.run(squareTaperSpec(15, 'reverse'))
    expect(h.res(result, 'ex1').status).toBe('ok')
    const g = gauges(result, 'ex1', 'body_ex1')
    expect(g.volume).toBeCloseTo(TAPER_15_VOLUME, 4)
    expect(g.bbox[1]).toBeCloseTo(-10, 1)
    expect(g.bbox[4]).toBeCloseTo(0, 1)
  })

  it('cut: a tapered pocket removes the prismatoid volume', () => {
    const base = h.run({
      features: [
        rectSketch('sk1', '@builtin_plane_top', -20, -20, 20, 20),
        extrude('ex1', '@sk1', { distance: 20 }),
      ],
    })
    const withPocket = h.run({
      features: [
        rectSketch('sk1', '@builtin_plane_top', -20, -20, 20, 20),
        extrude('ex1', '@sk1', { distance: 20 }),
        { id: 'plTop', kind: 'plane', definition: { mode: 'offset', plane: '@builtin_plane_top', offset: 20 } },
        rectSketch('sk2', '@plTop', -10, -10, 10, 10),
        extrude('ex2', '@sk2', { distance: 10, direction: 'reverse', taper: 10, operation: 'cut', merge_target: '@body_ex1' }),
      ],
    })
    expect(h.res(withPocket, 'ex2').status).toBe('ok')
    const before = gauges(base, 'ex1', 'body_ex1').volume
    const after = gauges(withPocket, 'ex2', 'body_ex1').volume
    const bottom = 20 - 2 * 10 * Math.tan((10 * Math.PI) / 180)
    expect(before - after).toBeCloseTo(frustumVolume(400, bottom * bottom, 10), 3)
  })

  it('face profile: adding a tapered prism to the picked top face', () => {
    const first = h.run({
      features: [
        rectSketch('sk1', '@builtin_plane_top', -20, -20, 20, 20),
        extrude('ex1', '@sk1', { distance: 20 }),
      ],
    })
    expect(h.res(first, 'ex1').status).toBe('ok')
    const mesh = h.body(first, 'body_ex1').mesh as {
      face_data: { normal: number[]; surface_type?: string }[]
      face_queries: string[]
    }
    const topIndex = mesh.face_data.findIndex((f) => f.normal[1] > 0.9 && f.surface_type === 'flatface')
    expect(topIndex).toBeGreaterThanOrEqual(0)
    const topQuery = mesh.face_queries[topIndex]
    const result = h.run({
      features: [
        rectSketch('sk1', '@builtin_plane_top', -20, -20, 20, 20),
        extrude('ex1', '@sk1', { distance: 20 }),
        extrude('ex2', topQuery, { distance: 5, taper: 20, operation: 'add' }),
      ],
    })
    expect(h.res(result, 'ex2').status).toBe('ok')
    const before = gauges(first, 'ex1', 'body_ex1').volume
    const after = gauges(result, 'ex2', 'body_ex1').volume
    const topSide = 40 - 2 * 5 * Math.tan((20 * Math.PI) / 180)
    expect(after - before).toBeCloseTo(frustumVolume(1600, topSide * topSide, 5), 3)
  })

  it('a multi-group sketch tapers as one fused profile', () => {
    const result = h.run({
      features: [
        rectSketch('skA', '@builtin_plane_top', -10, -5, 0, 5),
        rectSketch('skB', '@builtin_plane_top', 0, -5, 10, 5),
        extrude('ex1', ['@skA', '@skB'], { distance: 10, taper: 10 }),
      ],
    })
    expect(h.res(result, 'ex1').status).toBe('ok')
    expect(Object.keys(result.bodies ?? {})).toEqual(['body_ex1'])
    const g = gauges(result, 'ex1', 'body_ex1')
    const offset = 10 * Math.tan((10 * Math.PI) / 180)
    const expected = (10 / 6) * (
      20 * 10 + 4 * ((20 - offset) * (10 - offset)) + (20 - 2 * offset) * (10 - 2 * offset)
    )
    expect(g.volume).toBeCloseTo(expected, 3)
  })

  it('refuses a taper that collapses the profile before the distance', () => {
    const result = h.run({
      features: [
        rectSketch('sk1', '@builtin_plane_top', -5, -5, 5, 5),
        extrude('ex1', '@sk1', { distance: 10, taper: 45 }),
      ],
    })
    const res = h.res(result, 'ex1')
    expect(res.status).toBe('exception')
    expect(String(res.exception)).toMatch(/taper 45 collapses the profile after 5\.000 of 10/)
  })

  it('taper 0 is the straight prism, byte for byte', () => {
    const plain = h.run(squareTaperSpec(0))
    const absent = h.run({
      features: [
        rectSketch('sk1', '@builtin_plane_top', -SQ / 2, -SQ / 2, SQ / 2, SQ / 2),
        extrude('ex1', '@sk1', { distance: 10 }),
      ],
    })
    expect(h.res(plain, 'ex1').status).toBe('ok')
    expect(h.res(absent, 'ex1').status).toBe('ok')
    const a = gauges(plain, 'ex1', 'body_ex1')
    const b = gauges(absent, 'ex1', 'body_ex1')
    expect(a.volume).toBeCloseTo(b.volume, 9)
    expect(a.faces).toBe(b.faces)
    expect(a.edges).toBe(b.edges)
    expect(a.mesh.face_queries).toEqual(b.mesh.face_queries)
    expect(a.mesh.edge_queries).toEqual(b.mesh.edge_queries)
  })

  it('taper as an expression follows the variable', () => {
    const spec = (expression: string): Dict => ({
      features: [
        { id: 'v_ang', kind: 'variable', label: 'ang', variable: { expression } },
        rectSketch('sk1', '@builtin_plane_top', -SQ / 2, -SQ / 2, SQ / 2, SQ / 2),
        extrude('ex1', '@sk1', { distance: 10, taper: 'ang' }),
      ],
    })
    const fifteen = h.run(spec('15'))
    expect(h.res(fifteen, 'ex1').status).toBe('ok')
    expect(gauges(fifteen, 'ex1', 'body_ex1').volume).toBeCloseTo(TAPER_15_VOLUME, 4)
    const zero = h.run(spec('0'))
    expect(h.res(zero, 'ex1').status).toBe('ok')
    expect(gauges(zero, 'ex1', 'body_ex1').volume).toBeCloseTo(3240, 4)
  })

  it('a fillet on a tapered lateral edge survives a taper edit', () => {
    const first = h.run(squareTaperSpec(15))
    expect(h.res(first, 'ex1').status).toBe('ok')
    const edgeQueries = (h.body(first, 'body_ex1').edge_queries as string[]) ?? []
    // A lateral edge carries the sketch entity ancestry; a cap-rim edge would
    // too, so strip the cap-only ones by requiring two different sketch ids.
    const lateral = edgeQueries.find((q) => q.startsWith('?') && (q.match(/@sk1\//g) ?? []).length >= 1)
    expect(lateral).toBeDefined()
    const withFillet = (taper: number): Dict => ({
      features: [
        rectSketch('sk1', '@builtin_plane_top', -SQ / 2, -SQ / 2, SQ / 2, SQ / 2),
        extrude('ex1', '@sk1', { distance: 10, taper }),
        { id: 'fi1', kind: 'fillet', fillet: { edges: [lateral], radius: 1 } },
      ],
    })
    const fifteen = h.run(withFillet(15))
    expect(h.res(fifteen, 'fi1').status).toBe('ok')
    expect(h.res(fifteen, 'fi1').unresolved_edges ?? []).toEqual([])
    const twelve = h.run(withFillet(12))
    expect(h.res(twelve, 'fi1').status).toBe('ok')
    expect(h.res(twelve, 'fi1').unresolved_edges ?? []).toEqual([])
    const faceQueries = (h.body(twelve, 'body_ex1').mesh as { face_queries?: string[] }).face_queries ?? []
    expect(faceQueries.some((q) => q.includes('@sk1/'))).toBe(true)
  })

  it('a linear pattern repeats the tapered add', () => {
    const base = (extra: Dict[]): Dict => ({
      features: [
        rectSketch('sk1', '@builtin_plane_top', -20, -20, 20, 20),
        extrude('ex1', '@sk1', { distance: 20 }),
        ...extra,
      ],
    })
    const one = h.run(base([
      { id: 'plTop', kind: 'plane', definition: { mode: 'offset', plane: '@builtin_plane_top', offset: 20 } },
      rectSketch('sk2', '@plTop', -12, -2, -8, 2),
      extrude('exBoss', '@sk2', { distance: 5, taper: 10, operation: 'add' }),
    ]))
    expect(h.res(one, 'exBoss').status).toBe('ok')
    const patterned = h.run(base([
      { id: 'plTop', kind: 'plane', definition: { mode: 'offset', plane: '@builtin_plane_top', offset: 20 } },
      rectSketch('sk2', '@plTop', -12, -2, -8, 2),
      extrude('exBoss', '@sk2', { distance: 5, taper: 10, operation: 'add' }),
      {
        id: 'pt1', kind: 'pattern',
        pattern: { subject: 'feature', source_feature: '@exBoss', mode: 'linear', count: 3, pitch: 10, direction: [1, 0, 0] },
      },
    ]))
    expect(h.res(patterned, 'pt1').status).toBe('ok')
    const board = gauges(h.run(base([])), 'ex1', 'body_ex1').volume
    const oneVolume = gauges(one, 'exBoss', 'body_ex1').volume - board
    const patternVolume = gauges(patterned, 'pt1', 'body_ex1').volume - board
    expect(patternVolume).toBeCloseTo(3 * oneVolume, 3)
  })
})

describe.skipIf(!oc)('LocOpe_DPrism spike (real OCC)', () => {
  it('a line+arc slot builds and reports a lateral face for every profile edge', () => {
    const scope = new DisposeScope()
    try {
      const occ = oc as OccModule
      const plane: PlaneLike = { origin: [0, 0, 0], x_axis: [1, 0, 0], y_axis: [0, 1, 0], normal: [0, 0, 1] }
      const slot: LoopEdge[][] = [[
        { kind: 'line', start: [-5, -5], end: [5, -5], id: 'b' },
        {
          kind: 'arc', center: [5, 0], radius: 5, angle_start_deg: -90, angle_end_deg: 90,
          ccw: true, start: [5, -5], end: [5, 5], id: 'r',
        },
        { kind: 'line', start: [5, 5], end: [-5, 5], id: 't' },
        {
          kind: 'arc', center: [-5, 0], radius: 5, angle_start_deg: 90, angle_end_deg: 270,
          ccw: true, start: [-5, 5], end: [-5, -5], id: 'l',
        },
      ]]
      const face = scope.track(sketchLoopsToFace(occ, scope, slot, plane))
      const height = 10 / Math.cos(Math.PI / 12)
      const builder = scope.track(new occ.LocOpe_DPrism_2(face, height, Math.PI / 12))
      expect(builder.IsDone()).toBe(true)
      const solid = scope.track(builder.Shape())
      expect(solid).toBeDefined()
      const E = occ.TopAbs_ShapeEnum
      const exp = scope.track(new occ.TopExp_Explorer_2(face, E.TopAbs_EDGE, E.TopAbs_SHAPE))
      let edges = 0
      for (; exp.More(); exp.Next()) {
        edges++
        const raw = scope.track(exp.Current())
        const edge = scope.track(occ.TopoDS.Edge_1(raw))
        const shapes = scope.track(builder.Shapes(edge))
        expect(shapes.Size()).toBeGreaterThan(0)
      }
      expect(edges).toBe(4)
    } finally {
      scope.dispose()
    }
  })
})
