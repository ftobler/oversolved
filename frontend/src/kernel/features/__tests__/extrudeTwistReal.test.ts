// @vitest-environment node
//
// Extrude twist: the whole feature through the kernel. Volume is an exact
// oracle, because a rotation about the sweep axis preserves the section area,
// so a twisted solid has the volume `area * distance` of the straight prism.
// The lateral faces are B-spline surfaces, so every read here uses the accurate
// Gauss-Kronrod rule (`volumeForMeasure`), not the eps decision read.
//
// Skips when OCC.js or the Rust solver is absent.

import { describe, it, expect } from 'vitest'
import type { BuildResponse } from '../../builder'
import { DisposeScope } from '../../occ/disposeScope'
import { canonicalFaces } from '../../occ/partNames'
import { shapeBbox } from '../../occ/faceBounds'
import { volumeForMeasure } from '../../occ/volume'
import type { OccShape } from '../../occ/occTypes'
import { oc, solveBytes, extrudeTestHarness } from '../extrudeRealSupport'

interface Dict { [key: string]: unknown }

/** A counter-clockwise rectangle with one line per side. */
function rectSketch(id: string, plane: string, x0: number, y0: number, x1: number, y1: number): Dict {
  return {
    id, kind: 'sketch', plane,
    entities: ['b', 'r', 't', 'l'].map((s) => ({ id: id + s, kind: 'line' })),
    initial: {
      [id + 'b']: [x0, y0, x1, y0],
      [id + 'r']: [x1, y0, x1, y1],
      [id + 't']: [x1, y1, x0, y1],
      [id + 'l']: [x0, y1, x0, y0],
    },
    constraints: [],
  }
}

function extrude(id: string, sketch: string | string[], opts: Dict = {}): Dict {
  return {
    id, kind: 'extrude',
    extrude: { sketch, distance: 10, direction: 'normal', operation: 'new', ...opts },
  }
}

interface Gauges {
  volume: number
  faces: number
  edges: number
  bbox: number[]
  valid: boolean
  mesh: Dict
}

