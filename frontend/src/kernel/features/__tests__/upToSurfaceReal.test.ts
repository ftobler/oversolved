// Gated real-OCC tests for the curved up_to trim, up_to_next and the
// up_to_start surface emboss/deboss (feature: extrude-up-to-surface).
//
// Fixture A is a cylinder R20 along Z (z 0..30). The profile footprint is the
// 10 x 20 rectangle x -5..5, z 5..25 on a plane y = const, so the transverse
// integral is the circle chord integral
//
//   I = integral_{-5}^{5} sqrt(400 - x^2) dx = 197.896877461
//
// and the un-offset up-to volume is I * 20 = 3957.93371. Every volume below is
// that closed form (or the offset surface's, R +- 0.5), not a measurement of
// this build.
//
// Skips when OCC.js is absent.

import { describe, it, expect } from 'vitest'
import { loadOcc } from '../../occ/loadOcc'
import { DisposeScope } from '../../occ/disposeScope'
import { HandleTable } from '../../occ/handleTable'
import {
  makeBezierEdge,
  makeBoxAt,
  makeCircleEdge,
  makeCylinder,
  makePrism,
  makeWire,
  faceSurfaceType,
  shapeBndBox,
  type Vec3,
} from '../../occ/primitives'
import { sortedFacesOf } from '../../occ/faceLoops'
import { booleanWithHistory, volumeOf } from '../../occ/booleans'
import { volumeForMeasure } from '../../occ/volume'
import { solidToEdges } from '../../occ/tessellation'
import { solveExtrude } from '../extrude'
import { sketchLoopsToFace } from '../../occ/prismLineage'
import {
  trimAtFace,
  trimAtNext,
  orientToFace,
  surfaceSlab,
  type NextCandidate,
} from '../upToSurface'
import { UP_TO_REACH } from '../upTo'
import type { Repository } from '../../query'
import type { Body } from '../../types3d'
import type { OccModule, OccShape } from '../../occ/occTypes'

const oc = await loadOcc()

const CHORD_I = 197.896685712
const Z_LEN = 20

function repoReturning(entry: unknown): Repository {
  return { query: () => entry } as unknown as Repository
}

/** A planar profile face on the Top frame at world y = planeY, local rectangle
 *  x0..x1, y0..y1 (local y runs along -world z). */
function topFace(
  occ2: OccModule,
  scope: DisposeScope,
  planeY: number,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
): OccShape {
  const plane = { origin: [0, planeY, 0] as Vec3, x_axis: [1, 0, 0] as Vec3, y_axis: [0, 0, -1] as Vec3, normal: [0, 1, 0] as Vec3 }
  const loop = [
    { kind: 'line', start: [x0, y0], end: [x1, y0] },
    { kind: 'line', start: [x1, y0], end: [x1, y1] },
    { kind: 'line', start: [x1, y1], end: [x0, y1] },
    { kind: 'line', start: [x0, y1], end: [x0, y0] },
  ]
  return sketchLoopsToFace(occ2, scope, [loop], plane)
}

function circleFace(occ2: OccModule, scope: DisposeScope, radius: number): OccShape {
  const edge = scope.track(makeCircleEdge(occ2, scope, [0, 0, 0], [0, 1, 0], [1, 0, 0], radius))
  const wire = scope.track(makeWire(occ2, scope, [edge]))
  const builder = scope.track(new occ2.BRepBuilderAPI_MakeFace_15(wire, true))
  expect(builder.IsDone()).toBe(true)
  return builder.Face()
}

function cylinderRadius(occ2: OccModule, scope: DisposeScope, face: OccShape): number {
  const adaptor = scope.track(new occ2.BRepAdaptor_Surface_2(face, true))
  return adaptor.Cylinder().Radius()
}

