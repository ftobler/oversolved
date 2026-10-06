// @vitest-environment node
//
// Gated real-OCC end-to-end test for the fillet/chamfer LEAF wiring
// (filletChamfer.ts): edge-index build, query resolution, body routing, the OCC
// modifier call, and the in-place body-store + HandleTable update. The OCC
// producer's cross-language parity is gated separately in
// occ/edgeModifierReal.test.ts; here we verify the leaf threads a real body
// through solveFillet/solveChamfer.
//
// Edges are addressed via the index-form `?<bodyId>:edge:<n>` query, which the
// per-body edge index always emits, so the test does not depend on cross-build
// edge enumeration order.
//
// Skips when opencascade.js is absent.

import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from '../../occ/loadOcc'
import { DisposeScope } from '../../occ/disposeScope'
import { HandleTable } from '../../occ/handleTable'
import { makeBox, makeCylinder, faceCentroid, faceNormal, edgeToGeom } from '../../occ/primitives'
import { volumeOf } from '../../occ/booleans'
import { faceGeometryHash } from '../../geomHash'
import { deriveEdgeNames } from '../../occ/constructionLineage'
import { ref, Repository } from '../../query'
import { solveFillet, solveChamfer, resolveFilletEdges } from '../filletChamfer'
import { solidToEdges } from '../../occ/tessellation'
import type { Body } from '../../types3d'
import type { OccModule, OccShape } from '../../occ/occTypes'

const oc = await loadOcc()


