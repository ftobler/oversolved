// @vitest-environment node
//
// The wrap leaf through the production builder: real OCC plus the Rust sketch
// solver. A cylinder of radius R about world Y (a Top circle extruded up) is the
// target; footprints are drawn on Front, the plane through its axis, so a sketch
// x is the arc around and a sketch y the height. Volumes are closed forms in the
// cylinder's own coordinates: a W x L rectangle (W around, at radius R) raised h
// adds L * (W / (2R)) * ((R + h)^2 - R^2), the exact annular sector.
//
// Skips when OCC.js or the Rust solver is absent.

import { describe, it, expect } from 'vitest'
import type { BuildResponse } from '../../builder'
import { DisposeScope } from '../../occ/disposeScope'
import { shapeBbox } from '../../occ/faceBounds'
import { volumeForMeasure } from '../../occ/volume'
import type { OccShape } from '../../occ/occTypes'
import { oc, solveBytes, extrudeTestHarness } from '../extrudeRealSupport'
import { WRAP_AXIS_PERPENDICULAR } from '../wrapMath'
import { splitPatternDef } from '@/utils/core/patternSplit'

type Dict = Record<string, unknown>

const R = 10
const HEIGHT = 30

/** A counter-clockwise rectangle with one line per side, `holes` inside it. */
function rectSketch(id: string, plane: string, x0: number, y0: number, x1: number, y1: number, holes: number[][] = []): Dict {
  const entities: Dict[] = ['b', 'r', 't', 'l'].map((s) => ({ id: id + s, kind: 'line' }))
  const initial: Record<string, number[]> = {
    [id + 'b']: [x0, y0, x1, y0],
    [id + 'r']: [x1, y0, x1, y1],
    [id + 't']: [x1, y1, x0, y1],
    [id + 'l']: [x0, y1, x0, y0],
  }
  holes.forEach(([hx0, hy0, hx1, hy1], k) => {
    const p = `${id}h${k}`
    for (const s of ['b', 'r', 't', 'l']) entities.push({ id: p + s, kind: 'line' })
    initial[p + 'b'] = [hx0, hy0, hx1, hy0]
    initial[p + 'r'] = [hx1, hy0, hx1, hy1]
    initial[p + 't'] = [hx1, hy1, hx0, hy1]
    initial[p + 'l'] = [hx0, hy1, hx0, hy0]
  })
  return { id, kind: 'sketch', plane, entities, initial, constraints: [] }
}

function circleSketch(id: string, plane: string, cx: number, cy: number, r: number, inner?: number): Dict {
  const entities: Dict[] = [{ id: id + 'c', kind: 'circle' }]
  const initial: Record<string, number[]> = { [id + 'c']: [cx, cy, r] }
  if (inner !== undefined) {
    entities.push({ id: id + 'i', kind: 'circle' })
    initial[id + 'i'] = [cx, cy, inner]
  }
  return { id, kind: 'sketch', plane, entities, initial, constraints: [] }
}

/** The cylinder (or a tube with an `inner` bore) about +Y, y from 0 to HEIGHT. */
function cylinder(inner?: number, outer = R): Dict[] {
  return [
    circleSketch('skc', '@builtin_plane_top', 0, 0, outer, inner),
    { id: 'ex1', kind: 'extrude', extrude: { sketch: '@skc', distance: HEIGHT, direction: 'normal', operation: 'new' } },
  ]
}

function wrap(id: string, sketch: string, target: string | undefined, opts: Dict = {}): Dict {
  return { id, kind: 'wrap', wrap: { sketch, height: 1, operation: 'add', ...(target ? { target } : {}), ...opts } }
}

const sector = (w: number, l: number, r: number, h: number, sign = 1): number =>
  l * (w / (2 * r)) * (sign > 0 ? (r + h) ** 2 - r ** 2 : r ** 2 - (r - h) ** 2)

