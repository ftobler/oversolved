// @vitest-environment node
//
// Gated real-OCC end-to-end test for the shell LEAF (features/shell.ts): the
// face index build, construction-based face resolution, the OCC thick-solid
// call, naming, and the in-place body-store update. The OCC producer's own
// history is pinned by occ/__tests__/thickSolidProbeReal.test.ts; here the leaf
// is threaded a real named body.
//
// Faces are addressed by their construction-UUID query (the wire form the
// viewport mints), so the test does not depend on cross-build face enumeration
// order beyond the body it builds itself.
//
// Skips when opencascade.js is absent.
import { describe, it, expect } from 'vitest'
import { loadOcc } from '../../occ/loadOcc'
import { DisposeScope } from '../../occ/disposeScope'
import { HandleTable } from '../../occ/handleTable'
import { makeBox, makeBoxAt, makeCylinder, makeCylinderWithFaces, faceCentroid } from '../../occ/primitives'
import { volumeOf, surfaceAreaOf } from '../../occ/volume'
import { booleanWithDiff } from '../../occ/booleans'
import { canonicalEdges, canonicalFaces, namesFromArray, namesToArray } from '../../occ/bodyNames'
import { deriveEdgeNames } from '../../occ/constructionLineage'
import { ref, Repository, makeAncestryQuery, constructionUuidToken } from '../../query'
import { solveShell } from '../shell'
import { solveFillet } from '../filletChamfer'
import { exploreEdges, exploreFaces } from '../../occ/edgeModifier'
import { buildFaceIndex } from '../shared/faceResolution'
import { mintFaceUuid, shellFacePath } from '../../constructionName'
import type { Body } from '../../types3d'
import type { OccModule, OccShape, OccSubShape } from '../../occ/occTypes'

const oc = await loadOcc()

const FACE_TYPE = 'flatface'

/** A face pick query for the face that carries `uuid`. */
const faceQuery = (uuid: string): string => makeAncestryQuery([constructionUuidToken(uuid)], FACE_TYPE)

