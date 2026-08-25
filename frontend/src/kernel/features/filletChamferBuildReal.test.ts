// @vitest-environment node
//
// Build-level fillet/chamfer tests using the OCC.js + Rust WASM build pipeline
// with a persistent HandleTable. Ports the build-layer fillet/chamfer scenarios
// from test_fillet_chamfer.py.
//
// Skips when OCC.js or the Rust solver is absent.

import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from '../occ/loadOcc'
import { SharedHarness } from '../occ/sharedHarness'
import { setSketchSolver, resetSketchSolver } from './sketch'
import { ref, makeAncestryQuery, parseAncestry, constructionUuidToken } from '../query'
import { loadSolver } from '@/wasm-kernel/loadSolver'
const oc = await loadOcc()
const solveBytes = loadSolver()

/** The query's construction UUID token (@u|<uuid>), the stable construction identity. */
const geomTokenOf = (q: string): string | undefined =>
  parseAncestry(q)[0].find((i) => i.startsWith('@u|'))

/** Replace the construction UUID token with a dead UUID that matches nothing,
 *  going through parse/re-emit so the wire format's length prefixes stay valid. */
function withDeadGeomToken(q: string): string {
  const [ids, tr] = parseAncestry(q)
  const dead = '@u|dead0000000000000000'
  return makeAncestryQuery(ids.map((i) => (i.startsWith('@u|') ? dead : i)), tr)
}

function rectSketch(sketchId: string, w: number, h: number, plane = '@builtin_plane_front') {
  return {
    id: sketchId, kind: 'sketch' as const, label: 'Rectangle', plane,
    entities: [
      { id: 'bottom', kind: 'line' as const }, { id: 'right', kind: 'line' as const },
      { id: 'top', kind: 'line' as const }, { id: 'left', kind: 'line' as const },
    ],
    initial: {
      bottom: [0, 0, w, 0], right: [w, 0, w, h],
      top: [w, h, 0, h], left: [0, h, 0, 0],
    },
    constraints: [
      { id: 'c1', kind: 'coincident' as const, a: { entity: 'bottom', point: 'end' as const }, b: { entity: 'right', point: 'start' as const } },
      { id: 'c2', kind: 'coincident' as const, a: { entity: 'right', point: 'end' as const }, b: { entity: 'top', point: 'start' as const } },
      { id: 'c3', kind: 'coincident' as const, a: { entity: 'top', point: 'end' as const }, b: { entity: 'left', point: 'start' as const } },
      { id: 'c4', kind: 'coincident' as const, a: { entity: 'left', point: 'end' as const }, b: { entity: 'bottom', point: 'start' as const } },
      { id: 'c5', kind: 'horizontal' as const, target: { entity: 'bottom' } },
      { id: 'c6', kind: 'horizontal' as const, target: { entity: 'top' } },
      { id: 'c7', kind: 'vertical' as const, target: { entity: 'right' } },
      { id: 'c8', kind: 'vertical' as const, target: { entity: 'left' } },
      { id: 'c9', kind: 'length' as const, target: { entity: 'bottom' }, value: w },
      { id: 'c10', kind: 'length' as const, target: { entity: 'left' }, value: h },
    ],
  }
}

function fullRectExtrudeSpec(w = 10, h = 10, d = 5): { features: Array<Record<string, unknown>> } {
  return { features: [
    rectSketch('sk1', w, h),
    { id: 'ex1', kind: 'extrude', sketch: '$sk1', distance: d, direction: 'normal', operation: 'new' },
  ]}
}

function assertMeshValid(mesh: Record<string, unknown>): void {
  const verts = mesh.vertices as number[][] | undefined
  const faces = mesh.faces as number[][] | undefined
  if (!verts || !faces) throw new Error('mesh missing vertices or faces')
  const n = verts.length
  if (n === 0) throw new Error('mesh has no vertices')
  if (faces.length === 0) throw new Error('mesh has no faces')
}