describe.skipIf(!oc)('solveFillet/solveChamfer leaf (real OCC)', () => {
  let occ: OccModule
  beforeAll(() => {
    if (!oc) throw new Error('unreachable: skipIf guards this')
    occ = oc
  })

  function makeBody(scope: DisposeScope, table: HandleTable): Record<string, Body> {
    const box = makeBox(occ, scope, 10, 10, 10)

    // Compute face_names and edge_names so that solidToEdges and buildEdgeIndex
    // both emit @u| construction UUID tokens, enabling identity-based edge
    // resolution.
    const E = occ.TopAbs_ShapeEnum
    const faceNames: Record<string, string> = {}
    const faceAncestry: Record<string, string[]> = {}
    const fexp = scope.track(new occ.TopExp_Explorer_2(box, E.TopAbs_FACE, E.TopAbs_SHAPE))
    let fi = 0
    for (; fexp.More(); fexp.Next()) {
      const f = scope.track(occ.TopoDS.Face_1(fexp.Current()))
      const gh = faceGeometryHash(faceCentroid(occ, scope, f), faceNormal(occ, scope, f))
      const uuid = `f${fi++}`
      faceNames[gh] = uuid
      faceAncestry[uuid] = [ref('ex1'), ref('body_b')]
    }
    const { edgeNames, edgeAncestry } = deriveEdgeNames(occ, scope, box, faceNames, faceAncestry)

    return {
      body_b: {
        id: 'body_b',
        created_by: 'ex1',
        modified_by: [],
        shape: table.register(box, 'ex1'),
        sketch_id: 'sk',
        brep_diff: null,
        profile_queries: [],
        face_names: faceNames,
        edge_names: edgeNames,
        face_ancestry: faceAncestry,
        edge_ancestry: edgeAncestry,
      },
    }
  }

  it('fillet rounds a box edge, updates the body in place, threads construction names', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const bodyStore = makeBody(scope, table)
      const result = solveFillet(
        occ,
        scope,
        table,
        { id: 'fil1', fillet: { edges: ['?body_b:edge:0'], radius: 2 } },
        new Repository(),
        bodyStore,
      )
      expect(result.status).toBe('ok')
      expect(result.body_ids).toEqual(['body_b'])
      const body = bodyStore.body_b
      expect(body.modified_by).toEqual(['fil1'])
      expect(volumeOf(occ, scope, table.get<OccShape>(body.shape!))).toBeLessThan(1000)
      expect(volumeOf(occ, scope, table.get<OccShape>(body.shape!))).toBeGreaterThan(985)
      // Original face construction names survive onto the trimmed output faces.
      expect(Object.keys(body.face_names ?? {}).length).toBeGreaterThan(0)
      expect(body.brep_diff).not.toBeNull()
    } finally {
      scope.dispose()
    }
  })

  it('a viewport-form source_body resolves onto the real body and the fillet builds', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const bodyStore = makeBody(scope, table)
      const result = solveFillet(
        occ,
        scope,
        table,
        { id: 'fil1', fillet: { edges: ['?body_b:edge:0'], radius: 2, source_body: 'body:body_b' } },
        new Repository(),
        bodyStore,
      )
      expect(result.status).toBe('ok')
      expect(result.body_ids).toEqual(['body_b'])
      // The viewport prefix resolves to the real body, so the group key is the
      // bodyStore id and the edge index builds against it.
      expect(bodyStore.body_b.modified_by).toEqual(['fil1'])
    } finally {
      scope.dispose()
    }
  })

  it('fillet emits a linear radius handle on the picked edge', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const bodyStore = makeBody(scope, table)
      const result = solveFillet(
        occ,
        scope,
        table,
        { id: 'fil1', fillet: { edges: ['?body_b:edge:0'], radius: 2 } },
        new Repository(),
        bodyStore,
      )
      expect(result.status).toBe('ok')
      const h = result.handle as Record<string, unknown>
      expect(h).toBeDefined()
      expect(h.kind).toBe('linear')
      expect(h.field).toBe('radius')
      expect(h.value).toBe(2)
      // Anchor is the midpoint of a 10-box edge (one coordinate at 5, the
      // others on the box hull), pulling outward along the adjacent-face
      // normal bisector (unit length, pointing away from the box interior).
      const anchor = h.anchor as number[]
      expect(anchor.filter((c) => Math.abs(c - 5) < 1e-6).length).toBeGreaterThanOrEqual(1)
      for (const c of anchor) {
        expect(c).toBeGreaterThanOrEqual(-1e-6)
        expect(c).toBeLessThanOrEqual(10 + 1e-6)
      }
      const dir = h.direction as number[]
      expect(Math.hypot(dir[0], dir[1], dir[2])).toBeCloseTo(1, 6)
      // Outward: stepping from the anchor along the direction leaves the box.
      const stepped = anchor.map((c, i) => c + dir[i])
      const outside = stepped.some((c) => c < -1e-6 || c > 10 + 1e-6)
      expect(outside).toBe(true)
    } finally {
      scope.dispose()
    }
  })

  it('chamfer bevels a box edge', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const bodyStore = makeBody(scope, table)
      const result = solveChamfer(
        occ, scope, table,
        { id: 'cha1', chamfer: { edges: ['?body_b:edge:0'], distance: 2 } },
        new Repository(), bodyStore,
      )
      expect(result.status).toBe('ok')
      expect(bodyStore.body_b.modified_by).toEqual(['cha1'])
      expect(volumeOf(occ, scope, table.get<OccShape>(bodyStore.body_b.shape!))).toBeCloseTo(980, 1)
    } finally {
      scope.dispose()
    }
  })

  it('a radius past what the geometry admits fails loud and leaves body metadata untouched', () => {
    // Regression: applyEdgeModifier reports {success:false} when OCC refuses the
    // operation, but nothing read it -- the leaf re-registered the UNCHANGED
    // shape as a fresh handle, pushed modified_by and overwrote brep_diff with
    // an empty diff while the feature reported ok. A green feature that changed
    // nothing also poisoned dirty detection.
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const bodyStore = makeBody(scope, table)
      const body = bodyStore.body_b
      const shapeBefore = body.shape
      const faceNamesBefore = JSON.stringify(body.face_names)
      const edgeNamesBefore = JSON.stringify(body.edge_names)

      let threw: unknown = null
      try {
        solveFillet(
          occ, scope, table,
          { id: 'fil1', fillet: { edges: ['?body_b:edge:0'], radius: 1000 } },
          new Repository(), bodyStore,
        )
      } catch (e) {
        threw = e
      }
      expect(threw).not.toBeNull()
      expect((threw as Error).message).toContain('fillet')
      expect((threw as Error).message).toContain('body_b')

      // No resplit, no metadata writes: the body reads exactly as before.
      expect(body.modified_by).toEqual([])
      expect(body.brep_diff).toBeNull()
      expect(body.shape).toBe(shapeBefore)
      expect(JSON.stringify(body.face_names)).toBe(faceNamesBefore)
      expect(JSON.stringify(body.edge_names)).toBe(edgeNamesBefore)
    } finally {
      scope.dispose()
    }
  })

  /**
   * The edge selection contract: an `edge_query` produced by `solidToEdges`
   * (what a pick body ships and the viewport stores when the user clicks an
   * edge) must resolve back to exactly that edge through the fillet resolver.
   * Resolution goes through the @u| construction UUID tier.
   */
  it('solidToEdges queries resolve back through resolveFilletEdges (pick round-trip)', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const bodyStore = makeBody(scope, table)
      const body = bodyStore.body_b
      const { edges, edge_queries } = solidToEdges(occ, table, body.shape!, {
        createdBy: body.created_by,
        bodyId: body.id,
        profileQueries: body.profile_queries,
        edgeAncestry: body.edge_ancestry,
        edgeNames: body.edge_names,
      })
      expect(edges.length).toBe(12)
      expect(edge_queries.length).toBe(12)
      // Every emitted query resolves to a single edge.
      for (const q of edge_queries) {
        const resolved = resolveFilletEdges(occ, scope, table, body, [q])
        expect(resolved.length).toBe(1)
      }
      // And a single picked edge actually fillets the body.
      const result = solveFillet(
        occ, scope, table,
        { id: 'fil1', fillet: { edges: [edge_queries[0]], radius: 2 } },
        new Repository(), bodyStore,
      )
      expect(result.status).toBe('ok')
    } finally {
      scope.dispose()
    }
  })

  it('resolveFilletEdges returns exactly 12 unique edges for a box (IsSame dedup)', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const bodyStore = makeBody(scope, table)
      const allEdgeQueries = Array.from({ length: 24 }, (_, i) => `?body_b:edge:${i}`)
      const edges = resolveFilletEdges(occ, scope, table, bodyStore.body_b, allEdgeQueries)
      expect(edges.length).toBe(12)
    } finally {
      scope.dispose()
    }
  })

  it('the ?body:edge:N alias numbers edges by the DISPLAYED geometric sort index', () => {
    // L12: the alias used to number edges in TopExp traversal order, so a spec
    // written against the edge_index the user sees selected a different edge.
    // A cylinder mixes one vertical seam LINE with two circular cap edges, so
    // the line sorts first (type_order 0) and the circles after -- the exact
    // split that explorer order does not guarantee.
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const cyl = makeCylinder(occ, scope, [0, 0, 0], [0, 0, 1], 3, 10)
      const bodyStore: Record<string, Body> = {
        body_c: {
          id: 'body_c',
          created_by: 'ex_c',
          modified_by: [],
          shape: table.register(cyl, 'ex_c'),
          sketch_id: 'sk_c',
          brep_diff: null,
          profile_queries: [],
        },
      }
      const body = bodyStore.body_c
      const { edges } = solidToEdges(occ, table, body.shape!, {})
      expect(edges.length).toBe(3)
      // The first emitted edge is the straight seam; the other two are circular.
      expect(edges[0].kind).toBe('line')
      for (let idx = 0; idx < edges.length; idx++) {
        const resolved = resolveFilletEdges(occ, scope, table, body, [`?body_c:edge:${idx}`])
        expect(resolved.length).toBe(1)
        const { ed } = edgeToGeom(occ, scope, resolved[0])
        expect(ed).toEqual(edges[idx])
      }
    } finally {
      scope.dispose()
    }
  })

  it('fillets a body that carries no construction names', () => {
    // A body with no face/edge identity (e.g. an imported or bare box) has
    // nothing to carry forward, so the modifier runs with oldNames null and the
    // body's name maps stay absent rather than being invented from nothing.
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const box = makeBox(occ, scope, 10, 10, 10)
      const bodyStore: Record<string, Body> = {
        body_b: {
          id: 'body_b', created_by: 'ex1', modified_by: [],
          shape: table.register(box, 'ex1'), sketch_id: 'sk',
          brep_diff: null, profile_queries: [],
        },
      }
      const result = solveFillet(
        occ, scope, table,
        { id: 'fil1', fillet: { edges: ['?body_b:edge:0'], radius: 2 } },
        new Repository(), bodyStore,
      )
      expect(result.status).toBe('ok')
      expect(bodyStore.body_b.face_names).toBeUndefined()
      expect(bodyStore.body_b.edge_names).toBeUndefined()
      const vol = volumeOf(occ, scope, table.get<OccShape>(bodyStore.body_b.shape!))
      expect(vol).toBeLessThan(1000)
      expect(vol).toBeGreaterThan(985)
    } finally {
      scope.dispose()
    }
  })
})