describe.skipIf(!oc)('extrude up_to on curved faces (real OCC)', () => {
  let occ2: OccModule
  if (oc) occ2 = oc

  function putBody(
    scope: DisposeScope,
    table: HandleTable,
    store: Record<string, Body>,
    id: string,
    shape: OccShape,
  ): Body {
    const body: Body = {
      id,
      created_by: id.replace(/^body_/, ''),
      modified_by: [],
      shape: table.register(scope.track(shape), id),
      sketch_id: 'sk',
      brep_diff: null,
      profile_queries: [],
    }
    store[id] = body
    return body
  }

  /** The straight edges of `body` lying wholly in the plane y = planeY, as the
   *  queries resolveProfileEdges takes. They bound one face of a box plinth. */
  function profileEdges(table: HandleTable, body: Body, planeY: number): string[] {
    const { edges, edge_queries } = solidToEdges(occ2, table, body.shape!, {
      createdBy: body.created_by, bodyId: body.id,
      profileQueries: body.profile_queries,
      edgeAncestry: body.edge_ancestry ?? null, edgeUuids: body.edge_uuids ?? null,
    })
    const out: string[] = []
    for (let i = 0; i < edges.length; i++) {
      const ed = edges[i]
      if (ed.kind !== 'line') continue
      if (Math.abs(ed.start[1] - planeY) < 1e-6 && Math.abs(ed.end[1] - planeY) < 1e-6) {
        out.push(edge_queries[i])
      }
    }
    return out
  }

  /** A thin box plinth behind the profile plane, giving an edge loop with the
   *  plan's x/z rectangle. `below` puts its material under the plane (a top
   *  face), otherwise above (a bottom face). */
  function plinthLoop(
    scope: DisposeScope,
    table: HandleTable,
    store: Record<string, Body>,
    planeY: number,
    x0: number,
    x1: number,
    z0: number,
    z1: number,
    below = true,
  ): string[] {
    const y0 = below ? planeY - 10 : planeY
    const body = putBody(scope, table, store, 'body_plinth', makeBoxAt(occ2, scope, [x0, y0, z0], x1 - x0, 10, z1 - z0))
    return profileEdges(table, body, planeY)
  }

  function cylinderBody(scope: DisposeScope, table: HandleTable, store: Record<string, Body>): number {
    const cyl = makeCylinder(occ2, scope, [0, 0, 0], [0, 0, 1], 20, 30)
    putBody(scope, table, store, 'body_cyl', cyl)
    const idx = sortedFacesOf(occ2, scope, table.get<OccShape>(store.body_cyl.shape!))
      .findIndex((f) => faceSurfaceType(occ2, scope, f) === 'cylinderface')
    expect(idx).toBeGreaterThanOrEqual(0)
    return idx
  }

  function volumeOfBody(scope: DisposeScope, table: HandleTable, store: Record<string, Body>, id: string): number {
    return volumeOf(occ2, scope, table.get<OccShape>(store[id].shape!))
  }

  function endCylinderFaces(scope: DisposeScope, table: HandleTable, store: Record<string, Body>, id: string): OccShape[] {
    return sortedFacesOf(occ2, scope, table.get<OccShape>(store[id].shape!))
      .filter((f) => faceSurfaceType(occ2, scope, f) === 'cylinderface')
  }

  it('trims a prism at a cylinder face, stopping at the near wall (test 1)', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const store: Record<string, Body> = {}
      const sideIndex = cylinderBody(scope, table, store)
      const loop = plinthLoop(scope, table, store, 0, -5, 5, 5, 25)
      expect(loop).toHaveLength(4)
      const result = solveExtrude(
        occ2, scope, table,
        { id: 'ex2', extrude: { sketch: loop, operation: 'new', termination: 'up_to', up_to: 'face_q' } },
        repoReturning({ type: 'face', body_id: 'body_cyl', face_index: sideIndex }),
        store,
      )
      expect(result.status).toBe('ok')
      expect(volumeOfBody(scope, table, store, 'body_ex2')).toBeCloseTo(CHORD_I * Z_LEN, 4)
      const cylFaces = endCylinderFaces(scope, table, store, 'body_ex2')
      expect(cylFaces).toHaveLength(1)
      expect(cylinderRadius(occ2, scope, cylFaces[0])).toBeCloseTo(20, 6)
    } finally {
      scope.dispose()
    }
  })

  it('offsets the curved stop surface by the material-signed up_to_offset (test 2)', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const store: Record<string, Body> = {}
      const sideIndex = cylinderBody(scope, table, store)
      const loop = plinthLoop(scope, table, store, 0, -5, 5, 5, 25)
      const target = { type: 'face', body_id: 'body_cyl', face_index: sideIndex }
      const run = (offset: number, id: string) => {
        const result = solveExtrude(
          occ2, scope, table,
          {
            id,
            extrude: {
              sketch: loop, operation: 'new', termination: 'up_to', up_to: 'face_q', up_to_offset: offset,
            },
          },
          repoReturning(target), store,
        )
        expect(result.status).toBe('ok')
        return volumeOfBody(scope, table, store, `body_${id}`)
      }
      const plus = run(0.5, 'ex_plus')
      const minus = run(-0.5, 'ex_minus')
      expect(plus).toBeCloseTo(4058.97892, 4)
      expect(minus).toBeCloseTo(3856.83328, 4)
      const plusFaces = endCylinderFaces(scope, table, store, 'body_ex_plus')
      const minusFaces = endCylinderFaces(scope, table, store, 'body_ex_minus')
      expect(plusFaces).toHaveLength(1)
      expect(minusFaces).toHaveLength(1)
      expect(cylinderRadius(occ2, scope, plusFaces[0])).toBeCloseTo(20.5, 6)
      expect(cylinderRadius(occ2, scope, minusFaces[0])).toBeCloseTo(19.5, 6)
    } finally {
      scope.dispose()
    }
  })

  it('embosses a raised slab from a sketch inside the material (test 3)', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const store: Record<string, Body> = {}
      const sideIndex = cylinderBody(scope, table, store)
      const before = volumeOfBody(scope, table, store, 'body_cyl')
      const loop = plinthLoop(scope, table, store, 0, -5, 5, 5, 25)
      const result = solveExtrude(
        occ2, scope, table,
        {
          id: 'ex3',
          extrude: {
            sketch: loop, operation: 'add', merge_target: 'body_cyl', termination: 'up_to',
            up_to: 'face_q', up_to_offset: 0.5,
          },
        },
        repoReturning({ type: 'face', body_id: 'body_cyl', face_index: sideIndex }), store,
      )
      expect(result.status).toBe('ok')
      expect(result.solver_warning).toBeUndefined()
      const after = volumeOfBody(scope, table, store, 'body_cyl')
      expect(after - before).toBeCloseTo(101.04521, 3)
      expect(Object.keys(store).filter((id) => id.startsWith('body_ex'))).toHaveLength(0)
    } finally {
      scope.dispose()
    }
  })

  it('debosses with a negative offset and does nothing with a positive one (test 4)', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const store: Record<string, Body> = {}
      const sideIndex = cylinderBody(scope, table, store)
      const before = volumeOfBody(scope, table, store, 'body_cyl')
      const loop = plinthLoop(scope, table, store, 30, -5, 5, 5, 25, false)
      const target = { type: 'face', body_id: 'body_cyl', face_index: sideIndex }
      const run = (offset: number, id: string) => solveExtrude(
        occ2, scope, table,
        {
          id,
          extrude: {
            sketch: loop, operation: 'cut', merge_target: 'body_cyl', direction: 'reverse',
            termination: 'up_to', up_to: 'face_q', up_to_offset: offset,
          },
        },
        repoReturning(target), store,
      )
      // The positive (air-side) slab runs first: it changes nothing, so the
      // cylinder face index stays valid for the deboss below it.
      const air = run(0.5, 'ex_air')
      expect(air.status).toBe('ok')
      expect(air.solver_warning).toContain('no geometry change')
      expect(volumeOfBody(scope, table, store, 'body_cyl')).toBeCloseTo(before, 6)
      const deboss = run(-0.5, 'ex_deboss')
      expect(deboss.status).toBe('ok')
      expect(volumeOfBody(scope, table, store, 'body_cyl')).toBeCloseTo(before - 101.10043, 3)
    } finally {
      scope.dispose()
    }
  })

  it('extends a face shorter than the swept profile and notes it (test 5)', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const store: Record<string, Body> = {}
      const sideIndex = cylinderBody(scope, table, store)
      const loop = plinthLoop(scope, table, store, 0, -5, 5, 5, 35)
      const result = solveExtrude(
        occ2, scope, table,
        { id: 'ex5', extrude: { sketch: loop, operation: 'new', termination: 'up_to', up_to: 'face_q' } },
        repoReturning({ type: 'face', body_id: 'body_cyl', face_index: sideIndex }), store,
      )
      expect(result.status).toBe('ok')
      expect(result.solver_note).toContain('trimmed at its extended surface')
      expect(volumeOfBody(scope, table, store, 'body_ex5')).toBeCloseTo(5936.90057, 4)
    } finally {
      scope.dispose()
    }
  })

  it('refuses a face narrower than the profile (test 5b)', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const store: Record<string, Body> = {}
      const sideIndex = cylinderBody(scope, table, store)
      const loop = plinthLoop(scope, table, store, 0, -25, 25, 5, 25)
      expect(() => solveExtrude(
        occ2, scope, table,
        { id: 'ex5b', extrude: { sketch: loop, operation: 'new', termination: 'up_to', up_to: 'face_q' } },
        repoReturning({ type: 'face', body_id: 'body_cyl', face_index: sideIndex }), store,
      )).toThrow(/does not cover the profile/)
    } finally {
      scope.dispose()
    }
  })

  it('moves a datum-plane target along the extrude by up_to_offset (test 15)', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const store: Record<string, Body> = {}
      const loop = plinthLoop(scope, table, store, 0, -5, 5, 5, 25)
      const result = solveExtrude(
        occ2, scope, table,
        {
          id: 'ex_plane',
          extrude: { sketch: loop, operation: 'new', termination: 'up_to', up_to: 'plane_q', up_to_offset: 1 },
        },
        repoReturning({ type: 'flatface', origin: [0, 7, 0], normal: [0, 1, 0] }), store,
      )
      expect(result.status).toBe('ok')
      expect(volumeOfBody(scope, table, store, 'body_ex_plane')).toBeCloseTo(10 * 20 * 8, 6)
    } finally {
      scope.dispose()
    }
  })

  it('flips when the curved target is behind the profile (test 8)', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const store: Record<string, Body> = {}
      const sideIndex = cylinderBody(scope, table, store)
      const cylFace = sortedFacesOf(occ2, scope, table.get<OccShape>(store.body_cyl.shape!))[sideIndex]
      const face = scope.track(topFace(occ2, scope, 30, -5, 5, -25, -5))
      const dir = orientToFace(occ2, scope, cylFace, [0, 30, 15], [0, 1, 0])
      expect(dir[1]).toBeCloseTo(-1, 6)
      const prism = scope.track(makePrism(occ2, scope, face, dir, UP_TO_REACH))
      const trimmed = trimAtFace(occ2, scope, prism, cylFace, dir)
      expect(volumeOf(occ2, scope, trimmed.shape)).toBeCloseTo((30 * 10 - CHORD_I) * Z_LEN, 4)
    } finally {
      scope.dispose()
    }
  })

  it('stops at the first crossing when the sketch is inside the cylinder (test 9)', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const store: Record<string, Body> = {}
      const sideIndex = cylinderBody(scope, table, store)
      const cylFace = sortedFacesOf(occ2, scope, table.get<OccShape>(store.body_cyl.shape!))[sideIndex]
      const face = scope.track(topFace(occ2, scope, -10, -5, 5, -25, -5))
      const dir = orientToFace(occ2, scope, cylFace, [0, -10, 15], [0, 1, 0])
      expect(dir[1]).toBeCloseTo(1, 6)
      const prism = scope.track(makePrism(occ2, scope, face, dir, UP_TO_REACH))
      const trimmed = trimAtFace(occ2, scope, prism, cylFace, dir)
      // From y = -10 to the upper crossing: I + 10 * 10 over the footprint.
      expect(volumeOf(occ2, scope, trimmed.shape)).toBeCloseTo((CHORD_I + 100) * Z_LEN, 4)
    } finally {
      scope.dispose()
    }
  })

  // ─── up_to_start: surface (the user's emboss workflow) ───

  it('embosses a slab from a sketch in front of the surface (test 15a)', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const store: Record<string, Body> = {}
      const sideIndex = cylinderBody(scope, table, store)
      const before = volumeOfBody(scope, table, store, 'body_cyl')
      const loop = plinthLoop(scope, table, store, 30, -5, 5, 5, 25, false)
      const result = solveExtrude(
        occ2, scope, table,
        {
          id: 'ex_emboss',
          extrude: {
            sketch: loop, operation: 'add', merge_target: 'body_cyl', direction: 'reverse',
            termination: 'up_to', up_to: 'face_q', up_to_start: 'surface', up_to_offset: 0.5,
          },
        },
        repoReturning({ type: 'face', body_id: 'body_cyl', face_index: sideIndex }), store,
      )
      expect(result.status).toBe('ok')
      expect(volumeOfBody(scope, table, store, 'body_cyl') - before).toBeCloseTo(101.04521, 3)
    } finally {
      scope.dispose()
    }
  })

  it('builds the emboss slab directly and never adds the far-side one (test 15a)', () => {
    const scope = new DisposeScope()
    try {
      const cyl = scope.track(makeCylinder(occ2, scope, [0, 0, 0], [0, 0, 1], 20, 30))
      const cylFace = sortedFacesOf(occ2, scope, cyl)
        .find((f) => faceSurfaceType(occ2, scope, f) === 'cylinderface')!
      const face = scope.track(topFace(occ2, scope, 0, -5, 5, -25, -5))
      const prism = scope.track(makePrism(occ2, scope, face, [0, 1, 0], UP_TO_REACH))
      const slab = surfaceSlab(occ2, scope, prism, [cylFace], [0, 1, 0], 0.5)
      expect(volumeOf(occ2, scope, slab.shape)).toBeCloseTo(101.04521, 4)
      const box = shapeBndBox(occ2, scope, slab.shape)
      // Only the near (upper) wall: the footprint's far crossing is not in it.
      expect(box.min[1]).toBeGreaterThan(19)
      expect(box.max[1]).toBeCloseTo(20.5, 3)
    } finally {
      scope.dispose()
    }
  })

  it('debosses the same slab with cut and a negative offset (test 15b)', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const store: Record<string, Body> = {}
      const sideIndex = cylinderBody(scope, table, store)
      const before = volumeOfBody(scope, table, store, 'body_cyl')
      const loop = plinthLoop(scope, table, store, 30, -5, 5, 5, 25, false)
      const result = solveExtrude(
        occ2, scope, table,
        {
          id: 'ex_deboss_surface',
          extrude: {
            sketch: loop, operation: 'cut', merge_target: 'body_cyl', direction: 'reverse',
            termination: 'up_to', up_to: 'face_q', up_to_start: 'surface', up_to_offset: -0.5,
          },
        },
        repoReturning({ type: 'face', body_id: 'body_cyl', face_index: sideIndex }), store,
      )
      expect(result.status).toBe('ok')
      expect(volumeOfBody(scope, table, store, 'body_cyl') - before).toBeCloseTo(-101.10043, 3)
    } finally {
      scope.dispose()
    }
  })

  it('gives the same emboss wherever the sketch plane sits (test 15c)', () => {
    const runAt = (planeY: number, below: boolean): number => {
      const scope = new DisposeScope()
      const table = new HandleTable()
      try {
        const store: Record<string, Body> = {}
        const sideIndex = cylinderBody(scope, table, store)
        const before = volumeOfBody(scope, table, store, 'body_cyl')
        const loop = plinthLoop(scope, table, store, planeY, -5, 5, 5, 25, below)
        const result = solveExtrude(
          occ2, scope, table,
          {
            id: 'ex_pos',
            extrude: {
              sketch: loop, operation: 'add', merge_target: 'body_cyl',
              termination: 'up_to', up_to: 'face_q', up_to_start: 'surface', up_to_offset: 0.5,
            },
          },
          repoReturning({ type: 'face', body_id: 'body_cyl', face_index: sideIndex }), store,
        )
        expect(result.status).toBe('ok')
        return volumeOfBody(scope, table, store, 'body_cyl') - before
      } finally {
        scope.dispose()
      }
    }
    expect(runAt(0, true)).toBeCloseTo(101.04521, 3)
    expect(runAt(50, false)).toBeCloseTo(101.04521, 3)
  })

  it('mints the slab as its own body with both cylinder walls (test 15d)', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const store: Record<string, Body> = {}
      const sideIndex = cylinderBody(scope, table, store)
      const loop = plinthLoop(scope, table, store, 30, -5, 5, 5, 25, false)
      const result = solveExtrude(
        occ2, scope, table,
        {
          id: 'ex_slab',
          extrude: {
            sketch: loop, operation: 'new', direction: 'reverse', termination: 'up_to',
            up_to: 'face_q', up_to_start: 'surface', up_to_offset: 0.5,
          },
        },
        repoReturning({ type: 'face', body_id: 'body_cyl', face_index: sideIndex }), store,
      )
      expect(result.status).toBe('ok')
      expect(volumeOfBody(scope, table, store, 'body_ex_slab')).toBeCloseTo(101.04521, 3)
      const radii = endCylinderFaces(scope, table, store, 'body_ex_slab')
        .map((f) => Number(cylinderRadius(occ2, scope, f).toFixed(4)))
        .sort((a, b) => a - b)
      expect(radii).toEqual([20, 20.5])
    } finally {
      scope.dispose()
    }
  })

  it('refuses surface mode without a non-zero offset, a face, or one-sided work (test 15f)', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const store: Record<string, Body> = {}
      const sideIndex = cylinderBody(scope, table, store)
      const loop = plinthLoop(scope, table, store, 0, -5, 5, 5, 25)
      const target = { type: 'face', body_id: 'body_cyl', face_index: sideIndex }
      expect(() => solveExtrude(
        occ2, scope, table,
        { id: 'x1', extrude: { sketch: loop, operation: 'new', termination: 'up_to', up_to: 'face_q', up_to_start: 'surface' } },
        repoReturning(target), store,
      )).toThrow(/non-zero up_to_offset/)
      expect(() => solveExtrude(
        occ2, scope, table,
        {
          id: 'x2',
          extrude: {
            sketch: loop, operation: 'new', termination: 'up_to', up_to: 'plane_q',
            up_to_start: 'surface', up_to_offset: 0.5,
          },
        },
        repoReturning({ type: 'flatface', origin: [0, 7, 0], normal: [0, 1, 0] }), store,
      )).toThrow(/datum plane or point/)
      expect(() => solveExtrude(
        occ2, scope, table,
        {
          id: 'x3',
          extrude: {
            sketch: loop, operation: 'new', direction: 'symmetric', termination: 'up_to',
            up_to: 'face_q', up_to_start: 'surface', up_to_offset: 0.5,
          },
        },
        repoReturning(target), store,
      )).toThrow(/symmetric/)
    } finally {
      scope.dispose()
    }
  })

  it('embosses and debosses a plain box through up_to_next surface (test 15e)', () => {
    const run = (operation: 'add' | 'cut', offset: number): number => {
      const scope = new DisposeScope()
      const table = new HandleTable()
      try {
        const store: Record<string, Body> = {}
        const box = makeBoxAt(occ2, scope, [-20, 0, -20], 40, 10, 40)
        putBody(scope, table, store, 'body_box', box)
        const before = volumeOfBody(scope, table, store, 'body_box')
        const loop = plinthLoop(scope, table, store, 20, -5, 5, -5, 5, false)
        const result = solveExtrude(
          occ2, scope, table,
          {
            id: 'ex_next_surface',
            extrude: {
              sketch: loop, operation, merge_target: 'body_box', direction: 'reverse',
              termination: 'up_to_next', up_to_start: 'surface', up_to_offset: offset,
            },
          },
          repoReturning(null), store,
        )
        expect(result.status).toBe('ok')
        return volumeOfBody(scope, table, store, 'body_box') - before
      } finally {
        scope.dispose()
      }
    }
    expect(run('add', 0.5)).toBeCloseTo(50, 4)
    expect(run('cut', -0.5)).toBeCloseTo(-50, 4)
  })

  it('refuses a taper with either up-to mode (test 18)', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const store: Record<string, Body> = {}
      const sideIndex = cylinderBody(scope, table, store)
      const loop = plinthLoop(scope, table, store, 0, -5, 5, 5, 25)
      for (const termination of ['up_to', 'up_to_next']) {
        expect(() => solveExtrude(
          occ2, scope, table,
          {
            id: `ex_taper_${termination}`,
            extrude: {
              sketch: loop, operation: 'new', termination, taper: 10,
              ...(termination === 'up_to' ? { up_to: 'face_q' } : {}),
            },
          },
          repoReturning({ type: 'face', body_id: 'body_cyl', face_index: sideIndex }), store,
        )).toThrow(/taper is not supported/)
      }
    } finally {
      scope.dispose()
    }
  })

  // ─── up_to_next ───

  it('stops at a hollow box ceiling and follows its offset (test 10)', () => {
    const scope = new DisposeScope()
    try {
      const outer = scope.track(makeBoxAt(occ2, scope, [-20, 0, -20], 40, 20, 40))
      const cavity = scope.track(makeBoxAt(occ2, scope, [-18, 2, -18], 36, 16, 36))
      const hollow = booleanWithHistory(occ2, scope, outer, cavity, 'cut').shape
      const candidates: NextCandidate[] = [{ id: 'body_hollow', shape: hollow, imported: false }]
      const run = (offset: number): number => {
        const face = scope.track(topFace(occ2, scope, 2, -15, 15, -0.5, 0.5))
        const tool = scope.track(makePrism(occ2, scope, face, [0, 1, 0], UP_TO_REACH))
        const trimmed = trimAtNext(occ2, scope, tool, candidates, [0, 1, 0], [0, 2, 0], offset)
        return volumeOf(occ2, scope, trimmed.shape)
      }
      expect(run(0)).toBeCloseTo(480, 4)
      expect(run(-0.5)).toBeCloseTo(495, 4)
      expect(run(0.5)).toBeCloseTo(465, 4)
    } finally {
      scope.dispose()
    }
  })

  it('cuts a plain box 0.5 past the first body with a negative next offset (test 12)', () => {
    const scope = new DisposeScope()
    try {
      const box = scope.track(makeBoxAt(occ2, scope, [-20, 0, -20], 40, 10, 40))
      const candidates: NextCandidate[] = [{ id: 'body_box', shape: box, imported: false }]
      const toolAt = (offset: number): OccShape => {
        const face = scope.track(topFace(occ2, scope, 20, -5, 5, -5, 5))
        const tool = scope.track(makePrism(occ2, scope, face, [0, -1, 0], UP_TO_REACH))
        return trimAtNext(occ2, scope, tool, candidates, [0, -1, 0], [0, 20, 0], offset).shape
      }
      const before = volumeOf(occ2, scope, box)
      const cutDeep = scope.track(booleanWithHistory(occ2, scope, box, toolAt(-0.5), 'cut').shape)
      expect(before - volumeOf(occ2, scope, cutDeep)).toBeCloseTo(50, 4)
      // With no offset the tool ends on the face: a zero-thickness removal.
      const cutAt = scope.track(booleanWithHistory(occ2, scope, box, toolAt(0), 'cut').shape)
      expect(volumeOf(occ2, scope, cutAt)).toBeCloseTo(before, 4)
    } finally {
      scope.dispose()
    }
  })

  it('names a profile that starts inside material or meets no body (test 13)', () => {
    const scope = new DisposeScope()
    try {
      const box = scope.track(makeBoxAt(occ2, scope, [-20, 0, -20], 40, 10, 40))
      const candidates: NextCandidate[] = [{ id: 'body_box', shape: box, imported: false }]
      const inside = scope.track(topFace(occ2, scope, 5, -5, 5, -5, 5))
      const insideTool = scope.track(makePrism(occ2, scope, inside, [0, 1, 0], UP_TO_REACH))
      expect(() => trimAtNext(occ2, scope, insideTool, candidates, [0, 1, 0], [0, 5, 0], 0))
        .toThrow(/starts inside body_box/)
      const away = scope.track(topFace(occ2, scope, 20, -5, 5, -5, 5))
      const awayTool = scope.track(makePrism(occ2, scope, away, [0, 1, 0], UP_TO_REACH))
      expect(() => trimAtNext(occ2, scope, awayTool, candidates, [0, 1, 0], [0, 20, 0], 0))
        .toThrow(/meets no body/)
    } finally {
      scope.dispose()
    }
  })

  it('narrows next to merge_target and ignores a body below it (test 14)', () => {
    const scope = new DisposeScope()
    try {
      const lower = scope.track(makeBoxAt(occ2, scope, [-20, 0, -20], 40, 5, 40))
      const upper = scope.track(makeBoxAt(occ2, scope, [-20, 5, -20], 40, 5, 40))
      const face = scope.track(topFace(occ2, scope, -1, -5, 5, -5, 5))
      const tool = scope.track(makePrism(occ2, scope, face, [0, 1, 0], UP_TO_REACH))
      const both = trimAtNext(
        occ2, scope, tool,
        [
          { id: 'body_lower', shape: lower, imported: false },
          { id: 'body_upper', shape: upper, imported: false },
        ],
        [0, 1, 0], [0, -1, 0], 0,
      )
      expect(volumeOf(occ2, scope, both.shape)).toBeCloseTo(100, 4)
      const toolUpper = scope.track(makePrism(occ2, scope, face, [0, 1, 0], UP_TO_REACH))
      const upperOnly = trimAtNext(
        occ2, scope, toolUpper,
        [{ id: 'body_upper', shape: upper, imported: false }],
        [0, 1, 0], [0, -1, 0], 0,
      )
      expect(volumeOf(occ2, scope, upperOnly.shape)).toBeCloseTo(600, 4)
    } finally {
      scope.dispose()
    }
  })

  it('trims at a cylindrical tunnel top plus its flat ceiling (test 11)', () => {
    const scope = new DisposeScope()
    try {
      const outer = scope.track(makeBoxAt(occ2, scope, [-20, 0, -20], 40, 20, 40))
      const cavity = scope.track(makeBoxAt(occ2, scope, [-18, 2, -18], 36, 10, 36))
      const withCavity = booleanWithHistory(occ2, scope, outer, cavity, 'cut').shape
      // A tunnel across X, centre (y = 15, z = 0), R4: its lower surface dips
      // below the flat cavity ceiling (y = 12) in the middle, so a wide
      // footprint stops on both the curved face and the flat ceiling.
      const tunnel = scope.track(makeCylinder(occ2, scope, [-20, 15, 0], [1, 0, 0], 4, 40))
      const body = scope.track(booleanWithHistory(occ2, scope, withCavity, tunnel, 'cut').shape)
      const candidates: NextCandidate[] = [{ id: 'body_dish', shape: body, imported: false }]
      const face = scope.track(topFace(occ2, scope, 2, -2, 2, -6, 6))
      const tool = scope.track(makePrism(occ2, scope, face, [0, 1, 0], UP_TO_REACH))
      const trimmed = trimAtNext(occ2, scope, tool, candidates, [0, 1, 0], [0, 2, 0], 0)
      // Independent oracle: the rib is the part of the same tall prism inside
      // the void (the cavity box fused with the tunnel), built below.
      const voidSolid = scope.track(booleanWithHistory(occ2, scope, cavity, tunnel, 'fuse').shape)
      const reference = scope.track(booleanWithHistory(occ2, scope, tool, voidSolid, 'common').shape)
      expect(volumeOf(occ2, scope, trimmed.shape)).toBeCloseTo(volumeOf(occ2, scope, reference), 6)
    } finally {
      scope.dispose()
    }
  })

  it('trims at a lofted B-spline wall and matches the OCCT oracle (test 7)', () => {
    // The wall is the ruled loft between two identical cubic Bezier curves at
    // z = 0 and z = 20 (poles x 0/13/27/40, y -6/6/-6/0). The oracle is the same
    // Bezier -> wire -> BRepOffsetAPI_ThruSections -> prism -> Splitter recipe
    // run in CadQuery's OCCT wrapper (tmp/freeformOracle.py), measured with
    // Gauss-Kronrod: 6186.712950648801. A dense Bernstein integral of
    // 10 * integral (30 - y(x)) dx over x 10..30 gives 6186.712950616831, so
    // the two agree to 5e-12 relative; the test allows 1e-6.
    const ORACLE = 6186.712950648801
    const scope = new DisposeScope()
    try {
      const poles = (z: number): Vec3[] => [
        [0, -6, z], [13, 6, z], [27, -6, z], [40, 0, z],
      ]
      const wire0 = scope.track(makeWire(occ2, scope, [scope.track(makeBezierEdge(occ2, scope, poles(0)))]))
      const wire1 = scope.track(makeWire(occ2, scope, [scope.track(makeBezierEdge(occ2, scope, poles(20)))]))
      const loft = scope.track(new occ2.BRepOffsetAPI_ThruSections(false, true, 1e-6))
      loft.CheckCompatibility(false)
      loft.AddWire(wire0)
      loft.AddWire(wire1)
      loft.Build()
      expect(loft.IsDone()).toBe(true)
      const wallFaces = sortedFacesOf(occ2, scope, loft.Shape())
      expect(wallFaces).toHaveLength(1)
      expect(faceSurfaceType(occ2, scope, wallFaces[0])).not.toBe('flatface')
      const face = scope.track(topFace(occ2, scope, 30, 10, 30, -15, -5))
      const dir = orientToFace(occ2, scope, wallFaces[0], [20, 30, 10], [0, -1, 0])
      expect(dir[1]).toBeCloseTo(-1, 6)
      const prism = scope.track(makePrism(occ2, scope, face, dir, UP_TO_REACH))
      const trimmed = trimAtFace(occ2, scope, prism, wallFaces[0], dir)
      const volume = volumeForMeasure(occ2, scope, trimmed.shape)
      expect(Math.abs(volume - ORACLE) / ORACLE).toBeLessThan(1e-6)
    } finally {
      scope.dispose()
    }
  })

  it('trims at a sphere face through a circular profile (test 6)', () => {
    const scope = new DisposeScope()
    try {
      const sphereBuilder = scope.track(new occ2.BRepPrimAPI_MakeSphere_5(scope.track(new occ2.gp_Pnt_3(0, 0, 0)), 20))
      const sphere = sphereBuilder.Shape()
      const sphereFace = sortedFacesOf(occ2, scope, sphere)
        .find((f) => faceSurfaceType(occ2, scope, f) === 'sphereface')
      expect(sphereFace).toBeDefined()
      const face = scope.track(circleFace(occ2, scope, 5))
      const dir = orientToFace(occ2, scope, sphereFace!, [0, 0, 0], [0, 1, 0])
      const prism = scope.track(makePrism(occ2, scope, face, dir, UP_TO_REACH))
      const trimmed = trimAtFace(occ2, scope, prism, sphereFace!, dir)
      expect(volumeOf(occ2, scope, trimmed.shape)).toBeCloseTo(1545.99078, 3)
    } finally {
      scope.dispose()
    }
  })
})
