// Gated real-OCC tests for extrude "up to" termination (feature: extrude-up-to).
// Reuses the box + edge-loop-profile harness: a coplanar face at z=0, extruded
// up to a plane offset along its normal, must terminate exactly on that plane.
// Skips when OCC.js is absent.

import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from '../../occ/loadOcc'
import { DisposeScope } from '../../occ/disposeScope'
import { HandleTable } from '../../occ/handleTable'
import { makeBox, makePrism, makeCylinder, faceCentroid, faceNormal, faceSurfaceType, type Vec3 } from '../../occ/primitives'
import { sortedFacesOf, computeFacePlane } from '../../occ/faceLoops'
import { volumeOf } from '../../occ/booleans'
import { solidToEdges } from '../../occ/tessellation'
import { resolveProfileEdges, edgesToProfileFace } from '../edgeProfile'
import { trimAtPlane, resolveUpToPlane } from '../upTo'
import { solveExtrude } from '../extrude'
import { AmbiguousQueryError, initGlobalRepo, makeAncestryQuery } from '../../query'
import type { Repository } from '../../query'
import type { Body } from '../../types3d'
import type { OccModule, OccShape } from '../../occ/occTypes'

const oc = await loadOcc()

function repoReturning(entry: unknown): Repository {
  return { query: () => entry } as unknown as Repository
}

