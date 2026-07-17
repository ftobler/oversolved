// @vitest-environment node
//
// REGRESSION LOCK for the confirmed "fillet lands on the wrong edge" bug
// (query-naming-by-construction.md, Stage 6.5 residual: "edges touching an
// UNNAMED face -- perGroup multi-group extrude fallback").
//
// Reported symptom: a plate extruded from a multi-region profile, then filleted;
// several vertical side edges share ONE query with no `@u|` construction UUID, so
// the fillet resolver last-wins-resolves the duplicate to one arbitrary edge.
//
// Root cause (diagnosed here): a MULTI-GROUP extrude whose groups OVERLAP fuses
// to one solid and takes the merged-profile re-prism path
// (`extrudeProfileWithLineage` -> `tryCanonicalMergedProfile` ->
// `prismFaceWithLineage` -> `buildPrismLineageMap`). The union TRIMS some profile
// edges to the boolean-intersection point, so `entityForEdges`
// (prismLineage.ts, exact-endpoint match, POINT_TOL=1e-6) can no longer attribute
// them to a sketch entity id. Those side faces get NO face UUID
// (`buildPrismLineageMap`: `match === undefined` -> `uuid` stays null -> not put
// in `faceNames`). A vertical edge between two such UNNAMED side faces then has
// `distinct.length === 0` in the edge-UUID derivation, so it earns neither a
// two-face `deriveEdgeUuid` nor a one-face `deriveSeamEdgeUuid`; its query drops
// to `createdBy + bodyId (+ classifiers)` -- non-unique across symmetric edges.
//
// NOTE (corrects the original hypothesis): arcs / fillet corners are NOT the
// trigger. A single-group profile -- straight OR arc-cornered -- names every side
// face and every edge (see the positive-control test below). The trigger is
// purely the multi-group profile UNION trimming edges off their source entity.
//
// This test LOCKS THE CURRENT (buggy) STATE: it asserts that >=2 vertical side
// edges share one identical query carrying no `@u|`. The follow-up fix (mint a
// construction UUID for the merged-profile side faces -- e.g. attribute each
// trimmed edge to the entity whose supporting line/curve contains it, or carry
// the per-group face names through the fuse+clean history like
// `transferBooleanNames` does) must FLIP these assertions: zero unnamed side
// faces, and every vertical side-edge query unique and carrying `@u|`. The
// `AFTER THE FIX` block below states exactly what to assert then.
import { describe, it, expect } from 'vitest'
import { loadOcc } from './loadOcc'
import { DisposeScope } from './disposeScope'
import { HandleTable } from './handleTable'
import { extrudeProfileWithLineage } from './prismLineage'
import { solidToEdges } from './tessellation'
import { faceGh } from './lineageHash'
import { faceNormal } from './primitives'
import type { PlaneLike } from '../features/shared'
import type { LoopEdge } from '../profileLoops'
import type { OccShape } from './occTypes'

const oc = await loadOcc()
const XY: PlaneLike = { origin: [0, 0, 0], x_axis: [1, 0, 0], y_axis: [0, 1, 0], normal: [0, 0, 1] }

/** An axis-aligned rectangle loop (CCW) with per-edge sketch-entity ids. */
function rectLoop(x0: number, y0: number, x1: number, y1: number, p: string): LoopEdge[] {
  return [
    { id: p + 'b', kind: 'line', start: [x0, y0], end: [x1, y0] },
    { id: p + 'r', kind: 'line', start: [x1, y0], end: [x1, y1] },
    { id: p + 't', kind: 'line', start: [x1, y1], end: [x0, y1] },
    { id: p + 'l', kind: 'line', start: [x0, y1], end: [x0, y0] },
  ] as unknown as LoopEdge[]
}

/** A rounded rectangle (W x H, corner radius r): 4 lines + 4 quarter-arc fillets. */
function roundedRect(W: number, H: number, r: number): LoopEdge[] {
  return [
    { id: 'bottom', kind: 'line', start: [r, 0], end: [W - r, 0] },
    { id: 'br', kind: 'arc', center: [W - r, r], radius: r, angle_start_deg: 270, angle_end_deg: 360, ccw: true, start: [W - r, 0], end: [W, r] },
    { id: 'right', kind: 'line', start: [W, r], end: [W, H - r] },
    { id: 'tr', kind: 'arc', center: [W - r, H - r], radius: r, angle_start_deg: 0, angle_end_deg: 90, ccw: true, start: [W, H - r], end: [W - r, H] },
    { id: 'top', kind: 'line', start: [W - r, H], end: [r, H] },
    { id: 'tl', kind: 'arc', center: [r, H - r], radius: r, angle_start_deg: 90, angle_end_deg: 180, ccw: true, start: [r, H], end: [0, H - r] },
    { id: 'left', kind: 'line', start: [0, H - r], end: [0, r] },
    { id: 'bl', kind: 'arc', center: [r, r], radius: r, angle_start_deg: 180, angle_end_deg: 270, ccw: true, start: [0, r], end: [r, 0] },
  ] as unknown as LoopEdge[]
}

