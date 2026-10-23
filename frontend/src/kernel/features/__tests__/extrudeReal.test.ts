// @vitest-environment node
//
// Gated real-OCC feature-level extrude tests using the full build pipeline
// (OCC.js + Rust WASM sketch solver). Ports the build-layer extrude scenarios
// from test_extrude_mesh.py.
//
// Split by describe group from the original 1.3k-line file; the shared spec
// builders live in extrudeRealSupport.ts. This file covers basic mesh/bbox,
// nested UI / bare plane ids, stacked extrudes, surface queries, picked sketch
// entities, profile lists and the nested-loop (washer) profile.
//
// Skips when OCC.js or the Rust solver is absent.

import { describe, it, expect } from 'vitest'
import { makeAncestryQuery } from '../../query'
import type { BuildResponse } from '../../builder'
import { DisposeScope } from '../../occ/disposeScope'
import { canonicalFaces } from '../../occ/bodyNames'
import { volumeOf } from '../../occ/booleans'
import type { OccShape } from '../../occ/occTypes'
import {
  oc, solveBytes, extrudeTestHarness, rectSketchSk, extrudeSpec, fullRectExtrudeSpec,
  assertMeshValid, assertMeshBbox,
} from '../extrudeRealSupport'

describe.skipIf(!oc || !solveBytes)('extrude feature (real OCC + Rust solver): mesh, planes and profiles', () => {
  const h = extrudeTestHarness()

  // ─── Basic mesh / bbox tests ───

  it('basic rect extrude produces a valid mesh', () => {
    const result = h.run(fullRectExtrudeSpec(10, 10, 5))
    expect(h.res(result, 'ex1').status).toBe('ok')
    const mesh = h.body(result, 'body_ex1').mesh as Record<string, unknown> | undefined
    expect(mesh).toBeDefined()
    if (mesh) assertMeshValid(mesh)
  })

  it('rect extrude bbox normal direction', () => {
    const result = h.run(fullRectExtrudeSpec(10, 8, 5, 'normal'))
    expect(h.res(result, 'ex1').status).toBe('ok')
    const mesh = h.body(result, 'body_ex1').mesh as Record<string, unknown> | undefined
    expect(mesh).toBeDefined()
    if (mesh) assertMeshBbox(mesh, [0, 10], [0, 8], [0, 5])
  })

  it('rect extrude bbox reverse direction', () => {
    const result = h.run(fullRectExtrudeSpec(6, 6, 4, 'reverse'))
    expect(h.res(result, 'ex1').status).toBe('ok')
    const mesh = h.body(result, 'body_ex1').mesh as Record<string, unknown> | undefined
    expect(mesh).toBeDefined()
    if (mesh) assertMeshBbox(mesh, [0, 6], [0, 6], [-4, 0])
  })

  it('rect extrude bbox symmetric direction', () => {
    const result = h.run(fullRectExtrudeSpec(4, 4, 6, 'symmetric'))
    expect(h.res(result, 'ex1').status).toBe('ok')
    const mesh = h.body(result, 'body_ex1').mesh as Record<string, unknown> | undefined
    expect(mesh).toBeDefined()
    if (mesh) assertMeshBbox(mesh, [0, 4], [0, 4], [-3, 3])
  })

  it('all face indices are valid', () => {
    const result = h.run(fullRectExtrudeSpec())
    expect(h.res(result, 'ex1').status).toBe('ok')
    const mesh = h.body(result, 'body_ex1').mesh as { vertices: number[][]; faces: number[][] } | undefined
    expect(mesh).toBeDefined()
    if (mesh) {
      const n = mesh.vertices.length
      for (const [a, b, c] of mesh.faces) {
        expect(a).toBeGreaterThanOrEqual(0); expect(a).toBeLessThan(n)
        expect(b).toBeGreaterThanOrEqual(0); expect(b).toBeLessThan(n)
        expect(c).toBeGreaterThanOrEqual(0); expect(c).toBeLessThan(n)
      }
    }
  })

  it('no degenerate faces', () => {
    const result = h.run(fullRectExtrudeSpec())
    expect(h.res(result, 'ex1').status).toBe('ok')
    const mesh = h.body(result, 'body_ex1').mesh as { vertices: number[][]; faces: number[][] } | undefined
    expect(mesh).toBeDefined()
    if (mesh) {
      for (const [a, b, c] of mesh.faces) {
        expect(a).not.toBe(b)
        expect(b).not.toBe(c)
        expect(a).not.toBe(c)
      }
    }
  })

  // ─── Nested UI format / bare plane id ───

  it('nested extrude UI format produces valid mesh', () => {
    // Regression: UI serializes extrude as {kind, id, extrude: {sketch, distance,...}}.
    const result = h.run({
      features: [
        {
          id: 'sk1', kind: 'sketch', plane: 'Top',
          entities: [{ id: 'c1', kind: 'circle' }],
          initial: { c1: [0, 0, 0.5] },
          constraints: [
            { id: 'co1', kind: 'coincident', a: '$sk1c1center', b: '@builtin_origin' },
            { id: 'd1', kind: 'diameter', target: '$sk1c1', value: 1 },
          ],
        },
        { id: 'ex1', kind: 'extrude', label: 'extrude 1',
          extrude: { sketch: '$sk1', distance: 2, direction: 'normal' } },
      ],
    })
    expect(h.res(result, 'sk1').status).not.toBe('exception')
    expect(h.res(result, 'ex1').status).toBe('ok')
    expect(result.bodies).toHaveProperty('body_ex1')
    const mesh = h.body(result, 'body_ex1').mesh as Record<string, unknown> | undefined
    expect(mesh).toBeDefined()
    if (mesh) assertMeshBbox(mesh, [-0.5, 0.5], [0, 2], [-0.5, 0.5])
  })

  it('bare builtin plane id is resolved', () => {
    // Bare plane id 'Top' (no @ prefix) must resolve to the correct builtin plane.
    const result = h.run({
      features: [
        {
          id: 'sk1', kind: 'sketch', plane: 'Top',
          entities: [{ id: 'c1', kind: 'circle' }],
          initial: { c1: [0, 0, 0.5] },
          constraints: [
            { id: 'co1', kind: 'coincident', a: '$sk1c1center', b: '@builtin_origin' },
            { id: 'd1', kind: 'diameter', target: '$sk1c1', value: 1 },
          ],
        },
        { id: 'ex1', kind: 'extrude', sketch: '$sk1', distance: 2, direction: 'normal' },
      ],
    })
    expect(h.res(result, 'sk1').status).not.toBe('exception')
    expect(h.res(result, 'ex1').status).toBe('ok')
    expect(result.bodies).toHaveProperty('body_ex1')
    const mesh = h.body(result, 'body_ex1').mesh as Record<string, unknown> | undefined
    expect(mesh).toBeDefined()
    if (mesh) assertMeshBbox(mesh, [-0.5, 0.5], [0, 2], [-0.5, 0.5])
  })

  it('circle sketch with ghost line constraints still extrudes', () => {
    // Ghost constraints referencing non-existent line entities must be ignored.
    const result = h.run({
      features: [
        {
          id: 'sk1', kind: 'sketch', plane: 'Top',
          entities: [{ id: 'circ1', kind: 'circle' }],
          initial: { circ1: [0, 0, 0.5] },
          constraints: [
            { id: 'c_co', kind: 'coincident', a: '$sk1circ1center', b: '@builtin_origin' },
            { id: 'c_diam', kind: 'diameter', target: '$sk1circ1', value: 1 },
            { id: 'c_ghost1', kind: 'coincident', a: '$sk1line1end', b: '$sk1line2start' },
            { id: 'c_ghost2', kind: 'equal_length', a: '$sk1line1', b: '$sk1line3' },
            { id: 'c_ghost3', kind: 'horizontal', target: '$sk1line1' },
          ],
        },
        { id: 'ex1', kind: 'extrude', label: 'extrude 1',
          extrude: { sketch: '$sk1', distance: 1, direction: 'normal' } },
      ],
    })
    expect(h.res(result, 'sk1').status).not.toBe('exception')
    expect(h.res(result, 'ex1').status).toBe('ok')
    expect(result.bodies).toHaveProperty('body_ex1')
    const mesh = h.body(result, 'body_ex1').mesh as Record<string, unknown> | undefined
    expect(mesh).toBeDefined()
    if (mesh) assertMeshValid(mesh)
  })

  // ─── Top face plane / stacked extrudes ───

  it('top face plane is at correct z', () => {
    /**
     * The top face centroid must be at z=distance. The plane feature kind is not ported to the
     * TS kernel, so test directly via mesh face_data z-coordinates.
     */
    const d = 7
    const result = h.run({
      features: [
        rectSketchSk('sk1', 10, 10, '@builtin_plane_front'),
        extrudeSpec('sk1', 'ex1', { distance: d }),
      ],
    })
    expect(h.res(result, 'ex1').status).toBe('ok')
    const mesh = h.body(result, 'body_ex1').mesh as { face_data?: Array<{ centroid: number[]; normal: number[] }> } | undefined
    expect(mesh).toBeDefined()
    const topFace = mesh?.face_data?.find((fd) => fd.normal[2] > 0.9)
    expect(topFace).toBeDefined()
    expect(topFace!.centroid[2]).toBeCloseTo(d, 0)
  })

  it('two extrudes stacked one on top of the other', () => {
    // Second extrude on top of first with operation=new.
    const result = h.run({
      features: [
        rectSketchSk('sk1', 10, 10, '@builtin_plane_front'),
        extrudeSpec('sk1', 'ex1', { distance: 5 }),
        {
          id: 'sk2', kind: 'sketch', plane: '@ex1/top_face',
          entities: [
            { id: 'bottom', kind: 'line' }, { id: 'right', kind: 'line' },
            { id: 'top', kind: 'line' }, { id: 'left', kind: 'line' },
          ],
          initial: {
            bottom: [0, 0, 4, 0], right: [4, 0, 4, 4],
            top: [4, 4, 0, 4], left: [0, 4, 0, 0],
          },
          constraints: [
            { id: 'c1', kind: 'coincident', a: { entity: 'bottom', point: 'end' }, b: { entity: 'right', point: 'start' } },
            { id: 'c2', kind: 'coincident', a: { entity: 'right', point: 'end' }, b: { entity: 'top', point: 'start' } },
            { id: 'c3', kind: 'coincident', a: { entity: 'top', point: 'end' }, b: { entity: 'left', point: 'start' } },
            { id: 'c4', kind: 'coincident', a: { entity: 'left', point: 'end' }, b: { entity: 'bottom', point: 'start' } },
            { id: 'c5', kind: 'horizontal', target: { entity: 'bottom' } },
            { id: 'c6', kind: 'horizontal', target: { entity: 'top' } },
            { id: 'c7', kind: 'vertical', target: { entity: 'right' } },
            { id: 'c8', kind: 'vertical', target: { entity: 'left' } },
            { id: 'c9', kind: 'length', target: { entity: 'bottom' }, value: 4 },
            { id: 'c10', kind: 'length', target: { entity: 'left' }, value: 4 },
          ],
        },
        extrudeSpec('sk2', 'ex2', { distance: 3, operation: 'new' }),
      ],
    })
    expect(h.res(result, 'ex1').status).toBe('ok')
    expect(h.res(result, 'ex2').status).toBe('ok')
    const mesh2 = h.body(result, 'body_ex2').mesh as { vertices: number[][] } | undefined
    expect(mesh2).toBeDefined()
    if (mesh2) {
      const zs = mesh2.vertices.map((v) => v[2])
      expect(Math.min(...zs)).toBeCloseTo(5, 0)
      expect(Math.max(...zs)).toBeCloseTo(8, 0)
    }
  })

  // ─── Surface queries ───

  it('extrude from sketch surface query (circle profile)', () => {
    // Extrude uses a ?-ancestry query for a sketch surface flatface as the profile.
    const surfaceQuery = makeAncestryQuery(['@sk1/c1', 'surface:0', '@sk1'], 'flatface')
    const result = h.run({
      features: [
        {
          id: 'sk1', kind: 'sketch', plane: '@builtin_plane_front',
          entities: [{ id: 'c1', kind: 'circle' }],
          initial: { c1: [0, 0, 0.5] },
          constraints: [
            { id: 'co1', kind: 'coincident', a: '$sk1c1center', b: '@builtin_origin' },
            { id: 'd1', kind: 'diameter', target: '$sk1c1', value: 1 },
          ],
        },
        { id: 'ex1', kind: 'extrude', sketch: surfaceQuery, distance: 2, direction: 'normal' },
      ],
    })
    expect(h.res(result, 'sk1').status).not.toBe('exception')
    expect(h.res(result, 'ex1').status).toBe('ok')
    expect(result.bodies).toHaveProperty('body_ex1')
    const mesh = h.body(result, 'body_ex1').mesh as Record<string, unknown> | undefined
    expect(mesh).toBeDefined()
    if (mesh) assertMeshValid(mesh)
  })

  it('extrude uses only selected surface, not whole sketch', () => {
    // When a sketch has two circles and one is selected via ?, only that surface is extruded.
    const sk = 'sk1'
    const surfaceQuery = makeAncestryQuery([`@${sk}/c2`, 'surface:1', `@${sk}`], 'flatface')
    const result = h.run({
      features: [
        {
          id: sk, kind: 'sketch', plane: '@builtin_plane_front',
          entities: [{ id: 'c1', kind: 'circle' }, { id: 'c2', kind: 'circle' }],
          initial: { c1: [0, 0, 0.5], c2: [3, 0, 0.5] },
          constraints: [
            { id: 'co1', kind: 'coincident', a: `$${sk}c1center`, b: '@builtin_origin' },
            { id: 'd1', kind: 'diameter', target: `$${sk}c1`, value: 1 },
            { id: 'd2', kind: 'diameter', target: `$${sk}c2`, value: 1 },
          ],
        },
        { id: 'ex1', kind: 'extrude', sketch: surfaceQuery, distance: 1, direction: 'normal' },
      ],
    })
    expect(h.res(result, 'ex1').status).toBe('ok')
    const mesh = h.body(result, 'body_ex1').mesh as { vertices: number[][] } | undefined
    expect(mesh).toBeDefined()
    if (mesh) {
      const xs = mesh.vertices.map((v) => v[0])
      expect(Math.min(...xs)).toBeGreaterThan(1)  // c2 is near x=3, c1 at origin must not be included
    }
  })

  // ─── Picked sketch entities ───

  // A 10x10 rectangle with a free r=2 circle at (5,5), both in one sketch.
  function rectWithCircleSpec(profileRef: string) {
    const sk = rectSketchSk('sk1', 10, 10) as Record<string, unknown>
    const entities = sk.entities as Record<string, unknown>[]
    const initial = sk.initial as Record<string, number[]>
    const constraints = sk.constraints as Record<string, unknown>[]
    entities.push({ id: 'ci', kind: 'circle' as const })
    initial.ci = [5, 5, 2]
    constraints.push({ id: 'cd', kind: 'diameter' as const, target: '$ci', value: 4 })
    return {
      features: [
        sk,
        { id: 'ex1', kind: 'extrude', extrude: { sketch: [profileRef], distance: 3, direction: 'normal' } },
      ],
    }
  }

  it('a picked circle extrudes the disc it bounds, not the sketch around it', () => {
    // The viewport hands the chip `entity:<sketch>:<eid>` when the click lands
    // on the curve rather than on the area fill. The circle sits inside the
    // rectangle, so answering with the sketch (or with every region the circle
    // borders) would sweep the 10x10 plate as well.
    const result = h.run(rectWithCircleSpec('entity:sk1:ci'))
    expect(h.res(result, 'sk1').status).not.toBe('exception')
    expect(h.res(result, 'ex1').status).toBe('ok')
    const mesh = h.body(result, 'body_ex1').mesh as Record<string, unknown> | undefined
    expect(mesh).toBeDefined()
    if (mesh) {
      assertMeshValid(mesh)
      assertMeshBbox(mesh, [3, 7], [3, 7], [0, 3])
    }
  })

  it('a picked circle cuts the same disc it would have added', () => {
    // A hole IS an extrude with a negative sign, so the cut path has to answer
    // a curve pick the way the add path does: the profile is resolved by the
    // same collectExtrudeLoops call before the boolean ever runs. The plate
    // keeps its bbox, so the evidence the disc was really removed is the wall
    // the cut leaves behind: mesh vertices sitting r=2 from the circle centre.
    const result = h.run({
      features: [
        rectSketchSk('sk1', 10, 10),
        { id: 'ex1', kind: 'extrude', extrude: { sketch: ['$sk1'], distance: 3, direction: 'normal' } },
        {
          id: 'sk2', kind: 'sketch', label: 'Circle', plane: '@builtin_plane_front',
          entities: [{ id: 'ci', kind: 'circle' as const }],
          initial: { ci: [5, 5, 2] },
          constraints: [{ id: 'cd', kind: 'diameter' as const, target: '$ci', value: 4 }],
        },
        {
          id: 'ex2', kind: 'extrude',
          extrude: { sketch: ['entity:sk2:ci'], distance: 3, direction: 'normal', operation: 'cut' },
        },
      ],
    })
    expect(h.res(result, 'ex2').status).toBe('ok')
    expect(result.bodies).not.toHaveProperty('body_ex2')
    const mesh = h.body(result, 'body_ex1').mesh as Record<string, unknown> | undefined
    expect(mesh).toBeDefined()
    if (mesh) {
      assertMeshValid(mesh)
      assertMeshBbox(mesh, [0, 10], [0, 10], [0, 3])
      const verts = mesh.vertices as number[][]
      const onWall = verts.filter((v) => Math.abs(Math.hypot(v[0] - 5, v[1] - 5) - 2) < 0.05)
      expect(onWall.length).toBeGreaterThan(0)
    }
  })

  it('a picked open curve is refused instead of widened to its sketch', () => {
    const result = h.run(rectWithCircleSpec('entity:sk1:bottom'))
    expect(h.res(result, 'ex1').status).toBe('exception')
    expect(String(h.res(result, 'ex1').exception)).toContain('bounds no closed area')
  })

  it('extrude from top face named query (@ex1/top_face)', () => {
    // Second extrude uses @ex1/top_face as its profile.
    const result = h.run({
      features: [
        rectSketchSk('sk1', 10, 10, '@builtin_plane_front'),
        extrudeSpec('sk1', 'ex1', { distance: 5 }),
        { id: 'ex2', kind: 'extrude', sketch: '@ex1/top_face', distance: 3, direction: 'normal', operation: 'new' },
      ],
    })
    expect(h.res(result, 'ex1').status).toBe('ok')
    expect(h.res(result, 'ex2').status).toBe('ok')
    expect(result.bodies).toHaveProperty('body_ex2')
    const mesh2 = h.body(result, 'body_ex2').mesh as { vertices: number[][] } | undefined
    expect(mesh2).toBeDefined()
    if (mesh2) {
      const zs = mesh2.vertices.map((v) => v[2])
      expect(Math.min(...zs)).toBeCloseTo(5, 0)
      expect(Math.max(...zs)).toBeCloseTo(8, 0)
    }
  })

  // ─── Sketch list tests ───

  it('extrude sketch list with two profiles produces one body', () => {
    // sketch field as a list of two sketch refs.
    const result = h.run({
      features: [
        rectSketchSk('sk1', 2, 2, '@builtin_plane_front'),
        rectSketchSk('sk2', 2, 2, '@builtin_plane_front'),
        { id: 'ex1', kind: 'extrude', sketch: ['$sk1', '$sk2'], distance: 3, direction: 'normal' },
      ],
    })
    expect(h.res(result, 'ex1').status).toBe('ok')
    expect(result.bodies).toHaveProperty('body_ex1')
    const mesh = h.body(result, 'body_ex1').mesh as { vertices: number[][]; faces: number[][] } | undefined
    expect(mesh).toBeDefined()
    if (mesh) {
      expect(mesh.vertices.length).toBeGreaterThan(0)
      expect(mesh.faces.length).toBeGreaterThan(0)
    }
  })

  it('extrude sketch list with single element', () => {
    // A list with one sketch ref behaves like the string form.
    const result = h.run({
      features: [
        rectSketchSk('sk1', 4, 4, '@builtin_plane_front'),
        { id: 'ex1', kind: 'extrude', sketch: ['$sk1'], distance: 2, direction: 'normal' },
      ],
    })
    expect(h.res(result, 'ex1').status).toBe('ok')
    const mesh = h.body(result, 'body_ex1').mesh as Record<string, unknown> | undefined
    expect(mesh).toBeDefined()
    if (mesh) assertMeshBbox(mesh, [0, 4], [0, 4], [0, 2])
  })

  it('extrude sketch empty list errors', () => {
    // Empty sketch list returns exception.
    const result = h.run({
      features: [{ id: 'ex1', kind: 'extrude', sketch: [], distance: 2 }],
    })
    expect(h.res(result, 'ex1').status).toBe('exception')
  })

  it('extrude of a sketch with no closed profile is an error', () => {
    // The ref resolves but the sketch holds no closed profile: a part-less
    // extrude is a failed one (status error), not an exception.
    const result = h.run({
      features: [
        {
          id: 'sk1', kind: 'sketch', plane: '@builtin_plane_front',
          entities: [{ id: 'L1', kind: 'line' }],
          constraints: [{ id: 'c1', kind: 'horizontal', target: { entity: 'L1' } }],
        },
        { id: 'ex1', kind: 'extrude', sketch: ['@sk1'], distance: 5 },
      ],
    })
    expect(h.res(result, 'ex1').status).toBe('error')
    expect(String(h.res(result, 'ex1').exception)).toMatch(/no closed profile/)
  })

  it('extrude key error still returns exception dict', () => {
    // A KeyError-like situation must yield exception status.
    const result = h.run({
      features: [{ id: 'ex1', kind: 'extrude', sketch: [] }],
    })
    expect(h.res(result, 'ex1').status).toBe('exception')
  })

  it('a profile list with one dangling ref extrudes the rest and reports partial', () => {
    // A stale pick in the profile list must not throw the whole feature away:
    // the resolvable sketch still builds, and the result is `partial` with the
    // dangling ref named, so the user can see which pick to re-make.
    const result = h.run({
      features: [
        rectSketchSk('sk1', 10, 10),
        { id: 'ex1', kind: 'extrude', sketch: ['$sk1', '$missing'], distance: 5, direction: 'normal', operation: 'new' },
      ],
    })
    expect(h.res(result, 'ex1').status).toBe('partial')
    expect(String(h.res(result, 'ex1').exception)).toMatch(/sketch not found: missing/)
    expect(result.bodies).toHaveProperty('body_ex1')
  })
})