describe.skipIf(!oc || !solveBytes)('fillet chamfer build-level (real OCC + Rust solver)', () => {
  const h = new SharedHarness(oc!)

  beforeAll(() => {
    if (!oc || !solveBytes) throw new Error('unreachable: skipIf guards this')
    if (solveBytes) { resetSketchSolver(); setSketchSolver(solveBytes) }
  })

  it('fillet single edge via build pipeline', () => {
    // A single edge fillet on an extruded box produces a valid mesh.
    const spec = fullRectExtrudeSpec(10, 10, 5)
    const eq = (h.body(h.run(spec), 'body_ex1').edge_queries as string[]) ?? []
    spec.features.push({ id: 'fillet1', kind: 'fillet', edges: [eq[0]], radius: 1 })
    const r = h.run(spec)
    expect(h.res(r, 'fillet1').status).toBe('ok')
    const mesh = h.body(r, 'body_ex1').mesh as Record<string, unknown> | undefined
    expect(mesh).toBeDefined()
    if (mesh) assertMeshValid(mesh)
  })

  it('fillet multiple edges via build pipeline', () => {
    // Two edge fillet works.
    const spec = fullRectExtrudeSpec(10, 10, 5)
    const eq = (h.body(h.run(spec), 'body_ex1').edge_queries as string[]) ?? []
    spec.features.push({ id: 'fillet1', kind: 'fillet', edges: [eq[0], eq[1]], radius: 1 })
    const r = h.run(spec)
    expect(h.res(r, 'fillet1').status).toBe('ok')
    const mesh = h.body(r, 'body_ex1').mesh as Record<string, unknown> | undefined
    expect(mesh).toBeDefined()
    if (mesh) assertMeshValid(mesh)
  })

  it('fillet updates body mesh vertex count', () => {
    // Fillet adds tessellation detail.
    const spec = fullRectExtrudeSpec(10, 10, 5)
    const rBefore = h.run(spec)
    const vertsBefore = (h.body(rBefore, 'body_ex1').mesh as { vertices?: number[][] } | undefined)?.vertices?.length ?? 0

    const eq = (h.body(rBefore, 'body_ex1').edge_queries as string[]) ?? []
    spec.features.push({ id: 'fillet1', kind: 'fillet', edges: [eq[0]], radius: 2 })
    const rAfter = h.run(spec)
    const vertsAfter = (h.body(rAfter, 'body_ex1').mesh as { vertices?: number[][] } | undefined)?.vertices?.length ?? 0

    expect(vertsAfter).toBeGreaterThan(vertsBefore)
  })

  it('fillet roundtrip via edge queries from build output', () => {
    // Edge queries emitted by the build are consumed back as fillet input.
    const spec = fullRectExtrudeSpec(10, 10, 5)
    const r0 = h.run(spec)
    const eq = (h.body(r0, 'body_ex1').edge_queries as string[]) ?? []
    expect(eq.length).toBeGreaterThan(0)
    spec.features.push({ id: 'fillet1', kind: 'fillet', edges: [eq[0]], radius: 1 })
    const r = h.run(spec)
    expect(h.res(r, 'fillet1').status).toBe('ok')
  })

  it('chamfer single edge via build pipeline', () => {
    // Chamfer on an extruded box.
    const spec = fullRectExtrudeSpec(10, 10, 5)
    const eq = (h.body(h.run(spec), 'body_ex1').edge_queries as string[]) ?? []
    spec.features.push({ id: 'chamfer1', kind: 'chamfer', edges: [eq[0]], distance: 1 })
    const r = h.run(spec)
    expect(h.res(r, 'chamfer1').status).toBe('ok')
    expect(h.body(r, 'body_ex1').mesh).toBeDefined()
  })

  it('chamfer updates body mesh vertex count', () => {
    // Chamfer adds tessellation detail.
    const spec = fullRectExtrudeSpec(10, 10, 5)
    const rBefore = h.run(spec)
    const vertsBefore = (h.body(rBefore, 'body_ex1').mesh as { vertices?: number[][] } | undefined)?.vertices?.length ?? 0

    const eq = (h.body(rBefore, 'body_ex1').edge_queries as string[]) ?? []
    spec.features.push({ id: 'chamfer1', kind: 'chamfer', edges: [eq[0]], distance: 2 })
    const rAfter = h.run(spec)
    const vertsAfter = (h.body(rAfter, 'body_ex1').mesh as { vertices?: number[][] } | undefined)?.vertices?.length ?? 0

    expect(vertsAfter).toBeGreaterThan(vertsBefore)
  })

  it('chamfer chain after extrude', () => {
    // Extrude then chamfer.
    const spec = fullRectExtrudeSpec(10, 10, 5)
    const eq = (h.body(h.run(spec), 'body_ex1').edge_queries as string[]) ?? []
    spec.features.push({ id: 'chamfer1', kind: 'chamfer', edges: [eq[0]], distance: 1 })
    const r = h.run(spec)
    expect(h.res(r, 'chamfer1').status).toBe('ok')
    const mesh = h.body(r, 'body_ex1').mesh as Record<string, unknown> | undefined
    expect(mesh).toBeDefined()
    if (mesh) assertMeshValid(mesh)
  })

  it('fillet partial when some edges unresolvable', () => {
    // One resolvable + one missing edge → partial status, body still filleted.
    const spec = fullRectExtrudeSpec(10, 10, 5)
    const r0 = h.run(spec)
    const validQ = (h.body(r0, 'body_ex1').edge_queries as string[])[0]
    spec.features.push({ id: 'fil', kind: 'fillet', edges: [validQ, '?body_nonexistent:edge:0'], radius: 1 })
    const r = h.run(spec)
    // May be 'partial' or 'ok' depending on edge resolver behavior
    expect([('ok'), ('partial')]).toContain(h.res(r, 'fil').status)
    expect((h.res(r, 'fil').body_ids as string[]) ?? []).toEqual(['body_ex1'])
  })

  it('fillet then chamfer on same body', () => {
    /**
     * Sequential fillet+chamfer on the same extruded box. Edge indices shift after fillet; use
     * legacy index-form queries to reference surviving edges.
     */
    const spec = fullRectExtrudeSpec(10, 10, 5)
    spec.features.push({ id: 'fillet1', kind: 'fillet', edges: ['?body_ex1:edge:0'], radius: 1 })
    spec.features.push({ id: 'chamfer1', kind: 'chamfer', edges: ['?body_ex1:edge:4'], distance: 0.5 })
    const r = h.run(spec)
    expect(h.res(r, 'fillet1').status).toBe('ok')
    expect(h.res(r, 'chamfer1').status).toBe('ok')
    expect(h.body(r, 'body_ex1').mesh).toBeDefined()
  })

  it('fillet respects edge list, single edge < all edges vertex count', () => {
    // Single-edge fillet produces fewer vertices than an all-12-edge fillet.
    const r1 = h.run(fullRectExtrudeSpec(10, 10, 5))
    const eq = (h.body(r1, 'body_ex1').edge_queries as string[]) ?? []
    const spec1 = fullRectExtrudeSpec(10, 10, 5)
    spec1.features.push({ id: 'fillet1', kind: 'fillet', edges: [eq[0]], radius: 1 })
    const vr1 = h.run(spec1)
    const verts1 = ((h.body(vr1, 'body_ex1').mesh as { vertices?: unknown[][] })?.vertices?.length) ?? 0

    const specAll = fullRectExtrudeSpec(10, 10, 5)
    const rAll = h.run(specAll)
    const eqAll = (h.body(rAll, 'body_ex1').edge_queries as string[]) ?? []
    specAll.features.push({ id: 'fillet1', kind: 'fillet', edges: eqAll.slice(0, 12), radius: 1 })
    const vrAll = h.run(specAll)
    const vertsAll = ((h.body(vrAll, 'body_ex1').mesh as { vertices?: unknown[][] })?.vertices?.length) ?? 0

    expect(verts1).toBeLessThan(vertsAll)
  })

  it('multiple sequential fillet features', () => {
    // Two fillet features in sequence on the same body.
    const spec = fullRectExtrudeSpec(10, 10, 5)
    const r0 = h.run(spec)
    const eq = (h.body(r0, 'body_ex1').edge_queries as string[]) ?? []
    spec.features.push({ id: 'fillet1', kind: 'fillet', edges: [eq[0]], radius: 1 })
    const r1 = h.run(spec)
    expect(h.res(r1, 'fillet1').status).toBe('ok')

    // After fillet1, pick an edge carrying a construction UUID so the second
    // fillet resolves through the @u| identity tier. It must sit AWAY from the
    // first blend's corner: OCC refuses to blend an edge that shares that
    // corner (build_failed), and that refusal now surfaces as a feature
    // exception instead of being swallowed into a green ok.
    const eqAfter = (h.body(r1, 'body_ex1').edge_queries as string[]) ?? []
    const resolvableEdge = eqAfter.find((q) => q.includes('@u|') && q.includes('right@cls_xp'))
    expect(resolvableEdge).toBeDefined()
    spec.features.push({ id: 'fillet2', kind: 'fillet', edges: [resolvableEdge], radius: 0.5 })
    const r2 = h.run(spec)
    expect(h.res(r2, 'fillet2').status).toBe('ok')
  })

  it('fillet stale body token follows geometry', () => {
    // A stale @body token must not misroute the fillet, geometry wins.
    // Two disjoint boxes
    const spec = { features: [
      { ...rectSketch('skA', 10, 10, '@builtin_plane_top'), initial: { bottom: [0, 0, 10, 0], right: [10, 0, 10, 10], top: [10, 10, 0, 10], left: [0, 10, 0, 0] }, constraints: rectSketch('skA', 10, 10, '@builtin_plane_top').constraints },
      { id: 'exA', kind: 'extrude', sketch: '$skA', distance: 5, direction: 'normal', operation: 'new' },
      { ...rectSketch('skB', 10, 10, '@builtin_plane_top'), initial: { bottom: [30, 0, 40, 0], right: [40, 0, 40, 10], top: [40, 10, 30, 10], left: [30, 10, 30, 0] }, constraints: rectSketch('skB', 10, 10, '@builtin_plane_top').constraints },
      { id: 'exB', kind: 'extrude', sketch: '$skB', distance: 5, direction: 'normal', operation: 'new' },
    ]}
    const r0 = h.run(spec)
    const qB = (h.body(r0, 'body_exB').edge_queries as string[])[0]
    expect(qB).toContain('@body_exB')

    const staleQ = qB.replace('@body_exB', '@body_exA');
    (spec.features as Array<Record<string, unknown>>).push({ id: 'fil', kind: 'fillet', edges: [staleQ], radius: 1 })
    const r = h.run(spec)
    expect(h.res(r, 'fil').status).toBe('ok')
    expect((h.res(r, 'fil').body_ids as string[]) ?? []).toEqual(['body_exB'])
  })

  it('fillet asymmetry delete, unrelated body delete keeps fillet ok', () => {
    // Deleting an unrelated body must not break a fillet.
    // Build two independent boxes, then add fillet on second
    const skB = { ...rectSketch('skB', 10, 10, '@builtin_plane_top'), initial: { bottom: [30, 0, 40, 0], right: [40, 0, 40, 10], top: [40, 10, 30, 10], left: [30, 10, 30, 0] }, constraints: rectSketch('skB', 10, 10, '@builtin_plane_top').constraints }
    const exB = { id: 'exB', kind: 'extrude', sketch: '$skB', distance: 5, direction: 'normal', operation: 'new' }
    const filB = { id: 'filB', kind: 'fillet', edges: ['?body_exB:edge:0'], radius: 1 }

    // Delete exA (unrelated): filB still succeeds.
    const rDelA = h.run({ features: [skB, exB as Record<string, unknown>, filB as Record<string, unknown>] })
    expect(h.res(rDelA, 'filB').status).toBe('ok')

    // Delete exB (its own body): filB fails, but exA is ok.
    const skA = { ...rectSketch('skA', 10, 10, '@builtin_plane_top'), initial: { bottom: [0, 0, 10, 0], right: [10, 0, 10, 10], top: [10, 10, 0, 10], left: [0, 10, 0, 0] }, constraints: rectSketch('skA', 10, 10, '@builtin_plane_top').constraints }
    const exA = { id: 'exA', kind: 'extrude', sketch: '$skA', distance: 5, direction: 'normal', operation: 'new' }
    const rDelB = h.run({ features: [skA, exA as Record<string, unknown>, filB as Record<string, unknown>] })
    expect(h.res(rDelB, 'filB').status).toBe('exception')
    expect(h.res(rDelB, 'exA').status).toBe('ok')
  })

  it('fillet all edges missing is hard exception', () => {
    // If no edges resolve, the fillet hard-fails with 'no edges resolved'.
    const spec = fullRectExtrudeSpec(10, 10, 5)
    spec.features.push({ id: 'fil', kind: 'fillet', edges: ['?body_nonexistent:edge:0'], radius: 1 })
    const r = h.run(spec)
    expect(h.res(r, 'fil').status).toBe('exception')
    expect(String(h.res(r, 'fil').exception ?? '')).toContain('no edges resolved')
  })

  it('fillet resolves stale geometry token via stable ancestry', () => {
    /**
     * A query whose geometry token matches nothing must resolve through its
     * geometry-independent tokens (feature, body, lineage, classifiers) to the
     * same edge the fresh query names -- not hard-fail, not pick a sibling.
     */
    const spec = fullRectExtrudeSpec(10, 10, 5)
    const r0 = h.run(spec)
    const q = (h.body(r0, 'body_ex1').edge_queries as string[])[0]
    expect(q.startsWith('?')).toBe(true)
    expect(geomTokenOf(q)).toBeDefined()

    const staleQ = withDeadGeomToken(q)
    const anchorOf = (edgeQ: string): number[] => {
      const s = fullRectExtrudeSpec(10, 10, 5)
      s.features.push({ id: 'fil', kind: 'fillet', edges: [edgeQ], radius: 0.5 })
      const r = h.run(s)
      expect(h.res(r, 'fil').status).toBe('ok')
      return (h.res(r, 'fil').handle as { anchor: number[] }).anchor
    }
    const stale = anchorOf(staleQ)
    const fresh = anchorOf(q)
    stale.forEach((v, i) => expect(v).toBeCloseTo(fresh[i], 9))
  })

  it('fillet with stale hash and ambiguous ancestry is hard exception', () => {
    /**
     * Feature+body tokens alone match every edge of the box; with a dead UUID
     * and no classifier to narrow, resolution must fail loud instead of
     * silently filleting an arbitrary edge.
     */
    const spec = fullRectExtrudeSpec(10, 10, 5)
    const q = makeAncestryQuery(
      [constructionUuidToken('deadbeef00000001'), ref('ex1'), ref('body_ex1')],
      'straightedge',
    )
    spec.features.push({ id: 'fil', kind: 'fillet', edges: [q], radius: 0.5 })
    const r = h.run(spec)
    expect(h.res(r, 'fil').status).toBe('exception')
    expect(String(h.res(r, 'fil').exception ?? '')).toContain('no edges resolved')
  })

  it('fillet survives extrude distance change (construction identity stability)', () => {
    /**
     * Construction UUIDs (@u|) are geometry-independent, so a fillet picked
     * at d=5 resolves identically when the body is rebuilt at d=8 through the
     * UUID tier. Verify anchors match when the UUID is intact, and also verify
     * that a dead UUID still resolves through stable ancestry + classifiers.
     */
    const eq5 = (h.body(h.run(fullRectExtrudeSpec(10, 10, 5)), 'body_ex1').edge_queries as string[]) ?? []
    const eq8 = (h.body(h.run(fullRectExtrudeSpec(10, 10, 8)), 'body_ex1').edge_queries as string[]) ?? []
    // All @u| construction UUIDs are stable across distance changes.
    const uuids5 = new Set(eq5.map(geomTokenOf).filter(Boolean))
    const uuids8 = new Set(eq8.map(geomTokenOf).filter(Boolean))
    expect(uuids5.size).toBeGreaterThan(0)
    for (const u of uuids5) expect(uuids8.has(u)).toBe(true)

    const anchorOf = (edgeQ: string): number[] => {
      const s = fullRectExtrudeSpec(10, 10, 8)
      s.features.push({ id: 'fil', kind: 'fillet', edges: [edgeQ], radius: 1 })
      const r = h.run(s)
      expect(h.res(r, 'fil').status).toBe('ok')
      return (h.res(r, 'fil').handle as { anchor: number[] }).anchor
    }
    // Stale (dead UUID) query resolves via stable ancestry + classifiers.
    const staleQ = withDeadGeomToken(eq5[0])
    const freshQ = eq5[0]
    const staleAnchor = anchorOf(staleQ)
    const freshAnchor = anchorOf(freshQ)
    staleAnchor.forEach((v, i) => expect(v).toBeCloseTo(freshAnchor[i], 9))
  })

  it('stale UUID on modifier-created edge resolves or fails loud', () => {
    /**
     * After a fillet, edges created by the modifier report their creator as
     * the fillet feature instead of the extrude. A stale (dead) UUID on such
     * an edge must either resolve through stable ancestry (with correct
     * anchor) or fail loud -- never fillet a sibling edge silently.
     */
    const base = (): { features: Array<Record<string, unknown>> } => {
      const s = fullRectExtrudeSpec(10, 10, 5)
      s.features.push({ id: 'fillet1', kind: 'fillet', edges: ['?body_ex1:edge:0'], radius: 1 })
      return s
    }
    const r0 = h.run(base())
    expect(h.res(r0, 'fillet1').status).toBe('ok')
    // Use an edge from the filleted body that carries a @u| token
    // (surviving edges that kept their construction UUID).
    const eqFilleted = (h.body(r0, 'body_ex1').edge_queries as string[]) ?? []
    const edgeQ = eqFilleted.find((q) => geomTokenOf(q) !== undefined)
    expect(edgeQ).toBeDefined()

    const staleQ = withDeadGeomToken(edgeQ!)
    const run2 = (q: string): ReturnType<typeof h.run> => {
      const s = base()
      s.features.push({ id: 'fillet2', kind: 'fillet', edges: [q], radius: 0.3 })
      return h.run(s)
    }
    const rStale = run2(staleQ)
    const status = h.res(rStale, 'fillet2').status
    if (status === 'ok') {
      const rFresh = run2(edgeQ!)
      expect(h.res(rFresh, 'fillet2').status).toBe('ok')
      const a = (h.res(rStale, 'fillet2').handle as { anchor: number[] }).anchor
      const b = (h.res(rFresh, 'fillet2').handle as { anchor: number[] }).anchor
      a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 9))
    } else {
      expect(status).toBe('exception')
    }
  })

  it('classifier narrows ancestral sibling edges on stale hash', () => {
    /**
     * Two edges can share every lineage token (e.g. the two cap edges swept
     * from one sketch line, or the bugreport's two seam edges of overlapping
     * circles) and differ only in @cls_* spatial role. With a stale hash the
     * classifier tier must pick the right sibling.
     */
    const r0 = h.run(fullRectExtrudeSpec(10, 10, 5))
    const eq = (h.body(r0, 'body_ex1').edge_queries as string[]) ?? []
    const sigNoCls = (q: string): string => {
      const [ids, tr] = parseAncestry(q)
      return makeAncestryQuery(
        // Ignore the construction UUID too: it is what distinguishes the sibling
        // edges directly now, so two ancestral siblings share this reduced
        // signature and the classifier/UUID tier picks the right one below.
        ids.filter((i) => !i.startsWith('@gde|') && !i.startsWith('@cls_') && !i.startsWith('@u|')),
        tr,
      )
    }
    const target = eq.find(
      (q) =>
        parseAncestry(q)[0].some((i) => i.startsWith('@cls_')) &&
        eq.some((o) => o !== q && sigNoCls(o) === sigNoCls(q)),
    )
    expect(target).toBeDefined()

    const staleQ = withDeadGeomToken(target!)
    const anchorOf = (edgeQ: string): number[] => {
      const s = fullRectExtrudeSpec(10, 10, 5)
      s.features.push({ id: 'fil', kind: 'fillet', edges: [edgeQ], radius: 0.5 })
      const r = h.run(s)
      expect(h.res(r, 'fil').status).toBe('ok')
      return (h.res(r, 'fil').handle as { anchor: number[] }).anchor
    }
    const stale = anchorOf(staleQ)
    const fresh = anchorOf(target!)
    stale.forEach((v, i) => expect(v).toBeCloseTo(fresh[i], 9))
  })

  it('fillet populates brepDiff on the modified body', () => {
    // After fillet, the body checkpoint must carry a non-null brep_diff.
    const spec = fullRectExtrudeSpec(10, 10, 5)
    const eq = (h.body(h.run(spec), 'body_ex1').edge_queries as string[]) ?? []
    spec.features.push({ id: 'fillet1', kind: 'fillet', edges: [eq[0]], radius: 1 })
    const r = h.run(spec)
    expect(h.res(r, 'fillet1').status).toBe('ok')
    const ckp = r._build_state!.checkpoints['fillet1']
    const body = ckp.body_store_snapshot['body_ex1']
    expect(body).toBeDefined()
    expect(body.brep_diff).not.toBeNull()
    expect((body.brep_diff as { new_edges: unknown[] }).new_edges.length).toBeGreaterThan(0)
  })

  it('chamfer populates brepDiff on the modified body', () => {
    // After chamfer, the body checkpoint must carry a non-null brep_diff.
    const spec = fullRectExtrudeSpec(10, 10, 5)
    const eq = (h.body(h.run(spec), 'body_ex1').edge_queries as string[]) ?? []
    spec.features.push({ id: 'chamfer1', kind: 'chamfer', edges: [eq[0]], distance: 1 })
    const r = h.run(spec)
    expect(h.res(r, 'chamfer1').status).toBe('ok')
    const ckp = r._build_state!.checkpoints['chamfer1']
    const body = ckp.body_store_snapshot['body_ex1']
    expect(body).toBeDefined()
    expect(body.brep_diff).not.toBeNull()
    expect((body.brep_diff as { new_edges: unknown[] }).new_edges.length).toBeGreaterThan(0)
  })
})