describe.skipIf(!oc)('solveShell leaf (real OCC)', () => {
  let occ: OccModule
  if (oc) occ = oc

  // A named body: faces `f0..fN` in canonical order, edges derived from them.
  function namedBody(scope: DisposeScope, table: HandleTable, shape: OccShape, id = 'body_b'): Record<string, Body> {
    const faces = canonicalFaces(occ, scope, shape)
    const face_uuids = faces.map((_, i) => `f${i}`)
    const faceAncestry = Object.fromEntries(face_uuids.map((u) => [u, [ref('ex1'), ref(id)]]))
    const { edgeNames, edgeAncestry } = deriveEdgeNames(occ, scope, shape, namesFromArray(faces, face_uuids), faceAncestry)
    const edge_uuids = namesToArray(canonicalEdges(occ, scope, shape), edgeNames)
    return {
      [id]: {
        id, created_by: 'ex1', modified_by: [],
        shape: table.register(shape, 'ex1'), sketch_id: 'sk', brep_diff: null,
        profile_queries: [], face_uuids, edge_uuids, face_ancestry: faceAncestry, edge_ancestry: edgeAncestry,
      },
    }
  }

  // A named 10-millimetre box body: faces `f0..f5` in canonical order.
  function boxBody(scope: DisposeScope, table: HandleTable, size = 10): Record<string, Body> {
    return namedBody(scope, table, makeBox(occ, scope, size, size, size))
  }

  // An L-section prism: a 10 x 10 x 10 box with a 6 x 6 notch removed from one
  // top quadrant, so the inner vertical corner at (4, 4) is CONCAVE.
  function lBody(scope: DisposeScope, table: HandleTable): Record<string, Body> {
    const outer = makeBox(occ, scope, 10, 10, 10)
    const notch = makeBoxAt(occ, scope, [4, 4, 0], 6, 6, 10)
    const { shape } = booleanWithDiff(occ, scope, outer, notch, 'cut')
    return namedBody(scope, table, scope.track(shape))
  }

  // The report body (2026-11-12): a 10 x 10 x 2 plate with a D10 boss 1 high on
  // its top face. The boss is inscribed, so its wall touches each plate side in
  // a tangent contact and the plate top is pinched into four corner pieces.
  function reportBody(scope: DisposeScope, table: HandleTable, diameter = 10): Record<string, Body> {
    const plate = makeBox(occ, scope, 10, 10, 2)
    const boss = makeCylinder(occ, scope, [5, 5, 2], [0, 0, 1], diameter / 2, 1)
    const { shape } = booleanWithDiff(occ, scope, plate, boss, 'fuse')
    return namedBody(scope, table, scope.track(shape))
  }

  // Every cylindrical face's radius, for the concave-corner check.
  function cylinderRadii(scope: DisposeScope, shape: OccShape): number[] {
    const radii: number[] = []
    for (const face of exploreFaces(occ, scope, shape)) {
      const surface = scope.track(new occ.BRepAdaptor_Surface_2(face, true))
      if (surface.GetType().value !== occ.GeomAbs_SurfaceType.GeomAbs_Cylinder.value) continue
      radii.push(scope.track(surface.Cylinder()).Radius())
    }
    return radii
  }

  // The canonical index of the body shape top face (max centroid Z).
  function topFaceIndex(scope: DisposeScope, table: HandleTable, body: Body): number {
    const faces = canonicalFaces(occ, scope, table.get<OccShape>(body.shape!))
    let best = 0
    faces.forEach((f, i) => {
      if (faceCentroid(occ, scope, f as never)[2] > faceCentroid(occ, scope, faces[best] as never)[2]) best = i
    })
    return best
  }

  // The canonical index of the body shape bottom face (min centroid Z).
  function bottomFaceIndex(scope: DisposeScope, table: HandleTable, body: Body): number {
    const faces = canonicalFaces(occ, scope, table.get<OccShape>(body.shape!))
    let best = 0
    faces.forEach((f, i) => {
      if (faceCentroid(occ, scope, f as never)[2] < faceCentroid(occ, scope, faces[best] as never)[2]) best = i
    })
    return best
  }

  function shelledShape(_scope: DisposeScope, table: HandleTable, body: Body): OccShape {
    return table.get<OccShape>(body.shape!)
  }

  it('top open inward t=1: V=424, A=888, 11 faces, 24 edges, bbox unchanged', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const bodyStore = boxBody(scope, table)
      const body = bodyStore.body_b
      const q = faceQuery(body.face_uuids![topFaceIndex(scope, table, body)]!)
      const res = solveShell(occ, scope, table, { id: 'sh1', shell: { faces: [q], thickness: 1 } }, new Repository(), bodyStore)
      expect(res.status).toBe('ok')
      const shape = shelledShape(scope, table, body)
      expect(volumeOf(occ, scope, shape)).toBeCloseTo(424, 4)
      expect(surfaceAreaOf(occ, scope, shape)).toBeCloseTo(888, 4)
      expect(canonicalFaces(occ, scope, shape)).toHaveLength(11)
      expect(canonicalEdges(occ, scope, shape)).toHaveLength(24)
      expect(body.modified_by).toEqual(['sh1'])
      expect(body.brep_diff?.new_faces.length).toBeGreaterThan(0)
      // Inward removes material inside the original skin, so the bbox holds.
      const box = scope.track(new occ.Bnd_Box_1())
      occ.BRepBndLib.Add(shape, box, false)
      expect([box.GetXmin(), box.GetYmin(), box.GetZmin(), box.GetXmax(), box.GetYmax(), box.GetZmax()].map((n) => Math.round(n)))
        .toEqual([0, 0, 0, 10, 10, 10])
    } finally {
      scope.dispose()
    }
  })

  it('no faces inward t=1: V=488, one body, 12 faces (closed hollow)', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const bodyStore = boxBody(scope, table)
      const body = bodyStore.body_b
      const originalUuids = [...body.face_uuids!]
      const bottomUuid = body.face_uuids![bottomFaceIndex(scope, table, body)]!
      const res = solveShell(occ, scope, table, { id: 'sh1', shell: { faces: [], thickness: 1, source_body: '@body_b' } }, new Repository(), bodyStore)
      expect(res.status).toBe('ok')
      expect(res.body_ids).toEqual(['body_b'])
      const shape = shelledShape(scope, table, bodyStore.body_b)
      expect(volumeOf(occ, scope, shape)).toBeCloseTo(488, 4)
      expect(canonicalFaces(occ, scope, shape)).toHaveLength(12)
      // Every result face is named; the outer skin keeps the original UUIDs and
      // the inner void mints an offset name keyed off each source face.
      expect(body.face_uuids!.every((u) => u !== null)).toBe(true)
      for (const u of originalUuids) expect(body.face_uuids).toContain(u)
      expect(body.face_uuids).toContain(mintFaceUuid(shellFacePath('sh1', 'offset', bottomUuid)))
    } finally {
      scope.dispose()
    }
  })

  it('top open outward t=1: V=584, bbox grows by 1 each way, sharp corners (11 faces)', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const bodyStore = boxBody(scope, table)
      const body = bodyStore.body_b
      const q = faceQuery(body.face_uuids![topFaceIndex(scope, table, body)]!)
      const topUuid = body.face_uuids![topFaceIndex(scope, table, body)]!
      const keptUuids = body.face_uuids!.filter((u) => u !== topUuid)
      const res = solveShell(occ, scope, table, { id: 'sh1', shell: { faces: [q], thickness: 1, direction: 'outward' } }, new Repository(), bodyStore)
      expect(res.status).toBe('ok')
      const shape = shelledShape(scope, table, body)
      expect(volumeOf(occ, scope, shape)).toBeCloseTo(584, 4)
      expect(canonicalFaces(occ, scope, shape)).toHaveLength(11)
      const box = scope.track(new occ.Bnd_Box_1())
      occ.BRepBndLib.Add(shape, box, false)
      expect([box.GetXmin(), box.GetYmin(), box.GetZmin(), box.GetXmax(), box.GetYmax(), box.GetZmax()].map((n) => Math.round(n)))
        .toEqual([-1, -1, -1, 11, 11, 10])
      // Outward names the same way as inward: the kept inner skin carries the
      // old UUIDs (minus the removed top) and every kept face mints its offset
      // wall keyed off the source face.
      expect(body.face_uuids!.every((u) => u !== null)).toBe(true)
      for (const u of keptUuids) {
        expect(body.face_uuids).toContain(u)
        expect(body.face_uuids).toContain(mintFaceUuid(shellFacePath('sh1', 'offset', u!)))
      }
    } finally {
      scope.dispose()
    }
  })

  // The Ex017 shape at its own scale: a 2 mm cube, top removed, shelled 0.05
  // outward. The sharp join gives 2.1 x 2.1 x 2.05 less the 8 open cavity; an
  // arc join (CadQuery's default `kind="arc"`) rounds the four outer edges and
  // the corner tops and measures 1.031678. This is the number docs/drive.md
  // quotes, and the face count is what says the join stayed sharp: a rounded
  // edge or corner would add faces.
  it('Ex017 scale: 2 mm cube top open, outward t=0.05 -> V=1.0405, still 11 faces', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const bodyStore = boxBody(scope, table, 2)
      const body = bodyStore.body_b
      const q = faceQuery(body.face_uuids![topFaceIndex(scope, table, body)]!)
      const res = solveShell(occ, scope, table, { id: 'sh1', shell: { faces: [q], thickness: 0.05, direction: 'outward' } }, new Repository(), bodyStore)
      expect(res.status).toBe('ok')
      const shape = shelledShape(scope, table, body)
      expect(volumeOf(occ, scope, shape)).toBeCloseTo(2.1 * 2.1 * 2.05 - 8, 6)
      expect(canonicalFaces(occ, scope, shape)).toHaveLength(11)
      const box = scope.track(new occ.Bnd_Box_1())
      occ.BRepBndLib.Add(shape, box, false)
      expect([box.GetXmin(), box.GetYmin(), box.GetZmin(), box.GetXmax(), box.GetYmax(), box.GetZmax()].map((n) => Number(n.toFixed(3))))
        .toEqual([-0.05, -0.05, -0.05, 2.05, 2.05, 2])
    } finally {
      scope.dispose()
    }
  })

  it('Ex017 parity: join arc on the same box matches CadQuery (V=1.031678, A=41.6802, 23 faces)', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const bodyStore = boxBody(scope, table, 2)
      const body = bodyStore.body_b
      const q = faceQuery(body.face_uuids![topFaceIndex(scope, table, body)]!)
      const res = solveShell(occ, scope, table, {
        id: 'sh1', shell: { faces: [q], thickness: 0.05, direction: 'outward', join: 'arc' },
      }, new Repository(), bodyStore)
      expect(res.status).toBe('ok')
      expect(res.solver_note).toBeUndefined()
      const shape = shelledShape(scope, table, body)
      // CadQuery's own run for Ex017 (Box(2, 2, 2), +Z open, shell(0.05)).
      expect(volumeOf(occ, scope, shape)).toBeCloseTo(1.0316777267316828, 6)
      expect(surfaceAreaOf(occ, scope, shape)).toBeCloseTo(41.68019900821944, 4)
      expect(canonicalFaces(occ, scope, shape)).toHaveLength(23)
    } finally {
      scope.dispose()
    }
  })

  it('join arc inward on a convex box equals the sharp inward shell', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const volume = (join?: 'sharp' | 'arc'): number => {
        const bodyStore = boxBody(scope, table)
        const body = bodyStore.body_b
        const q = faceQuery(body.face_uuids![topFaceIndex(scope, table, body)]!)
        const res = solveShell(occ, scope, table, { id: 'sh1', shell: { faces: [q], thickness: 1, join } }, new Repository(), bodyStore)
        expect(res.status).toBe('ok')
        return volumeOf(occ, scope, shelledShape(scope, table, body))
      }
      expect(volume(undefined)).toBeCloseTo(424, 4)
      expect(volume('arc')).toBeCloseTo(424, 4)
    } finally {
      scope.dispose()
    }
  })

  it('join arc inward rounds the concave edge of an L-section', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const shell = (join?: 'sharp' | 'arc'): { volume: number; cylinders: number[] } => {
        const bodyStore = lBody(scope, table)
        const body = bodyStore.body_b
        const q = faceQuery(body.face_uuids![topFaceIndex(scope, table, body)]!)
        const res = solveShell(occ, scope, table, { id: 'sh1', shell: { faces: [q], thickness: 1, join } }, new Repository(), bodyStore)
        expect(res.status).toBe('ok')
        const shape = shelledShape(scope, table, body)
        return { volume: volumeOf(occ, scope, shape), cylinders: cylinderRadii(scope, shape) }
      }
      const sharp = shell(undefined)
      const arc = shell('arc')
      expect(sharp.cylinders).toHaveLength(0)
      // The concave corner's inner wall is a quarter cylinder of radius = t;
      // the round trims the corner wedge, so the arc shell is lighter.
      expect(arc.cylinders).toHaveLength(1)
      expect(arc.cylinders[0]).toBeCloseTo(1, 6)
      expect(arc.volume).toBeLessThan(sharp.volume)
    } finally {
      scope.dispose()
    }
  })

  it('join arc outward on a closed hollow removes the outer corner prisms', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const volume = (join?: 'sharp' | 'arc'): number => {
        const bodyStore = boxBody(scope, table)
        const res = solveShell(occ, scope, table, {
          id: 'sh1', shell: { faces: [], thickness: 1, direction: 'outward', source_body: '@body_b', join },
        }, new Repository(), bodyStore)
        expect(res.status).toBe('ok')
        return volumeOf(occ, scope, shelledShape(scope, table, bodyStore.body_b))
      }
      // The outward offset grows every side by t, so the sharp closed hollow is
      // 12^3 - 10^3. The arc rounds the outer edges and corners and loses the
      // corner prisms.
      const sharp = volume(undefined)
      const arc = volume('arc')
      expect(sharp).toBeCloseTo(12 ** 3 - 10 ** 3, 4)
      expect(arc).toBeLessThan(sharp)
      expect(arc).toBeGreaterThan(0)
    } finally {
      scope.dispose()
    }
  })

  it('the sharp-to-arc fallback warns, and an explicit arc does not', { timeout: 120_000 }, () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      // The key_cap repro: an 18 x 18 x 10 box with its top edges filleted,
      // then the flat top opened at 0.75 inward.
      const build = (): Record<string, Body> => {
        const bodyStore = namedBody(scope, table, makeBox(occ, scope, 18, 18, 10))
        const body = bodyStore.body_b
        const topIdx = topFaceIndex(scope, table, body)
        const topUuid = body.face_uuids![topIdx]!
        const topFace = buildFaceIndex(occ, scope, table, body).byUuid.get(topUuid)!
        const canonEdges = canonicalEdges(occ, scope, table.get<OccShape>(body.shape!)) as OccShape[]
        const queries = exploreEdges(occ, scope, topFace).map((e) => {
          const at = canonEdges.findIndex((ce) => (ce as OccSubShape).IsSame(e as OccSubShape))
          return makeAncestryQuery([constructionUuidToken(body.edge_uuids![at]!)], 'edge')
        })
        const fillet = solveFillet(occ, scope, table, { id: 'fi1', fillet: { edges: queries, radius: 1 } }, new Repository(), bodyStore)
        expect(fillet.status).toBe('ok')
        return bodyStore
      }
      const shell = (join?: 'sharp' | 'arc'): { volume: number; warning?: string; note?: string } => {
        const bodyStore = build()
        const body = bodyStore.body_b
        const topUuid = body.face_uuids![topFaceIndex(scope, table, body)]!
        const res = solveShell(occ, scope, table, {
          id: 'sh1', shell: { faces: [faceQuery(topUuid)], thickness: 0.75, direction: 'inward', join },
        }, new Repository(), bodyStore)
        expect(res.status).toBe('ok')
        return {
          volume: volumeOf(occ, scope, shelledShape(scope, table, body)),
          warning: typeof res.solver_warning === 'string' ? res.solver_warning : undefined,
          note: typeof res.solver_note === 'string' ? res.solver_note : undefined,
        }
      }
      const fallback = shell(undefined)
      expect(fallback.warning).toMatch(/the sharp join was refused \(build_not_done\)/)
      expect(fallback.warning).toMatch(/corners were rounded/)
      // The note channel is deliberately unmarked by featureFailure, so a
      // substitution must not ride there: it has to be a warning.
      expect(fallback.note).toBeUndefined()
      const arc = shell('arc')
      expect(arc.warning).toBeUndefined()
      expect(arc.volume).toBeCloseTo(fallback.volume, 6)
    } finally {
      scope.dispose()
    }
  })

  it('a sharp request on a tangent-contact body warns instead of silently rounding', { timeout: 120_000 }, () => {
    // The 2026-11-12 report: a D10 boss inscribed in a 10 x 10 plate. The sharp
    // join cannot offset across the four tangent contacts, and the old silent
    // arc retry built rounded corners behind an ok status.
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const shell = (diameter: number, direction: 'inward' | 'outward'): { volume: number; warning?: string; note?: string } => {
        const bodyStore = reportBody(scope, table, diameter)
        const body = bodyStore.body_b
        const q = faceQuery(body.face_uuids![topFaceIndex(scope, table, body)]!)
        const res = solveShell(occ, scope, table, {
          id: 'sh1', shell: { faces: [q], thickness: 0.5, direction },
        }, new Repository(), bodyStore)
        expect(res.status, direction).toBe('ok')
        return {
          volume: volumeOf(occ, scope, shelledShape(scope, table, body)),
          warning: typeof res.solver_warning === 'string' ? res.solver_warning : undefined,
          note: typeof res.solver_note === 'string' ? res.solver_note : undefined,
        }
      }
      for (const direction of ['inward', 'outward'] as const) {
        const fallback = shell(10, direction)
        expect(fallback.warning, direction).toMatch(/the sharp join was refused/)
        expect(fallback.note, direction).toBeUndefined()
      }
      // The report's measured arc volumes: the fallback is what it always was.
      expect(shell(10, 'inward').volume).toBeCloseTo(100.9553, 4)
      expect(shell(10, 'outward').volume).toBeCloseTo(127.2053, 4)

      // D8 leaves the boss clear of the plate walls: no tangent contact, so the
      // sharp join builds and there is nothing to warn about.
      for (const [direction, volume] of [['inward', 111.5387], ['outward', 144.5431]] as const) {
        const sharp = shell(8, direction)
        expect(sharp.warning, direction).toBeUndefined()
        expect(sharp.volume, direction).toBeCloseTo(volume, 4)
      }
    } finally {
      scope.dispose()
    }
  })

  it('a sharp closed hollow whose offset is refused warns when arc replaces it', { timeout: 120_000 }, () => {
    // The same report body with no faces: the sharp offset cannot be used as a
    // boolean tool, so the arc retry offsets the whole body, its lone shell is
    // wrapped into a solid, and the wall is cut out of it. The substitution must
    // warn exactly like the opened-face fallback.
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const bodyStore = reportBody(scope, table)
      const res = solveShell(occ, scope, table, {
        id: 'sh1', shell: { faces: [], thickness: 0.5, direction: 'inward', source_body: '@body_b' },
      }, new Repository(), bodyStore)
      expect(res.status).toBe('ok')
      expect(res.solver_warning).toMatch(/the sharp join was refused \(the operation produced invalid geometry/)
      expect(res.solver_note).toBeUndefined()
      expect(volumeOf(occ, scope, shelledShape(scope, table, bodyStore.body_b))).toBeCloseTo(132.7639, 3)
    } finally {
      scope.dispose()
    }
  })

  it('an outward arc join across a concave edge refuses by name and never falls back to sharp', () => {
    // A 20 x 20 x 12 L block with a 2 mm notch: an arc round of radius 2 cannot
    // span the notch. The sharp join builds, but an explicit arc must refuse
    // with the cause rather than substitute the user's choice silently.
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const lBlock = (): Record<string, Body> => {
        const outer = makeBox(occ, scope, 20, 20, 12)
        const notch = makeBoxAt(occ, scope, [18, 18, 0], 2, 2, 12)
        const { shape } = booleanWithDiff(occ, scope, outer, notch, 'cut')
        return namedBody(scope, table, scope.track(shape))
      }
      const bodyStore = lBlock()
      const body = bodyStore.body_b
      const q = faceQuery(body.face_uuids![topFaceIndex(scope, table, body)]!)
      // The same body and thickness build sharp.
      const sharp = solveShell(occ, scope, table, {
        id: 'sh2', shell: { faces: [q], thickness: 2, direction: 'outward', join: 'sharp' },
      }, new Repository(), bodyStore)
      expect(sharp.status).toBe('ok')

      const arcStore = lBlock()
      const arcBody = arcStore.body_b
      const arcQuery = faceQuery(arcBody.face_uuids![topFaceIndex(scope, table, arcBody)]!)
      let threw: unknown = null
      try {
        solveShell(occ, scope, table, {
          id: 'sh3', shell: { faces: [arcQuery], thickness: 2, direction: 'outward', join: 'arc' },
        }, new Repository(), arcStore)
      } catch (e) {
        threw = e
      }
      expect((threw as Error).message).toBe(
        'shell: the arc join cannot round an outward wall across a concave edge at thickness 2; ' +
          'use Corners: Sharp, or a smaller thickness',
      )
      // The body is untouched: a refusal is not a quiet sharp shell.
      expect(arcBody.modified_by).toEqual([])
    } finally {
      scope.dispose()
    }
  })

  it('two opposite faces open makes a tube: V=360', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const bodyStore = boxBody(scope, table)
      const body = bodyStore.body_b
      const qs = body.face_uuids!.slice(0, 2).map((u) => faceQuery(u!))
      const res = solveShell(occ, scope, table, { id: 'sh1', shell: { faces: qs, thickness: 1 } }, new Repository(), bodyStore)
      expect(res.status).toBe('ok')
      expect(volumeOf(occ, scope, shelledShape(scope, table, body))).toBeCloseTo(360, 4)
    } finally {
      scope.dispose()
    }
  })

  it('cylinder r=5 h=10 top open inward t=1: V=106*pi', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const { shape, faces } = makeCylinderWithFaces(occ, scope, [0, 0, 0], [0, 0, 1], 5, 10)
      const canon = canonicalFaces(occ, scope, shape)
      const face_uuids = canon.map((_, i) => `c${i}`)
      const topIdx = canon.findIndex((f) => (f as unknown as { IsSame(o: unknown): boolean }).IsSame(faces.top))
      const body: Body = {
        id: 'body_c', created_by: 'cy', modified_by: [], shape: table.register(shape, 'cy'),
        sketch_id: 'sk', brep_diff: null, profile_queries: [], face_uuids,
      }
      const bodyStore = { body_c: body }
      const res = solveShell(occ, scope, table, { id: 'sh1', shell: { faces: [faceQuery(face_uuids[topIdx])], thickness: 1 } }, new Repository(), bodyStore)
      expect(res.status).toBe('ok')
      expect(volumeOf(occ, scope, shelledShape(scope, table, body))).toBeCloseTo(106 * Math.PI, 4)
    } finally {
      scope.dispose()
    }
  })

  it('a thickness past the local radius errors and leaves the body unchanged', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const bodyStore = boxBody(scope, table)
      const body = bodyStore.body_b
      const shapeBefore = body.shape
      const namesBefore = JSON.stringify(body.face_uuids)
      const q = faceQuery(body.face_uuids![topFaceIndex(scope, table, body)]!)
      let threw: unknown = null
      try {
        solveShell(occ, scope, table, { id: 'sh1', shell: { faces: [q], thickness: 6 } }, new Repository(), bodyStore)
      } catch (e) {
        threw = e
      }
      expect(threw).not.toBeNull()
      expect((threw as Error).message).toContain('shell')
      expect(body.modified_by).toEqual([])
      expect(body.brep_diff).toBeNull()
      expect(body.shape).toBe(shapeBefore)
      expect(JSON.stringify(body.face_uuids)).toBe(namesBefore)
    } finally {
      scope.dispose()
    }
  })

  // The robustness fuzz seed 398 drew this: walls exactly half the width meet
  // in the middle, and OCC hands back a solid that passes BRepCheck yet holds
  // no material. It must refuse like the past-the-radius case above.
  it('a thickness of exactly half the width errors instead of building an empty solid', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const bodyStore = boxBody(scope, table)
      const body = bodyStore.body_b
      const shapeBefore = body.shape
      const q = faceQuery(body.face_uuids![topFaceIndex(scope, table, body)]!)
      expect(() => solveShell(occ, scope, table, { id: 'sh1', shell: { faces: [q], thickness: 5 } }, new Repository(), bodyStore))
        .toThrow(/shell/)
      expect(body.shape).toBe(shapeBefore)
      expect(body.modified_by).toEqual([])
    } finally {
      scope.dispose()
    }
  })

  it('names the offset and rim faces by construction, and they survive a 10 -> 14 edit', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const resolveOffsetAndRim = (size: number): { offset: string; rim: string } => {
        const bodyStore = boxBody(scope, table, size)
        const body = bodyStore.body_b
        const topUuid = body.face_uuids![topFaceIndex(scope, table, body)]!
        // The offset face for the bottom (z-min) and the rim of the opened top.
        const bottomUuid = body.face_uuids![bottomFaceIndex(scope, table, body)]!
        const res = solveShell(occ, scope, table, { id: 'sh1', shell: { faces: [faceQuery(topUuid)], thickness: 1 } }, new Repository(), bodyStore)
        expect(res.status).toBe('ok')
        // Every result face carries a UUID.
        expect(body.face_uuids!.every((u) => u !== null)).toBe(true)
        const expected = {
          offset: mintFaceUuid(shellFacePath('sh1', 'offset', bottomUuid)),
          rim: mintFaceUuid(shellFacePath('sh1', 'rim', topUuid)),
        }
        expect(body.face_uuids).toContain(expected.offset)
        expect(body.face_uuids).toContain(expected.rim)
        return expected
      }
      const ten = resolveOffsetAndRim(10)
      expect(ten.offset).toBe(mintFaceUuid(shellFacePath('sh1', 'offset', 'f4')))
      // The names are stable by construction: the same source-face UUIDs mint
      // the same offset/rim UUIDs on a differently-sized box.
      const fourteen = resolveOffsetAndRim(14)
      expect(fourteen.offset).toBe(ten.offset)
      expect(fourteen.rim).toBe(ten.rim)
    } finally {
      scope.dispose()
    }
  })

  it('a stale face pick yields partial + unresolved_faces, and the shell still runs', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const bodyStore = boxBody(scope, table)
      const body = bodyStore.body_b
      const good = faceQuery(body.face_uuids![topFaceIndex(scope, table, body)]!)
      const stale = faceQuery('f_dead')  // a face UUID that no current face holds
      const res = solveShell(occ, scope, table, { id: 'sh1', shell: { faces: [good, stale], thickness: 1 } }, new Repository(), bodyStore)
      expect(res.status).toBe('partial')
      expect(res.unresolved_faces).toEqual([stale])
      expect(volumeOf(occ, scope, shelledShape(scope, table, body))).toBeCloseTo(424, 4)
    } finally {
      scope.dispose()
    }
  })

  it('faces naming two bodies throw, naming both', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const a = boxBody(scope, table)
      const bBody = makeBox(occ, scope, 10, 10, 10)
      const bFaces = canonicalFaces(occ, scope, bBody)
      const bUuids = bFaces.map((_, i) => `g${i}`)
      a.body_c = {
        id: 'body_c', created_by: 'ex2', modified_by: [], shape: table.register(bBody, 'ex2'),
        sketch_id: 'sk2', brep_diff: null, profile_queries: [], face_uuids: bUuids,
      }
      const qa = faceQuery(a.body_b.face_uuids![0]!)
      const qb = faceQuery(bUuids[0])
      let threw: unknown = null
      try {
        solveShell(occ, scope, table, { id: 'sh1', shell: { faces: [qa, qb], thickness: 1 } }, new Repository(), a)
      } catch (e) {
        threw = e
      }
      expect(threw).not.toBeNull()
      const msg = (threw as Error).message
      expect(msg).toContain('body_b')
      expect(msg).toContain('body_c')
    } finally {
      scope.dispose()
    }
  })

  it('an inner edge still resolves through fillet after a 10 -> 14 edit', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      // Shell a 10-box, pick an INNER edge (one bounding the offset cavity
      // floor) by construction, and return its query and the fillet result.
      const filletInnerEdge = (size: number, storedQuery: string | null): { query: string; status: string } => {
        const bodyStore = boxBody(scope, table, size)
        const body = bodyStore.body_b
        const topUuid = body.face_uuids![topFaceIndex(scope, table, body)]!
        const bottomUuid = body.face_uuids![bottomFaceIndex(scope, table, body)]!
        solveShell(occ, scope, table, { id: 'sh1', shell: { faces: [faceQuery(topUuid)], thickness: 1 } }, new Repository(), bodyStore)
        const offsetFloor = mintFaceUuid(shellFacePath('sh1', 'offset', bottomUuid))
        const outerEdges = canonicalEdges(occ, scope, table.get<OccShape>(body.shape!))
        const innerEdge = exploreEdges(occ, scope, buildFaceIndex(occ, scope, table, body).byUuid.get(offsetFloor)!)
        const at = outerEdges.findIndex((ce) => innerEdge.some((e) => (e as OccSubShape).IsSame(ce as OccSubShape)))
        expect(at, 'the offset floor must bound a result edge').toBeGreaterThanOrEqual(0)
        const uuid = body.edge_uuids![at]!
        expect(uuid).not.toBeNull()
        const query = storedQuery ?? makeAncestryQuery([constructionUuidToken(uuid)], 'edge')
        const res = solveFillet(occ, scope, table, { id: 'fi1', fillet: { edges: [query], radius: 0.2 } }, new Repository(), bodyStore)
        return { query, status: res.status }
      }
      const ten = filletInnerEdge(10, null)
      expect(ten.status).toBe('ok')
      // Rebuild at 14 with the pick stored at 10: the construction UUID is
      // stable, so the same inner edge resolves and fillets.
      const fourteen = filletInnerEdge(14, ten.query)
      expect(fourteen.query).toBe(ten.query)
      expect(fourteen.status).toBe('ok')
    } finally {
      scope.dispose()
    }
  })
})
