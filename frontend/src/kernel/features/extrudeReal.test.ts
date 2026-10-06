// @vitest-environment node
//
// Gated real-OCC feature-level extrude tests using the full build pipeline
// (OCC.js + Rust WASM sketch solver). Ports the build-layer extrude scenarios
// from test_extrude_mesh.py.
//
// Split by describe group from the original 1.3k-line file; the shared spec
// builders live in extrudeRealSupport.ts. This file covers basic mesh/bbox,
// nested UI / bare plane ids, stacked extrudes, surface queries, picked sketch
// entities and profile lists.
//
// Skips when OCC.js or the Rust solver is absent.

import { describe, it, expect } from 'vitest'
import { makeAncestryQuery } from '../query'
import {
  oc, solveBytes, extrudeTestHarness, rectSketchSk, extrudeSpec, fullRectExtrudeSpec,
  assertMeshValid, assertMeshBbox,
} from './extrudeRealSupport'

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

  it('extrude sketch not found returns exception', () => {
    // Extrude with a sketch ref that has no closed profile returns exception.
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
    expect(h.res(result, 'ex1').status).toBe('exception')
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