// The whole-sketch profile flattens every area the sketch solver builds. A
// nested loop appears twice in that flattening: once as the container area's
// hole and once as the area's own boundary (the sketch area model makes the
// inside of a closed curve a filled area of its own). The face builder must
// see it once, or the inner loop is cut out twice -- the washer comes out with
// V_outer - 2 * V_inner, which is negative for any bore larger than the wall.
describe.skipIf(!oc || !solveBytes)('extrude feature (real OCC + Rust solver): nested loops cut once', () => {
  const h = extrudeTestHarness()

  // Volume and face count read off the body's own shape through the harness's
  // persistent table: the response's tessellated body has no shape handle, the
  // checkpoint snapshot is where the live shape lives.
  function gauges(result: BuildResponse, bodyId: string): { volume: number; faces: number } {
    const cp = result._build_state!.checkpoints['ex1']
    const shape = h.table.get<OccShape>(cp.body_store_snapshot[bodyId].shape!)
    const scope = new DisposeScope()
    try {
      return { volume: volumeOf(oc!, scope, shape), faces: canonicalFaces(oc!, scope, shape).length }
    } finally {
      scope.dispose()
    }
  }

  // Circles carry their centre and radius in `initial`; no constraints are
  // needed to place them, which is exactly the report's two free circles.
  function concentricSketch(entities: Record<string, unknown>[], initial: Record<string, number[]>) {
    return {
      features: [
        {
          id: 'sk1', kind: 'sketch', plane: '@builtin_plane_front',
          entities, initial, constraints: [],
        },
        { id: 'ex1', kind: 'extrude', extrude: { sketch: '@sk1', distance: 40, direction: 'normal' } },
      ],
    }
  }

  it('two concentric circles extrude the washer, not the bore twice', () => {
    const result = h.run(concentricSketch(
      [{ id: 'cOut', kind: 'circle' }, { id: 'cIn', kind: 'circle' }],
      { cOut: [0, 0, 11], cIn: [0, 0, 10] },
    ))
    expect(h.res(result, 'ex1').status).toBe('ok')
    const g = gauges(result, 'body_ex1')
    expect(g.volume).toBeCloseTo(Math.PI * (121 - 100) * 40, 3)
    // Two annulus caps, the outer wall, the bore wall.
    expect(g.faces).toBe(4)
  })

  it('constraining the two centres together changes nothing', () => {
    // The failing reports carried no constraints; the corpus cases that were
    // expected to cover this shape do. Constraints decide nothing here: the
    // duplication came from the area model, not from the solver, so the
    // constrained sketch has to build the same washer.
    const result = h.run({
      features: [
        {
          id: 'sk1', kind: 'sketch', plane: '@builtin_plane_front',
          entities: [{ id: 'cOut', kind: 'circle' }, { id: 'cIn', kind: 'circle' }],
          initial: { cOut: [0, 0, 11], cIn: [0, 0, 10] },
          constraints: [
            { id: 'co1', kind: 'coincident', a: '$cOutcenter', b: '@builtin_origin' },
            { id: 'co2', kind: 'coincident', a: '$cIncenter', b: '$cOutcenter' },
            { id: 'd1', kind: 'diameter', target: '$cOut', value: 22 },
            { id: 'd2', kind: 'diameter', target: '$cIn', value: 20 },
          ],
        },
        { id: 'ex1', kind: 'extrude', extrude: { sketch: '@sk1', distance: 40, direction: 'normal' } },
      ],
    })
    expect(h.res(result, 'ex1').status).toBe('ok')
    const g = gauges(result, 'body_ex1')
    expect(g.volume).toBeCloseTo(Math.PI * 21 * 40, 3)
    expect(g.faces).toBe(4)
  })

  it('the washer is the same when the circles were drawn inner first', () => {
    const result = h.run(concentricSketch(
      [{ id: 'cIn', kind: 'circle' }, { id: 'cOut', kind: 'circle' }],
      { cIn: [0, 0, 10], cOut: [0, 0, 11] },
    ))
    expect(h.res(result, 'ex1').status).toBe('ok')
    expect(gauges(result, 'body_ex1').volume).toBeCloseTo(Math.PI * 21 * 40, 3)
  })

  it('an off-centre bore subtracts once', () => {
    const result = h.run(concentricSketch(
      [{ id: 'cOut', kind: 'circle' }, { id: 'cIn', kind: 'circle' }],
      { cOut: [0, 0, 11], cIn: [3, 1, 4] },
    ))
    expect(h.res(result, 'ex1').status).toBe('ok')
    const g = gauges(result, 'body_ex1')
    expect(g.volume).toBeCloseTo(Math.PI * (121 - 16) * 40, 3)
    expect(g.faces).toBe(4)
  })

  it('a bore tangent to the outer wall still subtracts once', () => {
    // The inner loop touches the outer one at (10, 0) instead of floating
    // inside it: the assembler must still see two loops and the face one hole.
    const result = h.run(concentricSketch(
      [{ id: 'cOut', kind: 'circle' }, { id: 'cIn', kind: 'circle' }],
      { cOut: [0, 0, 10], cIn: [5, 0, 5] },
    ))
    expect(h.res(result, 'ex1').status).toBe('ok')
    const g = gauges(result, 'body_ex1')
    expect(g.volume).toBeCloseTo(Math.PI * (100 - 25) * 40, 3)
    expect(g.faces).toBe(4)
  })

  it('two overlapping circles extrude their union, not one lobe', () => {
    // Equal r=5 circles with centres 6 apart cross, so the area builder splits
    // them into three regions. The face builder gets three loops, none nested,
    // and the even/odd rule keeps all three: the union, not one of the lobes.
    const r = 5
    const d = 6
    const lens = 2 * r * r * Math.acos(d / (2 * r)) - (d / 2) * Math.sqrt(4 * r * r - d * d)
    const unionArea = 2 * Math.PI * r * r - lens
    const result = h.run(concentricSketch(
      [{ id: 'cA', kind: 'circle' }, { id: 'cB', kind: 'circle' }],
      { cA: [-3, 0, r], cB: [3, 0, r] },
    ))
    expect(h.res(result, 'ex1').status).toBe('ok')
    expect(gauges(result, 'body_ex1').volume).toBeCloseTo(unionArea * 40, 3)
  })

  it('a rectangular plate with a circular hole keeps one bore', () => {
    const sk = rectSketchSk('sk1', 40, 20) as unknown as Record<string, unknown>
    const entities = sk.entities as Record<string, unknown>[]
    const initial = sk.initial as Record<string, number[]>
    entities.push({ id: 'bore', kind: 'circle' })
    initial.bore = [20, 10, 5]
    const result = h.run({
      features: [
        sk,
        { id: 'ex1', kind: 'extrude', extrude: { sketch: '@sk1', distance: 4, direction: 'normal' } },
      ],
    })
    expect(h.res(result, 'ex1').status).toBe('ok')
    const g = gauges(result, 'body_ex1')
    expect(g.volume).toBeCloseTo(40 * 20 * 4 - Math.PI * 25 * 4, 2)
    // Four side walls, two caps, one bore wall.
    expect(g.faces).toBe(7)
  })

  it('a plate with two bores subtracts each once', () => {
    const sk = rectSketchSk('sk1', 40, 20) as unknown as Record<string, unknown>
    const entities = sk.entities as Record<string, unknown>[]
    const initial = sk.initial as Record<string, number[]>
    entities.push({ id: 'b1', kind: 'circle' }, { id: 'b2', kind: 'circle' })
    initial.b1 = [10, 10, 3]
    initial.b2 = [30, 10, 4]
    const result = h.run({
      features: [
        sk,
        { id: 'ex1', kind: 'extrude', extrude: { sketch: '@sk1', distance: 5, direction: 'normal' } },
      ],
    })
    expect(h.res(result, 'ex1').status).toBe('ok')
    const g = gauges(result, 'body_ex1')
    expect(g.volume).toBeCloseTo(40 * 20 * 5 - Math.PI * (9 + 16) * 5, 2)
    expect(g.faces).toBe(8)
  })
})