describe.skipIf(!oc || !solveBytes)('extrude twist (real OCC + Rust solver)', () => {
  const h = extrudeTestHarness()

  function gauges(result: BuildResponse, featureId: string, bodyId: string): Gauges {
    const cp = result._build_state!.checkpoints[featureId]
    expect(cp, `no checkpoint for ${featureId}`).toBeDefined()
    const shape = h.table.get<OccShape>(cp.body_store_snapshot[bodyId].shape!)
    const scope = new DisposeScope()
    try {
      return {
        volume: volumeForMeasure(oc!, scope, shape),
        faces: canonicalFaces(oc!, scope, shape).length,
        edges: ((h.part(result, bodyId).edges as unknown[]) ?? []).length,
        bbox: shapeBbox(oc!, scope, shape),
        valid: scope.track(new oc!.BRepCheck_Analyzer(shape, true, false, false)).IsValid_2(),
        mesh: (h.part(result, bodyId).mesh as Dict) ?? {},
      }
    } finally {
      scope.dispose()
    }
  }

  function squareTwistSpec(twist: number | string | undefined, distance = 40): Dict {
    const spec: Dict = { twist }
    return {
      features: [
        rectSketch('sk1', '@builtin_plane_top', 0, 0, 10, 10),
        extrude('ex1', '@sk1', { distance, ...spec }),
      ],
    }
  }

  it('a twisted bar has the straight prism volume and four twisted walls', () => {
    const result = h.run(squareTwistSpec(90))
    expect(h.res(result, 'ex1').status).toBe('ok')
    const g = gauges(result, 'ex1', 'body_ex1')
    expect(g.valid).toBe(true)
    expect(g.volume).toBeCloseTo(100 * 40, 3)
    expect(g.faces).toBe(6)
    // The square's four edges keep their names on their twisted walls.
    const mesh = g.mesh as { face_data: { surface_type?: string }[]; face_queries: string[] }
    const queries = mesh.face_data
      .map((face, i) => (face.surface_type !== 'flatface' ? mesh.face_queries[i] : null))
      .filter((q): q is string => typeof q === 'string')
    expect(queries).toHaveLength(4)
    for (const side of ['b', 'r', 't', 'l']) {
      expect(queries.some((q) => q.includes(`@sk1/sk1${side}`)), side).toBe(true)
    }
  })

  it('twist 0 builds the same shape as an absent twist', () => {
    const zero = h.run(squareTwistSpec(0))
    const absent = h.run({
      features: [
        rectSketch('sk1', '@builtin_plane_top', 0, 0, 10, 10),
        extrude('ex1', '@sk1', { distance: 40 }),
      ],
    })
    expect(h.res(zero, 'ex1').status).toBe('ok')
    expect(h.res(absent, 'ex1').status).toBe('ok')
    const a = gauges(zero, 'ex1', 'body_ex1')
    const b = gauges(absent, 'ex1', 'body_ex1')
    expect(a.volume).toBeCloseTo(b.volume, 9)
    expect(a.faces).toBe(b.faces)
    expect(a.edges).toBe(b.edges)
    expect(a.bbox).toEqual(b.bbox)
    expect((a.mesh.edge_queries as unknown[])).toEqual(b.mesh.edge_queries)
  })

  it('a twisted bar cut from a block removes exactly the bar', () => {
    const base = h.run({
      features: [
        rectSketch('sk1', '@builtin_plane_top', -20, -20, 20, 20),
        extrude('ex1', '@sk1', { distance: 10 }),
      ],
    })
    const withCut = h.run({
      features: [
        rectSketch('sk1', '@builtin_plane_top', -20, -20, 20, 20),
        extrude('ex1', '@sk1', { distance: 10 }),
        { id: 'plTop', kind: 'plane', definition: { mode: 'offset', plane: '@builtin_plane_top', offset: 10 } },
        rectSketch('sk2', '@plTop', -5, -5, 5, 5),
        extrude('ex2', '@sk2', {
          distance: 10, direction: 'reverse', twist: 90, operation: 'cut', merge_target: '@body_ex1',
        }),
      ],
    })
    expect(h.res(withCut, 'ex2').status).toBe('ok')
    const before = gauges(base, 'ex1', 'body_ex1').volume
    const after = gauges(withCut, 'ex2', 'body_ex1').volume
    expect(before - after).toBeCloseTo(100 * 10, 3)
    expect(gauges(withCut, 'ex2', 'body_ex1').valid).toBe(true)
  })

  it('a twisted bar fuses onto a body', () => {
    const result = h.run({
      features: [
        rectSketch('sk1', '@builtin_plane_top', -20, -20, 20, 20),
        extrude('ex1', '@sk1', { distance: 10 }),
        { id: 'plTop', kind: 'plane', definition: { mode: 'offset', plane: '@builtin_plane_top', offset: 10 } },
        rectSketch('sk2', '@plTop', -5, -5, 5, 5),
        extrude('ex2', '@sk2', {
          distance: 20, twist: 90, operation: 'add', merge_target: '@body_ex1',
        }),
      ],
    })
    expect(h.res(result, 'ex2').status).toBe('ok')
    const g = gauges(result, 'ex2', 'body_ex1')
    expect(g.volume).toBeCloseTo(40 * 40 * 10 + 100 * 20, 3)
    expect(g.valid).toBe(true)
  })

  it('a sketch on the twisted top face lands at the rotated frame', () => {
    // The top face of a 90 degree twist is the profile turned a quarter turn
    // about the normal: the plane's x axis is the old +Y (Top is x=+X, y=-Z,
    // normal=+Y), so a boss drawn from (0,0) to (2,2) sits at x in [-2,0].
    const result = h.run({
      features: [
        rectSketch('sk1', '@builtin_plane_top', 0, 0, 10, 10),
        extrude('ex1', '@sk1', { distance: 40, twist: 90 }),
        rectSketch('sk2', '@ex1/top_face', 0, 0, 2, 2),
        extrude('ex2', '@sk2', { distance: 2 }),
      ],
    })
    expect(h.res(result, 'ex1').status).toBe('ok')
    expect(h.res(result, 'ex2').status).toBe('ok')
    const mesh = h.part(result, 'body_ex2').mesh as { vertices: number[][] }
    const xs = mesh.vertices.map((v) => v[0])
    const zs = mesh.vertices.map((v) => v[2])
    // A boss at the unrotated frame would sit at x in [0,2]; the twist puts it
    // on the other side of the sketch origin.
    expect(Math.min(...xs)).toBeCloseTo(-2, 3)
    expect(Math.max(...xs)).toBeCloseTo(0, 3)
    expect(Math.min(...zs)).toBeCloseTo(-2, 3)
    expect(Math.max(...zs)).toBeCloseTo(0, 3)
  })

  it('twist as an expression follows the variable', () => {
    const spec = (expression: string): Dict => ({
      features: [
        { id: 'v_ang', kind: 'variable', label: 'ang', variable: { expression } },
        rectSketch('sk1', '@builtin_plane_top', 0, 0, 10, 10),
        extrude('ex1', '@sk1', { distance: 40, twist: 'ang' }),
      ],
    })
    const quarter = h.run(spec('90'))
    expect(h.res(quarter, 'ex1').status).toBe('ok')
    const quarterMesh = h.part(quarter, 'body_ex1').mesh as { vertices: number[][] }
    expect(Math.min(...quarterMesh.vertices.map((v) => v[0]))).toBeCloseTo(-10, 3)
    const straight = h.run(spec('0'))
    expect(h.res(straight, 'ex1').status).toBe('ok')
    const straightMesh = h.part(straight, 'body_ex1').mesh as { vertices: number[][] }
    expect(Math.min(...straightMesh.vertices.map((v) => v[0]))).toBeCloseTo(0, 3)
  })

  it('a multi-group profile twists as one merged face', () => {
    const result = h.run({
      features: [
        rectSketch('skA', '@builtin_plane_top', -10, -5, 0, 5),
        rectSketch('skB', '@builtin_plane_top', 0, -5, 10, 5),
        extrude('ex1', ['@skA', '@skB'], { distance: 40, twist: 90 }),
      ],
    })
    expect(h.res(result, 'ex1').status).toBe('ok')
    expect(Object.keys(result.bodies ?? {})).toEqual(['body_ex1'])
    const g = gauges(result, 'ex1', 'body_ex1')
    // The merged profile is a 20 x 10 rectangle: 200 * 40.
    expect(g.volume).toBeCloseTo(200 * 40, 3)
    expect(g.faces).toBe(6)
  })

  it('refuses twist with taper, symmetric, up_to, up_to_next and through_all by name', () => {
    const cases: [string, Dict, RegExp][] = [
      ['taper', { twist: 90, taper: 10 }, /twist with taper is not supported/],
      ['symmetric', { twist: 90, direction: 'symmetric' }, /twist is not supported with direction symmetric/],
      ['up_to', { twist: 90, termination: 'up_to' }, /twist is not supported with termination up_to/],
      ['up_to_next', { twist: 90, termination: 'up_to_next' }, /twist is not supported with termination up_to_next/],
      ['through_all', { twist: 90, termination: 'through_all', operation: 'cut' }, /twist is not supported with termination through_all/],
    ]
    for (const [name, opts, message] of cases) {
      const result = h.run({
        features: [
          rectSketch('sk1', '@builtin_plane_top', 0, 0, 10, 10),
          extrude('ex1', '@sk1', { distance: 40, ...opts }),
        ],
      })
      expect(h.res(result, 'ex1').status, name).toBe('exception')
      expect(String(h.res(result, 'ex1').exception), name).toMatch(message)
    }
  })

  it('refuses a twist beyond the section cap by name', () => {
    const result = h.run(squareTwistSpec(7201))
    expect(h.res(result, 'ex1').status).toBe('exception')
    expect(String(h.res(result, 'ex1').exception)).toContain('+/-7200')
  })
})