// Each case runs two or three full solves through real OCC; under the parallel
// gate the torus pattern case ran past vitest's 5 s default.
describe.skipIf(!oc || !solveBytes)('wrap (real OCC + Rust solver)', { timeout: 60_000 }, () => {
  const h = extrudeTestHarness()

  /** The face queries of one surface kind on a body, nearest-radius first when
   *  several (a tube's bore and skin). */
  function faceQueries(result: BuildResponse, bodyId: string, kind: string): string[] {
    const mesh = h.body(result, bodyId).mesh as { face_data: { surface_type?: string; centroid: number[] }[]; face_queries: string[] }
    return mesh.face_data
      .map((f, i) => ({ f, q: mesh.face_queries[i] }))
      .filter(({ f }) => f.surface_type === kind)
      .sort((a, b) => Math.hypot(a.f.centroid[0], a.f.centroid[2]) - Math.hypot(b.f.centroid[0], b.f.centroid[2]))
      .map(({ q }) => q)
  }

  function shapeOf(result: BuildResponse, featureId: string, bodyId: string): OccShape {
    const cp = result._build_state!.checkpoints[featureId]
    expect(cp, `no checkpoint for ${featureId}`).toBeDefined()
    return h.table.get<OccShape>(cp.body_store_snapshot[bodyId].shape!)
  }

  function gauges(result: BuildResponse, featureId: string, bodyId: string) {
    const shape = shapeOf(result, featureId, bodyId)
    const scope = new DisposeScope()
    try {
      return {
        volume: volumeForMeasure(oc!, scope, shape),
        bbox: shapeBbox(oc!, scope, shape),
        valid: scope.track(new oc!.BRepCheck_Analyzer(shape, true, false, false)).IsValid_2(),
      }
    } finally {
      scope.dispose()
    }
  }

  // The skin query of the plain cylinder; queries are position independent, so
  // one base solve names the face for every doc below.
  function skin(inner?: number): string {
    const base = h.run({ features: cylinder(inner) })
    const qs = faceQueries(base, 'body_ex1', 'cylinderface')
    expect(qs.length).toBe(inner === undefined ? 1 : 2)
    return inner === undefined ? qs[0] : qs[qs.length - 1]
  }
  const cylVolume = (inner = 0): number => Math.PI * (R * R - inner * inner) * HEIGHT

  it('a rectangle raised on a cylinder adds the exact annular sector and names its walls', () => {
    const target = skin()
    const result = h.run({
      features: [...cylinder(), rectSketch('skw', '@builtin_plane_front', -4, 9, 4, 21), wrap('wr1', '@skw', target)],
    })
    expect(h.res(result, 'wr1').status).toBe('ok')
    const g = gauges(result, 'wr1', 'body_ex1')
    expect(g.valid).toBe(true)
    expect(Math.abs(g.volume - (cylVolume() + sector(8, 12, R, 1))) / sector(8, 12, R, 1)).toBeLessThan(1e-6)
    // Each footprint edge keeps its own name on its wall.
    const mesh = h.body(result, 'body_ex1').mesh as { face_queries: string[] }
    for (const side of ['b', 'r', 't', 'l']) {
      expect(mesh.face_queries.some((q) => q.includes(`@skw/skw${side}`)), side).toBe(true)
    }
    // The pad sits on the facing side (+Z) and reaches R + h.
    expect(g.bbox[5]).toBeCloseTo(R + 1, 6)
  })

  it('each named wall stands on its own side of the footprint', () => {
    const target = skin()
    const result = h.run({
      features: [...cylinder(), rectSketch('skw', '@builtin_plane_front', -4, 9, 4, 21), wrap('wr1', '@skw', target, { operation: 'new' })],
    })
    const mesh = h.body(result, 'body_wr1').mesh as { face_data: { centroid: number[] }[]; face_queries: string[] }
    // A cap's query names every entity of the loop; a wall names its own only.
    const sides = ['b', 'r', 't', 'l']
    const centroidOf = (side: string): number[] => {
      const i = mesh.face_queries.findIndex((q) =>
        q.includes(`@skw/skw${side}`) && sides.every((other) => other === side || !q.includes(`@skw/skw${other}`)))
      expect(i, side).toBeGreaterThanOrEqual(0)
      return mesh.face_data[i].centroid
    }
    // Bottom and top walls sit at the footprint's y ends; left and right at -X
    // and +X of the facing generatrix.
    expect(centroidOf('b')[1]).toBeCloseTo(9, 3)
    expect(centroidOf('t')[1]).toBeCloseTo(21, 3)
    expect(centroidOf('l')[0]).toBeLessThan(-3)
    expect(centroidOf('r')[0]).toBeGreaterThan(3)
  })

  it('a height expression follows its variable', () => {
    const target = skin()
    const result = h.run({
      features: [
        { id: 'v_t', kind: 'variable', label: 't', variable: { expression: '1 + 1' } },
        ...cylinder(), rectSketch('skw', '@builtin_plane_front', -4, 9, 4, 21),
        wrap('wr1', '@skw', target, { operation: 'new', height: 't' }),
      ],
    })
    expect(h.res(result, 'wr1').status).toBe('ok')
    expect(Math.abs(gauges(result, 'wr1', 'body_wr1').volume - sector(8, 12, R, 2)) / sector(8, 12, R, 2)).toBeLessThan(1e-6)
  })

  it('a cut into a tube bore removes the sector outward of it', () => {
    const inner = 6
    const base = h.run({ features: cylinder(inner) })
    const bore = faceQueries(base, 'body_ex1', 'cylinderface')[0]
    const result = h.run({
      features: [...cylinder(inner), rectSketch('skw', '@builtin_plane_front', -3, 9, 3, 21), wrap('wr1', '@skw', bore, { operation: 'cut', height: 1 })],
    })
    expect(h.res(result, 'wr1').status).toBe('ok')
    const g = gauges(result, 'wr1', 'body_ex1')
    expect(g.valid).toBe(true)
    expect(Math.abs(g.volume - (cylVolume(inner) - sector(6, 12, inner, 1))) / sector(6, 12, inner, 1)).toBeLessThan(1e-6)
  })

  it('a cone target builds the closed-form volume about the reference parallel', () => {
    // A Top circle of radius 20 extruded 20 with taper 10 narrows upward: a cone
    // face whose radius at height y is 20 - y tan(10).
    const coneDoc: Dict[] = [
      circleSketch('skc', '@builtin_plane_top', 0, 0, 20),
      { id: 'ex1', kind: 'extrude', extrude: { sketch: '@skc', distance: 20, direction: 'normal', operation: 'new', taper: 10 } },
    ]
    const base = h.run({ features: coneDoc })
    const cone = faceQueries(base, 'body_ex1', 'coneface')[0]
    const result = h.run({
      features: [...coneDoc, rectSketch('skw', '@builtin_plane_front', -3, 8, 3, 12), wrap('wr1', '@skw', cone, { operation: 'new', height: 1 })],
    })
    expect(h.res(result, 'wr1').status).toBe('ok')
    const alpha = (10 * Math.PI) / 180
    // The footprint's axial 4 is slant arc length; r0 is the radius at y = 10.
    const r0 = 20 - 10 * Math.tan(alpha)
    const want = (6 / r0) * 4 * 1 * (r0 + Math.cos(alpha) / 2)
    expect(Math.abs(gauges(result, 'wr1', 'body_wr1').volume - want) / want).toBeLessThan(1e-5)
  })

  it('a sphere target builds the spherical cap shell', () => {
    // A full circle plus its diameter revolves into a sphere of radius R.
    const ball: Dict[] = [
      {
        id: 'sks', kind: 'sketch', plane: '@builtin_plane_front',
        entities: [{ id: 'c1', kind: 'circle' }, { id: 'ax', kind: 'line' }],
        initial: { c1: [0, 0, R], ax: [0, -R, 0, R] },
        constraints: [],
      },
      { id: 'rv1', kind: 'revolve', revolve: { sketch: '@sks', angle: 360, axis: '@sks/ax', operation: 'new' } },
    ]
    const base = h.run({ features: ball })
    const sphere = faceQueries(base, 'body_rv1', 'sphereface')[0]
    expect(sphere).toBeDefined()
    const result = h.run({
      features: [...ball, circleSketch('skw', '@builtin_plane_front', 0, 0, 4), wrap('wr1', '@skw', sphere, { operation: 'new', height: 1 })],
    })
    expect(h.res(result, 'wr1').status).toBe('ok')
    const omega = 2 * Math.PI * (1 - Math.cos(4 / R))
    const want = (omega / 3) * ((R + 1) ** 3 - R ** 3)
    expect(Math.abs(gauges(result, 'wr1', 'body_wr1').volume - want) / want).toBeLessThan(1e-4)
  })

  it('a footprint right of the axis wraps toward +X, as drawn', () => {
    const target = skin()
    const result = h.run({
      features: [...cylinder(), rectSketch('skw', '@builtin_plane_front', 2, 9, 6, 21), wrap('wr1', '@skw', target, { operation: 'new' })],
    })
    expect(h.res(result, 'wr1').status).toBe('ok')
    const g = gauges(result, 'wr1', 'body_wr1')
    expect(g.bbox[0]).toBeGreaterThan(0)
    expect(Math.abs(g.volume - sector(4, 12, R, 1)) / sector(4, 12, R, 1)).toBeLessThan(1e-6)
  })

  it('the same footprint turned 90 degrees swaps around and along', () => {
    const target = skin()
    const result = h.run({
      features: [...cylinder(), rectSketch('skw', '@builtin_plane_front', -6, 11, 6, 19), wrap('wr1', '@skw', target, { operation: 'new' })],
    })
    expect(h.res(result, 'wr1').status).toBe('ok')
    expect(Math.abs(gauges(result, 'wr1', 'body_wr1').volume - sector(12, 8, R, 1)) / sector(12, 8, R, 1)).toBeLessThan(1e-6)
  })

  it('a cut sinks exactly the footprint into the cylinder', () => {
    const target = skin()
    const result = h.run({
      features: [...cylinder(), rectSketch('skw', '@builtin_plane_front', -4, 9, 4, 21), wrap('wr1', '@skw', target, { operation: 'cut', height: 2 })],
    })
    expect(h.res(result, 'wr1').status).toBe('ok')
    const g = gauges(result, 'wr1', 'body_ex1')
    expect(g.valid).toBe(true)
    expect(Math.abs(g.volume - (cylVolume() - sector(8, 12, R, 2, -1))) / sector(8, 12, R, 2, -1)).toBeLessThan(1e-6)
  })

  it('a tube bore fills toward the axis on the far wall', () => {
    const inner = 6
    const base = h.run({ features: cylinder(inner) })
    const bore = faceQueries(base, 'body_ex1', 'cylinderface')[0]
    const result = h.run({
      features: [...cylinder(inner), rectSketch('skw', '@builtin_plane_front', -3, 9, 3, 21), wrap('wr1', '@skw', bore, { operation: 'new' })],
    })
    expect(h.res(result, 'wr1').status).toBe('ok')
    const g = gauges(result, 'wr1', 'body_wr1')
    // The far wall is at -Z, and the material grows inward to r = inner - 1.
    expect(g.bbox[5]).toBeLessThan(0)
    expect(Math.abs(g.volume - sector(6, 12, inner, 1, -1)) / sector(6, 12, inner, 1, -1)).toBeLessThan(1e-6)
  })

  it('a hole in the footprint stays a hole', () => {
    const target = skin()
    const result = h.run({
      features: [
        ...cylinder(),
        rectSketch('skw', '@builtin_plane_front', -4, 9, 4, 21, [[-1, 13, 1, 17]]),
        wrap('wr1', '@skw', target, { operation: 'new' }),
      ],
    })
    expect(h.res(result, 'wr1').status).toBe('ok')
    const want = sector(8, 12, R, 1) - sector(2, 4, R, 1)
    expect(Math.abs(gauges(result, 'wr1', 'body_wr1').volume - want) / want).toBeLessThan(1e-6)
  })

  it('a circle footprint builds within the fit tolerance', () => {
    const target = skin()
    const result = h.run({
      features: [...cylinder(), circleSketch('skw', '@builtin_plane_front', 0, 15, 3), wrap('wr1', '@skw', target, { operation: 'new' })],
    })
    expect(h.res(result, 'wr1').status).toBe('ok')
    const want = ((Math.PI * 9) / R) * (((R + 1) ** 2 - R ** 2) / 2)
    expect(Math.abs(gauges(result, 'wr1', 'body_wr1').volume - want) / want).toBeLessThan(1e-4)
  })

  it('a footprint across the cylinder face\'s own seam builds and fuses', () => {
    // The extruded circle's seam runs at +X, a quarter turn round from the
    // facing side: a footprint centred pi R / 2 to the right sits on it.
    const target = skin()
    const c = (Math.PI * R) / 2
    const result = h.run({
      features: [...cylinder(), rectSketch('skw', '@builtin_plane_front', c - 2, 9, c + 2, 21), wrap('wr1', '@skw', target)],
    })
    expect(h.res(result, 'wr1').status).toBe('ok')
    const g = gauges(result, 'wr1', 'body_ex1')
    expect(g.valid).toBe(true)
    expect(Math.abs(g.volume - (cylVolume() + sector(4, 12, R, 1))) / sector(4, 12, R, 1)).toBeLessThan(1e-6)
    expect(g.bbox[3]).toBeCloseTo(R + 1, 6)
  })

  it('a circular pattern of the wrap gives count disjoint copies', () => {
    const target = skin()
    const { kind, def } = splitPatternDef({
      subject: 'feature', source_features: ['@wr1'], mode: 'circular',
      count: 4, step_angle: 90, axis_origin: [0, 0, 0], axis_direction: [0, 1, 0],
    })
    const result = h.run({
      features: [
        ...cylinder(), rectSketch('skw', '@builtin_plane_front', -2, 9, 2, 21), wrap('wr1', '@skw', target),
        { id: 'cp1', kind, [kind]: def },
      ],
    })
    expect(h.res(result, 'cp1').status).toBe('ok')
    const g = gauges(result, 'cp1', 'body_ex1')
    expect(g.valid).toBe(true)
    expect(Math.abs(g.volume - (cylVolume() + 4 * sector(4, 12, R, 1))) / sector(4, 12, R, 1)).toBeLessThan(1e-5)
  })

  it('a pattern of a torus wrap copies the outer-half tool, not one rebuilt on the inner half', () => {
    // The regression: the pattern rebuilds the source tool against the part the
    // wrap already fused into, where the footprint centre sits in a hole of the
    // torus face. A point test then read "not on the outer half" and every copy
    // was built on the inner equator (4 % less volume, never past r = 120).
    const ring: Dict[] = [
      {
        id: 'skr', kind: 'sketch', plane: '@builtin_plane_front',
        entities: [{ id: 'c1', kind: 'circle' }, { id: 'ax', kind: 'line', construction: true }],
        initial: { c1: [100, 0, 20], ax: [0, -30, 0, 30] },
        constraints: [],
      },
      { id: 'rv1', kind: 'revolve', revolve: { sketch: '@skr', angle: 360, axis: '@skr/ax', operation: 'new' } },
    ]
    const base = h.run({ features: ring })
    const tube = faceQueries(base, 'body_rv1', 'torusface')[0]
    const { kind, def } = splitPatternDef({
      subject: 'feature', source_features: ['@wr1'], mode: 'circular',
      count: 4, step_angle: 90, axis_origin: [0, 0, 0], axis_direction: [0, 1, 0],
    })
    const result = h.run({
      features: [
        ...ring, rectSketch('skw', '@builtin_plane_front', -4, -3, 4, 3), wrap('wr1', '@skw', tube, { height: 2 }),
        { id: 'cp1', kind, [kind]: def },
      ],
    })
    expect(h.res(result, 'cp1').status).toBe('ok')
    const ringVolume = 2 * Math.PI ** 2 * 100 * 400
    const one = gauges(result, 'wr1', 'body_rv1').volume - ringVolume
    const all = gauges(result, 'cp1', 'body_rv1')
    expect(all.valid).toBe(true)
    expect(Math.abs(all.volume - ringVolume - 4 * one) / one).toBeLessThan(1e-5)
    // Every copy stands on the outer equator: the quarter-turn copies reach r = 122.
    expect(all.bbox[3]).toBeCloseTo(122, 4)
    expect(all.bbox[0]).toBeCloseTo(-122, 4)
  })

  // A pattern or mirror rebuilds its source's tool as `new`. On a wrap the
  // operation also signs the height, and the target face the rebuild would read
  // already holds the wrap, so these pin both: the cut copies go into the
  // material, and a curved footprint is not refused as running off its own hole.
  describe('patterns and mirrors of a wrap', () => {
    const quarterTurns = (source: string): Dict => {
      const { kind, def } = splitPatternDef({
        subject: 'feature', source_features: [source], mode: 'circular',
        count: 4, step_angle: 90, axis_origin: [0, 0, 0], axis_direction: [0, 1, 0],
      })
      return { id: 'cp1', kind, [kind]: def }
    }

    it('a pattern of a cut wrap sinks every copy into the skin', () => {
      const target = skin()
      const result = h.run({
        features: [
          ...cylinder(), rectSketch('skw', '@builtin_plane_front', -2, 9, 2, 21),
          wrap('wr1', '@skw', target, { operation: 'cut', height: 2 }), quarterTurns('@wr1'),
        ],
      })
      expect(h.res(result, 'cp1').status).toBe('ok')
      const g = gauges(result, 'cp1', 'body_ex1')
      expect(g.valid).toBe(true)
      const pocket = sector(4, 12, R, 2, -1)
      expect(Math.abs(g.volume - (cylVolume() - 4 * pocket)) / pocket).toBeLessThan(1e-5)
    })

    it('a pattern of a cut wrap in a bore sinks every copy outward into the wall', () => {
      const inner = 6
      const base = h.run({ features: cylinder(inner) })
      const bore = faceQueries(base, 'body_ex1', 'cylinderface')[0]
      const result = h.run({
        features: [
          ...cylinder(inner), rectSketch('skw', '@builtin_plane_front', -1.5, 9, 1.5, 21),
          wrap('wr1', '@skw', bore, { operation: 'cut', height: 1 }), quarterTurns('@wr1'),
        ],
      })
      expect(h.res(result, 'cp1').status).toBe('ok')
      const g = gauges(result, 'cp1', 'body_ex1')
      expect(g.valid).toBe(true)
      const pocket = sector(3, 12, inner, 1)
      expect(Math.abs(g.volume - (cylVolume(inner) - 4 * pocket)) / pocket).toBeLessThan(1e-5)
    })

    it('a pattern of a circle wrap rebuilds on the surface the wrap was built on', () => {
      const target = skin()
      const result = h.run({
        features: [
          ...cylinder(), circleSketch('skw', '@builtin_plane_front', 0, 15, 3),
          wrap('wr1', '@skw', target), quarterTurns('@wr1'),
        ],
      })
      expect(h.res(result, 'cp1').status).toBe('ok')
      const one = gauges(result, 'wr1', 'body_ex1').volume - cylVolume()
      const all = gauges(result, 'cp1', 'body_ex1').volume - cylVolume()
      expect(Math.abs(all - 4 * one) / one).toBeLessThan(1e-5)
    })

    it('a feature mirror of a wrap reflects it onto the other side', () => {
      const target = skin()
      const result = h.run({
        features: [
          ...cylinder(), rectSketch('skw', '@builtin_plane_front', 2, 9, 6, 21),
          wrap('wr1', '@skw', target),
          { id: 'mi1', kind: 'mirror', mirror: { subject: 'feature', source_features: ['@wr1'], plane: '@builtin_plane_right' } },
        ],
      })
      expect(h.res(result, 'mi1').status).toBe('ok')
      const g = gauges(result, 'mi1', 'body_ex1')
      expect(g.valid).toBe(true)
      expect(Math.abs(g.volume - (cylVolume() + 2 * sector(4, 12, R, 1))) / sector(4, 12, R, 1)).toBeLessThan(1e-5)
      // The reflected pad stands on the -X side, as the source does on +X.
      expect(g.bbox[0]).toBeLessThan(-2)
    })
  })

  describe('refusals', () => {
    it('no target builds nothing and says so', () => {
      const result = h.run({ features: [...cylinder(), rectSketch('skw', '@builtin_plane_front', -4, 9, 4, 21), wrap('wr1', '@skw', undefined)] })
      const res = h.res(result, 'wr1')
      expect(res.status).toBe('ok')
      expect(res.body_ids).toEqual([])
      expect(String(res.solver_warning)).toContain('wrap: has no target face; nothing was built')
    })

    it('a planar target names the extrude', () => {
      const flat = h.run({ features: cylinder() })
      const top = faceQueries(flat, 'body_ex1', 'flatface')[0]
      const result = h.run({ features: [...cylinder(), rectSketch('skw', '@builtin_plane_front', -4, 9, 4, 21), wrap('wr1', '@skw', top)] })
      expect(String(h.res(result, 'wr1').exception)).toContain('the target face is planar; use an extrude')
    })

    it('a sketch plane perpendicular to the axis is refused with the pinned sentence', () => {
      const target = skin()
      const result = h.run({
        features: [...cylinder(), rectSketch('skw', '@builtin_plane_top', -4, -4, 4, 4), wrap('wr1', '@skw', target)],
      })
      expect(String(h.res(result, 'wr1').exception)).toContain(WRAP_AXIS_PERPENDICULAR)
    })

    it('a footprint reaching half way round is refused', () => {
      const target = skin()
      const result = h.run({
        features: [...cylinder(), rectSketch('skw', '@builtin_plane_front', -32, 9, 32, 21), wrap('wr1', '@skw', target)],
      })
      expect(String(h.res(result, 'wr1').exception)).toContain('under 180 degrees')
    })

    it('a footprint running off the face is refused', () => {
      const target = skin()
      const result = h.run({
        features: [...cylinder(), rectSketch('skw', '@builtin_plane_front', -4, 25, 4, 35), wrap('wr1', '@skw', target)],
      })
      expect(String(h.res(result, 'wr1').exception)).toContain('runs off the target face')
    })

    it('a cut reaching through the axis is refused', () => {
      const target = skin()
      const result = h.run({
        features: [...cylinder(), rectSketch('skw', '@builtin_plane_front', -4, 9, 4, 21), wrap('wr1', '@skw', target, { operation: 'cut', height: 12 })],
      })
      expect(String(h.res(result, 'wr1').exception)).toContain("reaches through the target's axis")
    })

    it('a non-positive height is refused', () => {
      const target = skin()
      const result = h.run({
        features: [...cylinder(), rectSketch('skw', '@builtin_plane_front', -4, 9, 4, 21), wrap('wr1', '@skw', target, { height: 0 })],
      })
      expect(String(h.res(result, 'wr1').exception)).toContain('height must be a positive length')
    })
  })
})
