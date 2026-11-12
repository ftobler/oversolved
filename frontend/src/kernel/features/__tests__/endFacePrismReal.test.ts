// @vitest-environment node
//
// The prism-cut fallback for a blend OCC refuses to a small end face (plan
// bug-fillet-end-cap-sliver, part B).
//
// OCC's ChFi3d cannot consume a face it was not asked to blend, so the enclosure
// lip's r9 blend has to be built another way. The safe case is a straight edge
// between two planes with square planar caps: there the blend is one constant
// 2D cross-section swept along the edge, and cutting that prism leaves exactly
// the rolling-ball result. The identity test below is the hard precondition for
// shipping this builder: the same edge, the same value, built both ways, has to
// agree in volume, area, face count AND construction UUIDs. Queries resolve by
// UUID and ancestry, so a blend face with a different name is a different face
// to every later pick.
//
// Real kernel, gated like the other Real suites.

import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from '../../occ/loadOcc'
import { SharedHarness } from '../../occ/sharedHarness'
import { setSketchSolver, resetSketchSolver } from '../sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { DisposeScope } from '../../occ/disposeScope'
import { volumeOf } from '../../occ/volume'
import { exploreFaces, applyFilletWithLineage, type NewNames, type OldNames } from '../../occ/edgeModifier'
import { readBodyNames } from '../../occ/bodyNames'
import { canonicalFaces } from '../../occ/bodyNames'
import { faceArea, faceSurfaceType } from '../../occ/primitives'
import { countSolids } from '../../occ/booleans'
import { isValidShape } from '../../occ/edgeModifier'
import { makeEdgeIndexCache, resolveEdgesWithIndex } from '../filletChamfer'
import { makeFilletPrismFallback } from '../endFaceBlend'
import { filletFacePath, mintFaceUuid } from '../../constructionName'
import { CORNER_CUT_VOLUME, LIP_RADIUS, bodyAt, enclosureBase } from './enclosureFixture'
import type { OccModule, OccShape, OccSubShape } from '../../occ/occTypes'

const oc = await loadOcc()
const solveBytes = loadSolver()

type Harness = SharedHarness

/** The base body, its shape and the resolved lip edges, with the names the
 *  feature would hand the modifier. */
function baseOf(h: Harness, result: ReturnType<Harness['run']>, scope: DisposeScope, queries: string[]) {
  const body = bodyAt(result, 'ex2')
  const shape = h.table.get<OccShape>(body.shape!)
  const indexFor = makeEdgeIndexCache(oc!, scope, h.table)
  const edges = resolveEdgesWithIndex(oc!, scope, h.table, body, indexFor(body), queries)
  const oldNames: OldNames = { createdBy: 'fi2', ...readBodyNames(oc!, scope, shape, body) }
  return { shape, edges, oldNames }
}

const sumArea = (ocm: OccModule, scope: DisposeScope, shape: OccShape): number =>
  exploreFaces(ocm, scope, shape).reduce((total, face) => total + faceArea(ocm, scope, face), 0)

const faceUuids = (names: NewNames | null): Set<string> => {
  const out = new Set<string>()
  if (names === null) return out
  for (const [, uuid] of names.faceNames.entries()) out.add(uuid)
  return out
}