interface Coverage {
  edgeQueries: string[]
  vertical: boolean[]  // per edge: is it a vertical (z-spanning) side edge
  unnamedSideFaces: number
}

/** Extrude the loops, then report per-edge queries + unnamed side-face count. */
function coverage(loops: LoopEdge[][]): Coverage {
  const scope = new DisposeScope()
  const table = new HandleTable({ finalizerGuard: false })
  try {
    const res = extrudeProfileWithLineage(oc!, scope, loops, XY, [0, 0, 1], 5, 'sk1', 'ex1')
    // count side faces (near-vertical normal) that earned no face UUID
    let unnamedSideFaces = 0
    const E = oc!.TopAbs_ShapeEnum
    const fexp = scope.track(new oc!.TopExp_Explorer_2(res.solid as OccShape, E.TopAbs_FACE, E.TopAbs_SHAPE))
    for (; fexp.More(); fexp.Next()) {
      const f = scope.track(oc!.TopoDS.Face_1(fexp.Current()))
      const n = faceNormal(oc!, scope, f)
      if (Math.abs(n[2]) < 0.5 && !res.faceNames[faceGh(oc!, scope, f)]) unnamedSideFaces++
    }
    const handle = table.register(res.solid)
    const eres = solidToEdges(oc!, table, handle, {
      createdBy: 'ex1', bodyId: 'body_ex1',
      edgeAncestry: res.edgeAncestry, edgeNames: res.edgeNames, profileQueries: [],
    })
    const vertical = eres.edges.map((ed) => {
      const e = ed as unknown as { start?: number[]; end?: number[] }
      const s = e.start ?? [0, 0, 0]; const en = e.end ?? [0, 0, 0]
      return Math.abs((s[0] ?? 0) - (en[0] ?? 0)) < 1e-6 &&
        Math.abs((s[1] ?? 0) - (en[1] ?? 0)) < 1e-6 &&
        Math.abs((s[2] ?? 0) - (en[2] ?? 0)) > 0.5
    })
    return { edgeQueries: eres.edge_queries, vertical, unnamedSideFaces }
  } finally { scope.dispose() }
}

/** Query strings that appear more than once in the list. */
function duplicates(queries: string[]): string[] {
  const seen = new Set<string>(); const dup = new Set<string>()
  for (const q of queries) { if (seen.has(q)) dup.add(q); seen.add(q) }
  return [...dup]
}

describe.skipIf(!oc)('plate edge UUID coverage: multi-group profile-union gap', () => {
  // ── positive control: a single-group profile names everything ──
  it('single-group rounded plate: every side edge is unique and carries @u|', () => {
    const c = coverage([roundedRect(20, 12, 3)])
    expect(c.unnamedSideFaces).toBe(0)
    const vertQueries = c.edgeQueries.filter((_, i) => c.vertical[i])
    expect(vertQueries.length).toBeGreaterThan(0)
    for (const q of vertQueries) expect(q).toContain('@u|')
    expect(duplicates(c.edgeQueries)).toEqual([])
  })

  // ── the bug: a multi-group (overlapping) profile leaves side faces unnamed ──
  //
  // Two overlapping rectangles (an offset "stair") fuse to one solid, so the
  // extrude takes the merged-profile re-prism path. Four side faces -- the ones
  // whose profile edge the union trimmed -- get no UUID, and two vertical side
  // edges between them collapse to one identical, `@u|`-less query.
  it('LOCKS BUG: overlapping-profile plate has vertical side edges sharing a no-@u| query', () => {
    const c = coverage([rectLoop(0, 0, 12, 8, 'A'), rectLoop(8, 4, 20, 16, 'B')])

    // Some side faces are unnamed (the diagnosed cause).
    expect(c.unnamedSideFaces).toBeGreaterThan(0)

    // At least one vertical side edge carries no construction UUID.
    const vertNoU = c.edgeQueries.filter((q, i) => c.vertical[i] && !q.includes('@u|'))
    expect(vertNoU.length).toBeGreaterThanOrEqual(2)

    // ...and >=2 of those vertical no-@u| edges share ONE identical query --
    // exactly the non-uniqueness that makes the fillet resolver pick the wrong
    // edge. This is the assertion the follow-up fix must break.
    expect(duplicates(vertNoU).length).toBeGreaterThanOrEqual(1)

    // AFTER THE FIX, replace the three assertions above with:
    //   expect(c.unnamedSideFaces).toBe(0)
    //   for (const [i, isV] of c.vertical.entries())
    //     if (isV) expect(c.edgeQueries[i]).toContain('@u|')
    //   expect(duplicates(c.edgeQueries)).toEqual([])
  })
})
