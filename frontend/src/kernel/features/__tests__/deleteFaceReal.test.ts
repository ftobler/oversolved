// @vitest-environment node
//
// Build-level delete-face tests through the production builder (SharedHarness):
// face-query resolution, the defeature call, naming and the body-store update,
// threaded through real documents. The OCC producer's own history is pinned by
// occ/__tests__/defeatureReal.test.ts; here the leaf is exercised end to end,
// including the naming properties the plan calls out (a healed face keeps its
// UUID, a healed edge regains its pre-fillet UUID).
//
// Skips when OCC.js or the Rust sketch solver is absent.
import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from '../../occ/loadOcc'
import { SharedHarness } from '../../occ/sharedHarness'
import { DisposeScope } from '../../occ/disposeScope'
import { setSketchSolver, resetSketchSolver } from '../sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { parseAncestry, makeAncestryQuery, ref, constructionUuidToken } from '../../query'
import { volumeOf } from '../../occ/volume'
import { canonicalFaces } from '../../occ/bodyNames'
import type { OccModule, OccShape } from '../../occ/occTypes'
import type { BuildResponse } from '../../builder'

const oc = await loadOcc()
const solveBytes = loadSolver()

interface FaceDatum {
  centroid: number[]
  normal: number[]
  area?: number
  surface_type?: string
}
interface FaceMesh {
  face_data?: FaceDatum[]
  face_queries?: string[]
}
type Dict = Record<string, unknown>

/** A fully-constrained w x h rectangle sketch on the front plane. */
function rectSketch(id: string, w: number, h: number, plane = '@builtin_plane_front'): Dict {
  return {
    id, kind: 'sketch', plane,
    entities: [
      { id: 'bottom', kind: 'line' }, { id: 'right', kind: 'line' },
      { id: 'top', kind: 'line' }, { id: 'left', kind: 'line' },
    ],
    initial: { bottom: [0, 0, w, 0], right: [w, 0, w, h], top: [w, h, 0, h], left: [0, h, 0, 0] },
    constraints: [
      { id: 'c1', kind: 'coincident', a: { entity: 'bottom', point: 'end' }, b: { entity: 'right', point: 'start' } },
      { id: 'c2', kind: 'coincident', a: { entity: 'right', point: 'end' }, b: { entity: 'top', point: 'start' } },
      { id: 'c3', kind: 'coincident', a: { entity: 'top', point: 'end' }, b: { entity: 'left', point: 'start' } },
      { id: 'c4', kind: 'coincident', a: { entity: 'left', point: 'end' }, b: { entity: 'bottom', point: 'start' } },
      { id: 'c5', kind: 'horizontal', target: { entity: 'bottom' } },
      { id: 'c6', kind: 'horizontal', target: { entity: 'top' } },
      { id: 'c7', kind: 'vertical', target: { entity: 'right' } },
      { id: 'c8', kind: 'vertical', target: { entity: 'left' } },
      { id: 'c9', kind: 'length', target: { entity: 'bottom' }, value: w },
      { id: 'c10', kind: 'length', target: { entity: 'left' }, value: h },
    ],
  }
}

/** A single-point sketch: one hole drill site at (x, y). */
function pointSketch(id: string, x: number, y: number, plane = '@builtin_plane_front'): Dict {
  return { id, kind: 'sketch', plane, entities: [{ id: 'p1', kind: 'point' }], initial: { p1: [x, y] } }
}

function extrude(id: string, sketch: string, distance: number): Dict {
  return { id, kind: 'extrude', extrude: { sketch, distance, direction: 'normal', operation: 'new' } }
}

function blindHole(id: string, sketch: string, target: string, diameter: number, depth: number): Dict {
  return { id, kind: 'hole', hole: { sketch, diameter, depth_mode: 'blind', depth, direction: 'normal', target } }
}

/** The construction-UUID token (`@u|<uuid>`) of a face query, if any. */
const uuidTokenOf = (q: string): string | undefined => parseAncestry(q)[0].find((i) => i.startsWith('@u|'))

function meshOf(h: SharedHarness, r: BuildResponse, bodyId: string): FaceMesh {
  return (h.body(r, bodyId).mesh ?? {}) as FaceMesh
}
function queryByType(mesh: FaceMesh, type: string): string[] {
  const out: string[] = []
  mesh.face_data?.forEach((fd, i) => {
    if (fd.surface_type === type) out.push(mesh.face_queries?.[i] ?? '')
  })
  return out.filter((q) => q !== '')
}
/** The smallest-area planar face: the floor of a blind hole. */
function smallestFlatQuery(mesh: FaceMesh): string {
  let best = -1
  let bestArea = Infinity
  mesh.face_data?.forEach((fd, i) => {
    if (fd.surface_type !== 'flatface') return
    const a = fd.area ?? Infinity
    if (a < bestArea) { bestArea = a; best = i }
  })
  return mesh.face_queries?.[best] ?? ''
}