describe.skipIf(!oc || !solveBytes)('end-face prism fallback (real OCC + Rust solver)', () => {
  const h = new SharedHarness(oc!)
  beforeAll(() => {
    if (solveBytes) { resetSketchSolver(); setSketchSolver(solveBytes) }
  })

  it('is the maker result at r0.8: same volume, area, face count and UUIDs', () => {
    // r0.8 is under the 1.0627 limit, so OCC builds it. Forcing the fallback on
    // the same edge is the identity test the plan makes a precondition: if the
    // two builders disagree here, the fallback may not ship.
    const { lipEdges, result } = enclosureBase(h)
    const scope = new DisposeScope()
    const { shape, edges, oldNames } = baseOf(h, result, scope, lipEdges)
    const edge = edges[0]
    expect(edge).toBeDefined()
    const edgeUuid = oldNames.edgeNames.get(edge as OccSubShape)
    expect(edgeUuid).toBeDefined()

    const maker = applyFilletWithLineage(oc!, scope, shape, 0.8, [edge], oldNames)
    expect(maker.success).toBe(true)
    expect(maker.names).not.toBeNull()

    const fallback = makeFilletPrismFallback(0.8, 'fi2')
    expect(fallback.qualifies(oc!, scope, shape, edge)).toBe(false)
    // The gate refuses at r0.8 because nothing is consumed there; the builder
    // itself is what the identity test compares, so it is called directly.
    const cut = fallback.build(oc!, scope, shape, edge, oldNames)
    expect(cut).not.toBeNull()
    scope.track(cut!.shape)

    const makerFaces = exploreFaces(oc!, scope, maker.shape)
    const cutFaces = exploreFaces(oc!, scope, cut!.shape)
    expect(cutFaces.length).toBe(makerFaces.length)
    expect(volumeOf(oc!, scope, cut!.shape)).toBeCloseTo(volumeOf(oc!, scope, maker.shape), 6)
    expect(sumArea(oc!, scope, cut!.shape)).toBeCloseTo(sumArea(oc!, scope, maker.shape), 6)

    // The construction names are the real contract: picks resolve by UUID and
    // ancestry, so every face and every edge must land on the same identity.
    const makerUuids = faceUuids(maker.names)
    const cutUuids = faceUuids(cut!.names)
    expect(cutUuids.size).toBe(makerUuids.size)
    expect([...cutUuids].filter((u) => !makerUuids.has(u))).toEqual([])
    expect([...makerUuids].filter((u) => !cutUuids.has(u))).toEqual([])
    const makerEdges = new Set([...maker.names!.edgeNames.entries()].map(([, u]) => u))
    const cutEdges = new Set([...cut!.names!.edgeNames.entries()].map(([, u]) => u))
    expect([...cutEdges].filter((u) => !makerEdges.has(u))).toEqual([])
    expect([...makerEdges].filter((u) => !cutEdges.has(u))).toEqual([])

    // And the blend face itself is the one cylinder both builders introduce: it
    // carries the UUID minted from the picked edge on both paths.
    const blendUuid = mintFaceUuid(filletFacePath('fi2', edgeUuid as string))
    const carriesBlend = (resultShape: OccShape, names: NewNames): boolean =>
      exploreFaces(oc!, scope, resultShape).some(
        (face) =>
          faceSurfaceType(oc!, scope, face) === 'cylinderface' &&
          names.faceNames.get(face as OccSubShape) === blendUuid,
      )
    expect(carriesBlend(maker.shape, maker.names!)).toBe(true)
    expect(carriesBlend(cut!.shape, cut!.names!)).toBe(true)
    expect(cutUuids.has(blendUuid)).toBe(true)
    scope.dispose()
  }, 240_000)

  it('builds r9, the authored radius, removing exactly the four corner wedges', () => {
    // The user ruling: r9 should build. It removes 4 * (1 - pi/4) * 81 * 3 mm3
    // from the lip-on-filleted-plate body, which is exactly the four overhang
    // corner wedges (the tool is wholly inside the lip there).
    const { spec, lipEdges, result } = enclosureBase(h)
    const base = bodyAt(result, 'ex2')
    const scope = new DisposeScope()
    const baseShape = h.table.get<OccShape>(base.shape!)
    const baseVolume = volumeOf(oc!, scope, baseShape)

    spec.features.push({ id: 'fi2', kind: 'fillet', fillet: { edges: lipEdges, radius: LIP_RADIUS } })
    const built = h.run(spec)
    const res = h.res(built, 'fi2')
    expect(res.status).toBe('ok')
    expect(res.exception).toBeUndefined()
    expect(res.failed_edges).toBeUndefined()
    expect(res.solver_note).toBe(
      'fillet: edges[0], edges[1], edges[2], edges[3] blended by a prism cut ' +
      'because the rolling-ball blend could not consume its end face',
    )

    const body = bodyAt(built, 'fi2')
    const shape = h.table.get<OccShape>(body.shape!)
    expect(countSolids(oc!, scope, shape)).toBe(1)
    expect(isValidShape(oc!, scope, shape)).toBe(true)
    expect(volumeOf(oc!, scope, shape)).toBeCloseTo(baseVolume - 4 * CORNER_CUT_VOLUME, 6)

    // The four r9 blend cylinders are there (a quarter arc, 3 long), and the
    // small overhang triangles are gone: the triangles are 0.541 flat faces.
    const areas = exploreFaces(oc!, scope, shape).map((face) => ({
      kind: faceSurfaceType(oc!, scope, face),
      area: faceArea(oc!, scope, face),
    }))
    const blendFaces = areas.filter((f) => f.kind === 'cylinderface' && Math.abs(f.area - 9 * (Math.PI / 2) * 3) < 1e-6)
    expect(blendFaces).toHaveLength(4)
    expect(areas.filter((f) => Math.abs(f.area - 0.5411107571553011) < 1e-6)).toHaveLength(0)
    scope.dispose()
  }, 240_000)

  it('builds a mixed pick: the lip corners by prism, an ordinary edge by the maker', () => {
    // One fillet feature with the four refused lip edges and one plate edge the
    // maker accepts. The maker blends its edge, the fallback cuts the corners,
    // and the note names exactly the four fallback positions.
    const { spec, lipEdges, result } = enclosureBase(h)
    const body = bodyAt(result, 'ex2')
    const scope = new DisposeScope()
    const shape = h.table.get<OccShape>(body.shape!)
    const indexFor = makeEdgeIndexCache(oc!, scope, h.table)
    const plateQueries = ((h.body(result, 'body_ex1').edge_queries as string[]) ?? []).filter((q) => q.includes('@ex1@'))
    const plateEdges = resolveEdgesWithIndex(oc!, scope, h.table, body, indexFor(body), plateQueries)
    const fallback = makeFilletPrismFallback(2, 'fi2')
    // An edge the maker will take at r2 and the fallback will not touch.
    const ordinary = plateEdges.find((edge) => !fallback.qualifies(oc!, scope, shape, edge))
    expect(ordinary).toBeDefined()
    const ordinaryQuery = plateQueries.find((q) => {
      const resolved = resolveEdgesWithIndex(oc!, scope, h.table, body, indexFor(body), [q])
      return resolved.length === 1 && (resolved[0] as OccSubShape).IsSame(ordinary as OccSubShape)
    })
    expect(ordinaryQuery).toBeDefined()

    const picks = [lipEdges[0], ordinaryQuery as string, lipEdges[1], lipEdges[2], lipEdges[3]]
    spec.features.push({ id: 'fi2', kind: 'fillet', fillet: { edges: picks, radius: 2 } })
    const built = h.run(spec)
    const res = h.res(built, 'fi2')
    expect(res.status).toBe('ok')
    expect(res.exception).toBeUndefined()
    expect(res.failed_edges).toBeUndefined()
    expect(res.unresolved_edges).toBeUndefined()
    const note = String(res.solver_note ?? '')
    expect(note).toContain('edges[0], edges[2], edges[3], edges[4] blended by a prism cut')
    expect(note).not.toContain('edges[1]')
    const out = bodyAt(built, 'fi2')
    const outShape = h.table.get<OccShape>(out.shape!)
    expect(volumeOf(oc!, scope, outShape)).toBeLessThan(volumeOf(oc!, scope, shape))
    scope.dispose()
  }, 240_000)

  it('builds the same case as a chamfer, with the chord in place of the arc', () => {
    // The chamfer prism is the corner triangle (two legs of `distance`, closed
    // by the chord), so it removes d^2/2 per corner over the 3-long edge. This
    // pins the chord path and its note wording, which the fillet tests never
    // reach.
    const { spec, lipEdges, result } = enclosureBase(h)
    const base = bodyAt(result, 'ex2')
    const scope = new DisposeScope()
    const baseVolume = volumeOf(oc!, scope, h.table.get<OccShape>(base.shape!))
    spec.features.push({ id: 'ch1', kind: 'chamfer', chamfer: { edges: lipEdges, distance: 2, kind: 'distance', angle: 45 } })
    const built = h.run(spec)
    const res = h.res(built, 'ch1')
    expect(res.status).toBe('ok')
    expect(res.solver_note).toBe(
      'chamfer: edges[0], edges[1], edges[2], edges[3] blended by a prism cut ' +
      'because the rolling-ball blend could not consume its end face',
    )
    const body = bodyAt(built, 'ch1')
    const shape = h.table.get<OccShape>(body.shape!)
    expect(isValidShape(oc!, scope, shape)).toBe(true)
    expect(volumeOf(oc!, scope, shape)).toBeCloseTo(baseVolume - 4 * (0.5 * 4 * 3), 6)
    scope.dispose()
  }, 240_000)

  it('keeps the end face deleted and names every surviving face', () => {
    // The consumed end face is gone, which is the honest record, and every
    // surviving face of the r9 build keeps a construction UUID. Each picked
    // edge's blend face carries the UUID the maker would mint for it, so a later
    // pick resolves through the same identity on either builder.
    const { spec, lipEdges, result } = enclosureBase(h)
    const base = bodyAt(result, 'ex2')
    const scope = new DisposeScope()
    const baseShape = h.table.get<OccShape>(base.shape!)
    const indexFor = makeEdgeIndexCache(oc!, scope, h.table)
    const picked = resolveEdgesWithIndex(oc!, scope, h.table, base, indexFor(base), lipEdges)
    const baseNames = readBodyNames(oc!, scope, baseShape, base)

    spec.features.push({ id: 'fi2', kind: 'fillet', fillet: { edges: lipEdges, radius: LIP_RADIUS } })
    const built = h.run(spec)
    expect(h.res(built, 'fi2').status).toBe('ok')
    const body = bodyAt(built, 'fi2')
    const shape = h.table.get<OccShape>(body.shape!)
    const uuids = (body.face_uuids ?? []).filter((u): u is string => u !== null && u !== undefined)
    expect(uuids).toHaveLength(canonicalFaces(oc!, scope, shape).length)

    const expected = picked.map((edge) => {
      const edgeUuid = baseNames.edgeNames.get(edge as OccSubShape)
      expect(edgeUuid).toBeDefined()
      return mintFaceUuid(filletFacePath('fi2', edgeUuid as string))
    })
    expect(new Set(expected).size).toBe(4)
    for (const uuid of expected) expect(uuids).toContain(uuid)
    scope.dispose()
  }, 240_000)
})