describe.skipIf(!oc)('extrude up-to termination (real OCC)', () => {
  let occ: OccModule
  beforeAll(() => {
    if (!oc) throw new Error('unreachable: skipIf guards this')
    occ = oc
  })

  function makeBoxBody(scope: DisposeScope, table: HandleTable): Record<string, Body> {
    const box = makeBox(occ, scope, 10, 10, 10)
    return {
      body_b: {
        id: 'body_b', created_by: 'ex1', modified_by: [],
        shape: table.register(box, 'ex1'), sketch_id: 'sk',
        brep_diff: null, profile_queries: [],
      },
    }
  }

  function bottomLoop(table: HandleTable, body: Body): string[] {
    const { edges, edge_queries } = solidToEdges(occ, table, body.shape!, {
      createdBy: body.created_by, bodyId: body.id,
      profileQueries: body.profile_queries,
      edgeAncestry: body.edge_ancestry ?? null, edgeUuids: body.edge_uuids ?? null,
    })
    const out: string[] = []
    for (let i = 0; i < edges.length; i++) {
      const ed = edges[i]
      if (ed.kind === 'line' && Math.abs(ed.start[2]) < 1e-6 && Math.abs(ed.end[2]) < 1e-6) {
        out.push(edge_queries[i])
      }
    }
    return out
  }

  it('trimAtPlane truncates an over-length prism exactly at the plane', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const bodyStore = makeBoxBody(scope, table)
      const face = edgesToProfileFace(occ, scope, resolveProfileEdges(occ, scope, table, bottomLoop(table, bodyStore.body_b), bodyStore))
      const n = faceNormal(occ, scope, face) as Vec3
      const prism = makePrism(occ, scope, face, n, 1e4)
      // Plane offset 7 along the face normal from the z=0 profile.
      const origin: Vec3 = [0, 0, 7 * n[2]]
      const trimmed = trimAtPlane(occ, scope, prism, { origin, normal: n }, n).shape
      expect(volumeOf(occ, scope, trimmed)).toBeCloseTo(700, 2)
    } finally {
      scope.dispose()
    }
  })

  it('throws when the trimming half-space misses the solid entirely', () => {
    // A plane behind the profile puts the keep side nowhere near the prism, so
    // the Common yields no solid. The guard must fail loud rather than return
    // an empty shape the caller registers as a body.
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const bodyStore = makeBoxBody(scope, table)
      const face = edgesToProfileFace(occ, scope, resolveProfileEdges(occ, scope, table, bottomLoop(table, bodyStore.body_b), bodyStore))
      const dir: Vec3 = [0, 0, 1]
      const prism = makePrism(occ, scope, face, dir, 1e4)
      // Keep side is -dir (z <= -5000); the prism spans z >= 0.
      expect(() => trimAtPlane(occ, scope, prism, { origin: [0, 0, -5000], normal: dir }, dir))
        .toThrow(/boolean Common produced no solid/)
    } finally {
      scope.dispose()
    }
  })

  it('terminates on a plane NOT parallel to the profile (slanted cut)', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const bodyStore = makeBoxBody(scope, table)
      // z=0 square, x,y in [0,10].
      const face = edgesToProfileFace(occ, scope, resolveProfileEdges(occ, scope, table, bottomLoop(table, bodyStore.body_b), bodyStore))
      const dir: Vec3 = [0, 0, 1]
      const prism = makePrism(occ, scope, face, dir, 1e4)
      // Plane through z=5 at y=0, tilted 45deg in y: z_top = 5 + y. Whole profile
      // is below it, so the result is a wedge, not a box.
      const s = Math.SQRT1_2
      const trimmed = trimAtPlane(occ, scope, prism, { origin: [0, 0, 5], normal: [0, -s, s] }, dir).shape
      // Volume = 10 * integral_0^10 (5 + y) dy = 10 * (50 + 50) = 1000.
      expect(volumeOf(occ, scope, trimmed)).toBeCloseTo(1000, 1)
    } finally {
      scope.dispose()
    }
  })

  it('solveExtrude up_to ignores blind distance and terminates at the plane', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const bodyStore = makeBoxBody(scope, table)
      const loop = bottomLoop(table, bodyStore.body_b)
      // Find the profile normal so the up-to plane sits 7 ahead of it.
      const face = edgesToProfileFace(occ, scope, resolveProfileEdges(occ, scope, table, loop, bodyStore))
      const n = faceNormal(occ, scope, face) as Vec3
      const c = faceCentroid(occ, scope, face)
      const planeEntry = { type: 'flatface', origin: [c[0] + 7 * n[0], c[1] + 7 * n[1], c[2] + 7 * n[2]], normal: n }

      const result = solveExtrude(
        occ, scope, table,
        { id: 'ex2', extrude: { sketch: loop, distance: 999, termination: 'up_to', up_to: 'plane_q', operation: 'new' } },
        repoReturning(planeEntry), bodyStore,
      )
      expect(result.status).toBe('ok')
      const vol = volumeOf(occ, scope, table.get<OccShape>(bodyStore.body_ex2.shape!))
      expect(vol).toBeCloseTo(700, 2)  // 100 area * 7, not 100 * 999
    } finally {
      scope.dispose()
    }
  })

  it('auto-reverses when the up_to target is behind the extrude direction', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const bodyStore = makeBoxBody(scope, table)
      const loop = bottomLoop(table, bodyStore.body_b)
      const face = edgesToProfileFace(occ, scope, resolveProfileEdges(occ, scope, table, loop, bodyStore))
      const n = faceNormal(occ, scope, face) as Vec3
      const c = faceCentroid(occ, scope, face)
      // Plane 5 behind the profile along the extrude direction: the pick, not the
      // direction toggle, decides which way the material grows.
      const planeEntry = { type: 'flatface', origin: [c[0] - 5 * n[0], c[1] - 5 * n[1], c[2] - 5 * n[2]], normal: n }
      const result = solveExtrude(
        occ, scope, table,
        { id: 'ex2', extrude: { sketch: loop, distance: 999, termination: 'up_to', up_to: 'plane_q', operation: 'new' } },
        repoReturning(planeEntry), bodyStore,
      )
      expect(result.status).toBe('ok')
      const vol = volumeOf(occ, scope, table.get<OccShape>(bodyStore.body_ex2.shape!))
      expect(vol).toBeCloseTo(500, 2)  // 100 area * 5, swept backwards
    } finally {
      scope.dispose()
    }
  })

  it('errors when the up_to target passes through the profile', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const bodyStore = makeBoxBody(scope, table)
      const loop = bottomLoop(table, bodyStore.body_b)
      const face = edgesToProfileFace(occ, scope, resolveProfileEdges(occ, scope, table, loop, bodyStore))
      const n = faceNormal(occ, scope, face) as Vec3
      const c = faceCentroid(occ, scope, face)
      const planeEntry = { type: 'flatface', origin: [c[0], c[1], c[2]], normal: n }
      expect(() =>
        solveExtrude(
          occ, scope, table,
          { id: 'ex2', extrude: { sketch: loop, distance: 5, termination: 'up_to', up_to: 'plane_q', operation: 'new' } },
          repoReturning(planeEntry), bodyStore,
        ),
      ).toThrow(/no distance to extrude/)
    } finally {
      scope.dispose()
    }
  })

  it('resolves a planar body-face up_to target through its OCC plane', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const bodyStore = makeBoxBody(scope, table)
      const loop = bottomLoop(table, bodyStore.body_b)
      const faces = sortedFacesOf(occ, scope, table.get<OccShape>(bodyStore.body_b.shape!))
      const topIdx = faces.findIndex((f) => faceNormal(occ, scope, f)[2] > 0.9)
      expect(topIdx).toBeGreaterThanOrEqual(0)

      const result = solveExtrude(
        occ, scope, table,
        { id: 'ex2', extrude: { sketch: loop, distance: 999, termination: 'up_to', up_to: 'face_q', operation: 'new' } },
        // A repo face entry carrying body_id + face_index; the resolver reads the
        // face's own OCC plane and terminates the 10-tall box prism on it.
        repoReturning({ type: 'face', body_id: 'body_b', face_index: topIdx }),
        bodyStore,
      )
      expect(result.status).toBe('ok')
      const vol = volumeOf(occ, scope, table.get<OccShape>(bodyStore.body_ex2.shape!))
      expect(vol).toBeCloseTo(1000, 2)
    } finally {
      scope.dispose()
    }
  })

  it('resolves the persisted slash body-face ref against the real body', () => {
    // The authoring spelling `@<body>/face/<n>` is a literal repo key for a plain
    // query, while body faces register under the construction key. The plain
    // lookup returns null, so this pins the helper path the resolver now takes.
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const bodyStore = makeBoxBody(scope, table)
      const repo = initGlobalRepo()
      const ref = '@body_b/face/2'
      expect(repo.query(ref)).toBeNull()

      const cut = resolveUpToPlane(occ, scope, table, ref, [0, 0, 1], repo, bodyStore)
      expect(cut).not.toBeNull()
      const faces = sortedFacesOf(occ, scope, table.get<OccShape>(bodyStore.body_b.shape!))
      const plane = computeFacePlane(occ, scope, faces[2])
      const n = cut!.normal
      const parallel = n[0] * plane.normal[0] + n[1] * plane.normal[1] + n[2] * plane.normal[2]
      expect(Math.abs(parallel)).toBeCloseTo(1, 6)
      const offset =
        (cut!.origin[0] - plane.origin[0]) * plane.normal[0] +
        (cut!.origin[1] - plane.origin[1]) * plane.normal[1] +
        (cut!.origin[2] - plane.origin[2]) * plane.normal[2]
      expect(offset).toBeCloseTo(0, 6)
    } finally {
      scope.dispose()
    }
  })

  it('resolves a registered body vertex as a point terminator', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const repo = initGlobalRepo()
      // The payload _registerBrepVertexAncestry writes: a body vertex carries
      // `origin`, never `point`/`position`.
      repo.registerAncestor(['@body_b/vertex0'], {
        type: 'vertex', body_id: 'body_b', vertex_index: 0, origin: [1, 2, 8],
      })
      const ref = makeAncestryQuery(['@body_b/vertex0'], 'vertex')
      const cut = resolveUpToPlane(occ, scope, table, ref, [0, 0, 1], repo, {})
      expect(cut).toEqual({ origin: [1, 2, 8], normal: [0, 0, 1] })
    } finally {
      scope.dispose()
    }
  })

  it('resolves a registered sketch point as a point terminator', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const repo = initGlobalRepo()
      // postRegister writes the sketch point under `<sketch>/<entity>/xy` with
      // `external_xy`; getPoint3d lifts it through the registered sketch plane.
      repo.register('_pt_sk1', {
        origin: [10, 0, 5], x_axis: [1, 0, 0], y_axis: [0, 1, 0], normal: [0, 0, 1],
      })
      repo.register('sk1/p1/xy', { external_xy: [2, 3], sketch_id: 'sk1' })
      const cut = resolveUpToPlane(occ, scope, table, '@sk1/p1/xy', [0, 0, 1], repo, {})
      expect(cut).toEqual({ origin: [12, 3, 5], normal: [0, 0, 1] })
    } finally {
      scope.dispose()
    }
  })

  it('warns when termination is up_to but no target is set', () => {
    // The staged editor hides distance while up_to has no pick. Falling back to
    // the blind distance is correct, but it has to be named like every other
    // fallback.
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const bodyStore = makeBoxBody(scope, table)
      const loop = bottomLoop(table, bodyStore.body_b)
      const result = solveExtrude(
        occ, scope, table,
        { id: 'ex2', extrude: { sketch: loop, distance: 3, termination: 'up_to', operation: 'new' } },
        repoReturning(null), bodyStore,
      )
      expect(result.status).toBe('ok')
      expect(result.solver_warning).toContain('up_to has no target; used blind distance')
      const vol = volumeOf(occ, scope, table.get<OccShape>(bodyStore.body_ex2.shape!))
      expect(vol).toBeCloseTo(300, 2)
    } finally {
      scope.dispose()
    }
  })

  it('ignores up_to when termination is not up_to', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const bodyStore = makeBoxBody(scope, table)
      const loop = bottomLoop(table, bodyStore.body_b)
      const result = solveExtrude(
        occ, scope, table,
        { id: 'ex2', extrude: { sketch: loop, distance: 3, up_to: 'plane_q', operation: 'new' } },
        // A target seven ahead would give 700 if it were read; blind distance is 300.
        repoReturning({ type: 'flatface', origin: [0, 0, 7], normal: [0, 0, 1] }),
        bodyStore,
      )
      expect(result.status).toBe('ok')
      expect(result.solver_warning).toBeUndefined()
      const vol = volumeOf(occ, scope, table.get<OccShape>(bodyStore.body_ex2.shape!))
      expect(vol).toBeCloseTo(300, 2)
    } finally {
      scope.dispose()
    }
  })

  it('solves an extrude that terminates on the slash body-face ref', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const bodyStore = makeBoxBody(scope, table)
      const loop = bottomLoop(table, bodyStore.body_b)
      const faces = sortedFacesOf(occ, scope, table.get<OccShape>(bodyStore.body_b.shape!))
      const topIdx = faces.findIndex((f) => faceNormal(occ, scope, f)[2] > 0.9)
      expect(topIdx).toBeGreaterThanOrEqual(0)

      const result = solveExtrude(
        occ, scope, table,
        {
          id: 'ex2',
          extrude: {
            sketch: loop, distance: 999, termination: 'up_to',
            up_to: `@body_b/face/${topIdx}`, operation: 'new',
          },
        },
        initGlobalRepo(), bodyStore,
      )
      expect(result.status).toBe('ok')
      expect(result.solver_warning).toBeUndefined()
      const vol = volumeOf(occ, scope, table.get<OccShape>(bodyStore.body_ex2.shape!))
      expect(vol).toBeCloseTo(1000, 2)
    } finally {
      scope.dispose()
    }
  })

  it('uses the named body plane for a slash face on another body', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const bodyStore = makeBoxBody(scope, table)
      // A 6-tall cylinder at x=40: its top plane (z=6) differs from the box's
      // top plane (z=10), so a resolver reading the wrong body is visible.
      const cyl = makeCylinder(occ, scope, [40, 0, 0], [0, 0, 1], 5, 6)
      bodyStore.body_cyl = {
        id: 'body_cyl', created_by: 'cy1', modified_by: [],
        shape: table.register(cyl, 'cy1'), sketch_id: 'skc',
        brep_diff: null, profile_queries: [],
      }
      const cylFaces = sortedFacesOf(occ, scope, cyl)
      const topIdx = cylFaces.findIndex((f) => faceNormal(occ, scope, f)[2] > 0.9)
      expect(topIdx).toBeGreaterThanOrEqual(0)

      const cut = resolveUpToPlane(
        occ, scope, table, `@body_cyl/face/${topIdx}`, [0, 0, 1], initGlobalRepo(), bodyStore,
      )
      expect(cut).not.toBeNull()
      expect(cut!.origin[2]).toBeCloseTo(6, 6)
      expect(cut!.normal[2]).toBeCloseTo(1, 6)
    } finally {
      scope.dispose()
    }
  })

  it('names the up-to contract when a slash face is not planar', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const bodyStore = makeBoxBody(scope, table)
      const cyl = makeCylinder(occ, scope, [40, 0, 0], [0, 0, 1], 5, 10)
      bodyStore.body_cyl = {
        id: 'body_cyl', created_by: 'cy1', modified_by: [],
        shape: table.register(cyl, 'cy1'), sketch_id: 'skc',
        brep_diff: null, profile_queries: [],
      }
      const sideIdx = sortedFacesOf(occ, scope, cyl)
        .findIndex((f) => faceSurfaceType(occ, scope, f) === 'cylinderface')
      expect(sideIdx).toBeGreaterThanOrEqual(0)

      expect(() =>
        resolveUpToPlane(
          occ, scope, table, `@body_cyl/face/${sideIdx}`, [0, 0, 1], initGlobalRepo(), bodyStore,
        ),
      ).toThrow(/extrude up_to: target face is not planar/)
    } finally {
      scope.dispose()
    }
  })

  it('lifts a sketch point through a tilted sketch plane', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const c = Math.SQRT1_2
      const repo = initGlobalRepo()
      repo.register('_pt_sk1', {
        origin: [1, 2, 3], x_axis: [1, 0, 0], y_axis: [0, c, c], normal: [0, -c, c],
      })
      repo.register('sk1/p1/xy', { external_xy: [2, 4], sketch_id: 'sk1' })
      const cut = resolveUpToPlane(occ, scope, table, '@sk1/p1/xy', [0, 0, 1], repo, {})
      expect(cut).not.toBeNull()
      expect(cut!.origin[0]).toBeCloseTo(3, 6)
      expect(cut!.origin[1]).toBeCloseTo(2 + 4 * c, 6)
      expect(cut!.origin[2]).toBeCloseTo(3 + 4 * c, 6)
    } finally {
      scope.dispose()
    }
  })

  it('keeps the no-target warning alongside the join-touch warning', () => {
    // A 2 x 2 x 2 tool fully inside the 10-box also touches the inner body it
    // was taken from, so the add appends its own warning. The up_to fallback
    // must survive the composition, not be replaced by it.
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const bodyStore = makeBoxBody(scope, table)
      const inner = makeBox(occ, scope, 2, 2, 2)
      const innerBody: Body = {
        id: 'body_inner', created_by: 'in1', modified_by: [],
        shape: table.register(inner, 'in1'), sketch_id: 'ski',
        brep_diff: null, profile_queries: [],
      }
      // The profile edges name this body, so its entry must resolve in the store.
      bodyStore.body_inner = innerBody
      const loop = bottomLoop(table, innerBody)
      const result = solveExtrude(
        occ, scope, table,
        { id: 'ex2', extrude: { sketch: loop, distance: 2, termination: 'up_to', operation: 'add' } },
        repoReturning(null), bodyStore,
      )
      expect(result.status).toBe('ok')
      expect(result.solver_warning).toContain('up_to has no target; used blind distance')
      expect(result.solver_warning).toContain('also touches body_inner')
    } finally {
      scope.dispose()
    }
  })

  it('throws when the up_to target body face is not planar', () => {
    // v1 supports planar terminators only; a cylindrical target face must fail
    // loud by name rather than be treated as an unresolved pick and quietly
    // extrude the blind distance.
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const bodyStore = makeBoxBody(scope, table)
      const loop = bottomLoop(table, bodyStore.body_b)
      const cyl = makeCylinder(occ, scope, [40, 0, 0], [0, 0, 1], 5, 10)
      bodyStore.body_cyl = {
        id: 'body_cyl', created_by: 'cy1', modified_by: [],
        shape: table.register(cyl, 'cy1'), sketch_id: 'skc',
        brep_diff: null, profile_queries: [],
      }
      const cfaces = sortedFacesOf(occ, scope, cyl)
      const sideIdx = cfaces.findIndex((f) => faceSurfaceType(occ, scope, f) === 'cylinderface')
      expect(sideIdx).toBeGreaterThanOrEqual(0)

      expect(() =>
        solveExtrude(
          occ, scope, table,
          { id: 'ex2', extrude: { sketch: loop, distance: 5, termination: 'up_to', up_to: 'face_q', operation: 'new' } },
          repoReturning({ type: 'face', body_id: 'body_cyl', face_index: sideIdx }),
          bodyStore,
        ),
      ).toThrow(/target face is not planar/)
    } finally {
      scope.dispose()
    }
  })

  it('falls back to blind distance with a warning when up_to does not resolve', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const bodyStore = makeBoxBody(scope, table)
      const loop = bottomLoop(table, bodyStore.body_b)
      const result = solveExtrude(
        occ, scope, table,
        { id: 'ex2', extrude: { sketch: loop, distance: 3, termination: 'up_to', up_to: 'missing_q', operation: 'new' } },
        repoReturning(null), bodyStore,
      )
      expect(result.status).toBe('ok')
      expect(result.solver_warning).toMatch(/did not resolve/)
      expect(result.solver_warning).toContain('used blind distance')
      const vol = volumeOf(occ, scope, table.get<OccShape>(bodyStore.body_ex2.shape!))
      expect(vol).toBeCloseTo(300, 2)  // blind 100 * 3
    } finally {
      scope.dispose()
    }
  })

  it('warns about ambiguity, not missing resolution, when the up_to ref is ambiguous', () => {
    // An ambiguous pick matched several elements; reporting "did not resolve"
    // told the user the target was gone while it was actually over-matched.
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const bodyStore = makeBoxBody(scope, table)
      const loop = bottomLoop(table, bodyStore.body_b)
      const ambiguousRepo = {
        query: (q: unknown) => {
          if (q === 'amb_q') throw new AmbiguousQueryError("query 'amb_q' matched 2 elements")
          return null
        },
        elements: new Map(),
      } as unknown as Repository
      const result = solveExtrude(
        occ, scope, table,
        { id: 'ex3', extrude: { sketch: loop, distance: 3, termination: 'up_to', up_to: 'amb_q', operation: 'new' } },
        ambiguousRepo, bodyStore,
      )
      expect(result.status).toBe('ok')
      expect(result.solver_warning).toMatch(/matched several elements/)
      expect(result.solver_warning).not.toMatch(/did not resolve/)
    } finally {
      scope.dispose()
    }
  })
})