describe.skipIf(!oc || !solveBytes)('solveDeleteFace through the builder (real OCC + Rust solver)', () => {
  const h = new SharedHarness(oc!)
  const occ = oc as OccModule

  beforeAll(() => {
    if (!oc || !solveBytes) throw new Error('unreachable: skipIf guards this')
    resetSketchSolver()
    setSketchSolver(solveBytes)
  })

  /** The body shape of `featureId`'s checkpoint, for a geometric read. */
  function bodyShape(r: BuildResponse, featureId: string, bodyId: string): OccShape {
    const ckp = r._build_state!.checkpoints[featureId]
    return h.table.get<OccShape>(ckp.body_store_snapshot[bodyId].shape!)
  }
  function bodyVolume(r: BuildResponse, featureId: string, bodyId: string): number {
    const scope = new DisposeScope()
    try { return volumeOf(occ, scope, bodyShape(r, featureId, bodyId)) } finally { scope.dispose() }
  }
  function bodyFaceCount(r: BuildResponse, featureId: string, bodyId: string): number {
    const scope = new DisposeScope()
    try { return canonicalFaces(occ, scope, bodyShape(r, featureId, bodyId)).length } finally { scope.dispose() }
  }

  /** A 20x20x10 plain box document. */
  const boxSpec = (): { features: Dict[] } => ({ features: [rectSketch('sk1', 20, 20), extrude('ex1', '$sk1', 10)] })

  /** The box, then a blind r2 d5 hole at (10,10). */
  const holedSpec = (): { features: Dict[] } => ({
    features: [
      rectSketch('sk1', 20, 20),
      extrude('ex1', '$sk1', 10),
      pointSketch('skh', 10, 10),
      blindHole('h1', '$skh', '@body_ex1', 4, 5),
    ],
  })

  /** The bore wall + floor queries of a solved holed body. */
  function holeFaces(r: BuildResponse, bodyId = 'body_ex1'): { bore: string; floor: string } {
    const mesh = meshOf(h, r, bodyId)
    const bore = queryByType(mesh, 'cylinderface')
    expect(bore.length, 'one bore wall').toBe(1)
    const floor = smallestFlatQuery(mesh)
    expect(floor).not.toBe('')
    return { bore: bore[0], floor }
  }

  it('a blind hole walls + floor heal to the plain box and the box face UUIDs survive', () => {
    const base = h.run(boxSpec())
    const boxUuids = new Set((meshOf(h, base, 'body_ex1').face_queries ?? []).map(uuidTokenOf))
    expect(boxUuids.size).toBe(6)

    const r1 = h.run(holedSpec())
    const { bore, floor } = holeFaces(r1)

    const spec = holedSpec()
    spec.features.push({ id: 'df1', kind: 'delete_face', delete_face: { faces: [bore, floor] } })
    const r = h.run(spec, { prevState: r1._build_state })
    expect(h.res(r, 'df1').status).toBe('ok')
    expect(h.res(r, 'df1').body_ids).toEqual(['body_ex1'])
    expect(bodyVolume(r, 'df1', 'body_ex1')).toBeCloseTo(4000, 3)
    expect(bodyFaceCount(r, 'df1', 'body_ex1')).toBe(6)

    // Every pre-hole face UUID is live exactly once: the healed top face kept
    // the identity it had before the hole.
    const after = new Set((meshOf(h, r, 'body_ex1').face_queries ?? []).map(uuidTokenOf))
    for (const u of boxUuids) expect(after.has(u)).toBe(true)
  })

  it('a blind-hole floor alone becomes a through hole', () => {
    const r1 = h.run(holedSpec())
    const { floor } = holeFaces(r1)
    const spec = holedSpec()
    spec.features.push({ id: 'df1', kind: 'delete_face', delete_face: { faces: [floor] } })
    const r = h.run(spec, { prevState: r1._build_state })
    expect(h.res(r, 'df1').status).toBe('ok')
    expect(bodyVolume(r, 'df1', 'body_ex1')).toBeCloseTo(4000 - Math.PI * 4 * 10, 2)
    expect(bodyFaceCount(r, 'df1', 'body_ex1')).toBe(7)
  })

  it('a hole wall alone refuses the whole feature and leaves the body for downstream', () => {
    const r1 = h.run(holedSpec())
    const { bore } = holeFaces(r1)
    const spec = holedSpec()
    spec.features.push({ id: 'df1', kind: 'delete_face', delete_face: { faces: [bore] } })
    // A downstream planar feature still solves on the unchanged body.
    spec.features.push({ id: 'df2', kind: 'delete_face', delete_face: { faces: [] } })
    const r = h.run(spec, { prevState: r1._build_state })
    expect(h.res(r, 'df1').status).toBe('exception')
    expect(bodyVolume(r, 'df1', 'body_ex1')).toBeCloseTo(4000 - Math.PI * 4 * 5, 2)
  })

  it('a stale pick is unresolved_faces; every pick stale throws', () => {
    const r1 = h.run(holedSpec())
    const { bore, floor } = holeFaces(r1)
    // Keep the hole but add a face query that matches nothing (a dead UUID over
    // the whole body leaves the stable-ancestry tier ambiguous, so it stays
    // unresolved rather than guessing).
    const stale = makeAncestryQuery([constructionUuidToken('dead0000000000000000'), ref('body_ex1')], 'flatface')
    const spec = holedSpec()
    spec.features.push({ id: 'df1', kind: 'delete_face', delete_face: { faces: [bore, floor, stale] } })
    const r = h.run(spec, { prevState: r1._build_state })
    expect(h.res(r, 'df1').status).toBe('partial')
    expect(h.res(r, 'df1').unresolved_faces).toEqual([stale])
    expect(bodyVolume(r, 'df1', 'body_ex1')).toBeCloseTo(4000, 2)

    // All stale: drop the hole feature so the bore/floor no longer exist.
    const gone = boxSpec()
    gone.features.push({ id: 'df1', kind: 'delete_face', delete_face: { faces: [bore, floor] } })
    const rBad = h.run(gone)
    expect(h.res(rBad, 'df1').status).toBe('exception')
    expect(String(h.res(rBad, 'df1').exception ?? '')).toContain('no faces resolved')
  })

  it('an upstream hole diameter change keeps the picks resolving', () => {
    const r1 = h.run(holedSpec())
    const { bore, floor } = holeFaces(r1)
    const spec = holedSpec()
    // Rebuild with a wider hole (diameter 6); the picks are named by the hole
    // site and role, not by geometry, so they still resolve.
    spec.features[3] = blindHole('h1', '$skh', '@body_ex1', 6, 5)
    spec.features.push({ id: 'df1', kind: 'delete_face', delete_face: { faces: [bore, floor] } })
    const r = h.run(spec)
    expect(h.res(r, 'df1').status).toBe('ok')
    expect(bodyVolume(r, 'df1', 'body_ex1')).toBeCloseTo(4000, 2)
  })

  it('an upstream extrude edit keeps the picks resolving (incremental and full rebuild)', () => {
    const r1 = h.run(holedSpec())
    const { bore, floor } = holeFaces(r1)
    const edited = (): { features: Dict[] } => {
      const s = holedSpec()
      s.features[1] = extrude('ex1', '$sk1', 14)
      s.features.push({ id: 'df1', kind: 'delete_face', delete_face: { faces: [bore, floor] } })
      return s
    }
    const incremental = h.run(edited(), { prevState: r1._build_state })
    expect(h.res(incremental, 'df1').status).toBe('ok')
    expect(bodyVolume(incremental, 'df1', 'body_ex1')).toBeCloseTo(20 * 20 * 14, 2)

    const full = h.run(edited())
    expect(h.res(full, 'df1').status).toBe('ok')
    expect(bodyVolume(full, 'df1', 'body_ex1')).toBeCloseTo(20 * 20 * 14, 2)
  })

  it('a partial pick: one healable group applies, one unhealable group fails', () => {
    // Hole 1 (at 10,10) picked fully, hole 2's bore picked alone. The two holes
    // are disjoint, so hole 1 heals and hole 2's group is reported in
    // failed_faces while the feature stays partial.
    const one = h.run(holedSpec())
    const { bore: bore1, floor: floor1 } = holeFaces(one)

    const spec: { features: Dict[] } = holedSpec()
    spec.features.push(pointSketch('skh2', 5, 5))
    spec.features.push(blindHole('h2', '$skh2', '@body_ex1', 4, 5))
    const r1 = h.run(spec)
    expect(h.res(r1, 'h2').status).toBe('ok')
    const bores = queryByType(meshOf(h, r1, 'body_ex1'), 'cylinderface')
    const bore2 = bores.find((q) => q !== bore1)
    expect(bore2).toBeDefined()

    spec.features.push({ id: 'df1', kind: 'delete_face', delete_face: { faces: [bore1, floor1, bore2!] } })
    const r = h.run(spec)
    expect(h.res(r, 'df1').status).toBe('partial')
    expect(h.res(r, 'df1').failed_faces).toEqual([bore2])
    expect(h.res(r, 'df1').unresolved_faces).toEqual([])
    // Hole 1 filled, hole 2 intact: 4000 - hole2 volume.
    expect(bodyVolume(r, 'df1', 'body_ex1')).toBeCloseTo(4000 - Math.PI * 4 * 5, 2)
  })

  it('an edge deleted by a fillet comes back with its UUID after delete_face', () => {
    // Author the edge pick on the plain box, then fillet it, then delete the
    // fillet face: the healed edge regains the pre-fillet UUID (the face pair
    // it bounds is restored), so a downstream chamfer on E resolves again. The
    // healed edge's attribution is the extrude, never the delete_face.
    const base = boxSpec()
    const r0 = h.run(base)
    const edges0 = (h.body(r0, 'body_ex1').edge_queries as string[]) ?? []
    expect(edges0.length).toBeGreaterThan(0)
    const E = edges0[0]
    const Euuid = uuidTokenOf(E)

    const filleted: { features: Dict[] } = { features: [...base.features, { id: 'fi1', kind: 'fillet', fillet: { edges: [E], radius: 2 } }] }
    const r1 = h.run(filleted)
    expect(h.res(r1, 'fi1').status).toBe('ok')
    const filletFace = queryByType(meshOf(h, r1, 'body_ex1'), 'cylinderface')[0]
    expect(filletFace).toBeTruthy()

    const spec: { features: Dict[] } = {
      features: [
        ...filleted.features,
        { id: 'df1', kind: 'delete_face', delete_face: { faces: [filletFace] } },
      ],
    }
    const r = h.run(spec)
    expect(h.res(r, 'df1').status).toBe('ok')
    // The healed edge carries the pre-fillet UUID and is attributed to ex1.
    const edgesAfter = (h.body(r, 'body_ex1').edge_queries as string[]) ?? []
    const healed = edgesAfter.find((q) => uuidTokenOf(q) === Euuid)
    expect(healed, `no healed edge; queries: ${edgesAfter.join(' | ')}`).toBeDefined()
    expect(healed).toContain('@ex1')
    expect(healed).not.toContain('@df1')

    // A downstream chamfer on the pre-fillet pick resolves on the healed edge.
    const withChamfer: { features: Dict[] } = {
      features: [...spec.features, { id: 'ch1', kind: 'chamfer', chamfer: { edges: [E], distance: 0.5, kind: 'distance', angle: 45 } }],
    }
    const rc = h.run(withChamfer)
    expect(h.res(rc, 'df1').status).toBe('ok')
    expect(h.res(rc, 'ch1').status).toBe('ok')
  })

  it('faces on two bodies heal independently', () => {
    // Two disjoint boxes; a blind hole in each; delete both holes in one feature.
    const spec: { features: Dict[] } = {
      features: [
        rectSketch('sk1', 20, 20),
        extrude('ex1', '$sk1', 10),
        pointSketch('skh1', 10, 10),
        blindHole('h1', '$skh1', '@body_ex1', 4, 5),
        { ...rectSketch('sk2', 20, 20), initial: { bottom: [30, 0, 50, 0], right: [50, 0, 50, 20], top: [50, 20, 30, 20], left: [30, 20, 30, 0] } },
        extrude('ex2', '$sk2', 10),
        pointSketch('skh2', 40, 10),
        blindHole('h2', '$skh2', '@body_ex2', 4, 5),
      ],
    }
    const r1 = h.run(spec)
    expect(h.res(r1, 'h1').status).toBe('ok')
    expect(h.res(r1, 'h2').status).toBe('ok')
    const f1 = holeFaces(r1, 'body_ex1')
    const f2 = holeFaces(r1, 'body_ex2')
    const withDelete = { features: [...spec.features, { id: 'df1', kind: 'delete_face', delete_face: { faces: [f1.bore, f1.floor, f2.bore, f2.floor] } }] }
    const r = h.run(withDelete)
    expect(h.res(r, 'df1').status).toBe('ok')
    expect((h.res(r, 'df1').body_ids as string[]).sort()).toEqual(['body_ex1', 'body_ex2'])
    expect(bodyVolume(r, 'df1', 'body_ex1')).toBeCloseTo(4000, 2)
    expect(bodyVolume(r, 'df1', 'body_ex2')).toBeCloseTo(4000, 2)
  })
})
