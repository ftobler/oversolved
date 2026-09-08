// @vitest-environment node
//
// Corpus regression for bugreports/edge_resolves_not_unique_20260728_213049.md.
//
// The user picked one edge of a filleted, arrayed body and it highlighted (and
// filleted) several edges at once. The stored pick was
//   ?..;@<extrude>@body_<extrude>@<sk>/<circleA>@<sk>/<circleB>:straightedge
// -- no construction @u| token, and the two sketch-circle tokens are the body's
// `profile_queries`, the fallback an edge with no UUID falls back to. That
// fallback string is IDENTICAL for every unnamed edge on the body, so all of
// them share one query and only the spatial `@cls_*` classifiers (which are
// empty near the body centre) could tell them apart.
//
// Where the UUIDs went missing: filleting several edges that meet grows a
// CORNER PATCH face, and OCC generates that patch from a VERTEX, not from any
// filleted edge -- so the modifier's edge-driven naming never reached it. The
// patch stayed unnamed, and so did every edge around it.
//
// This test builds the smallest shape with that corner: an annular extrude
// arrayed into an overlapping pair, with the outer rims filleted so the two
// blends run into each other. The assertion is the identity invariant the bug
// violated -- every pickable edge carries its own UUID, and no two edges share
// a query -- rather than the user's exact 8-instance model, because the
// duplicate-pick symptom only surfaces once enough copies land near the body
// centre for their classifiers to collapse too.
//
// Skips when OCC.js or the Rust solver is absent.

import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from '../occ/loadOcc'
import { SharedHarness } from '../occ/sharedHarness'
import { setSketchSolver, resetSketchSolver } from './sketch'
import { ref, makeAncestryQuery } from '../query'
import { loadSolver } from '@/wasm-kernel/loadSolver'
const oc = await loadOcc()
const solveBytes = loadSolver()

const SK = 'sk1'
const OUTER = 'circOuter'
const INNER = 'circInner'
const DIR = 'dirLine'
const EX = 'ex1'
const ARR = 'arr1'
const FIL = 'fil1'
const BODY = `body_${EX}`

/** Concentric circles on the top plane, plus the construction line the array
 *  takes its direction from (mirrors the bug report's sketch 1). */
const sketch = {
  id: SK, kind: 'sketch', label: 'sketch 1', plane: '@builtin_plane_top',
  entities: [
    { id: OUTER, kind: 'circle' },
    { id: INNER, kind: 'circle' },
    { id: DIR, kind: 'line', construction: true },
  ],
  initial: {
    [OUTER]: [0, 0, 2.9],
    [INNER]: [0, 0, 1.1],
    [DIR]: [0, 0, 8.4, 0],
  },
  constraints: [
    { id: 'c1', kind: 'coincident', a: `$${OUTER}center`, b: '@builtin_origin' },
    { id: 'c2', kind: 'coincident', a: `$${INNER}center`, b: '@builtin_origin' },
    { id: 'c3', kind: 'diameter', target: `$${INNER}`, value: 2.2 },
    { id: 'c4', kind: 'radius_difference', a: `$${OUTER}`, b: `$${INNER}`, value: 1.8 },
    { id: 'c5', kind: 'coincident', a: `$${DIR}start`, b: '@builtin_origin' },
    { id: 'c6', kind: 'horizontal', target: `$${DIR}` },
  ],
}

const extrude = {
  id: EX, kind: 'extrude', label: 'extrude 1',
  extrude: {
    direction: 'normal', distance: 2,
    // The annular profile: outer circle bounding, inner circle as the hole.
    sketch: [makeAncestryQuery([ref(`${SK}/${OUTER}`), 'surface:0', ref(SK)], 'flatface')],
  },
}

// Pitch 4 against outer diameter 5.8: the copy overlaps the source, so the
// fuse is one solid and the two outer cylinders genuinely intersect.
const array = {
  id: ARR, kind: 'array', label: 'array 1',
  array: {
    mode: 'linear', count_x: 2, pitch_x: 4, include_source: true, operation: 'add',
    direction_x: [1, 0, 0], direction_x_query: `@${SK}/${DIR}`,
    source_body: `@${BODY}`,
  },
}

function edgeQueriesOf(h: SharedHarness, spec: Record<string, unknown>): string[] {
  const result = h.run(spec)
  const body = h.body(result, BODY)
  return (body.edge_queries as string[]) ?? []
}

describe.skipIf(!oc || !solveBytes)('fillet corner-patch naming (real OCC + Rust solver)', () => {
  const h = new SharedHarness(oc!)

  beforeAll(() => {
    if (!oc || !solveBytes) throw new Error('unreachable: skipIf guards this')
    resetSketchSolver()
    setSketchSolver(solveBytes)
  })

  it('leaves no edge of a corner-filleted body without an identity', () => {
    // Fillet every outer rim of the fused pair, so the blends meet and OCC has
    // to grow the corner patch.
    const rims = edgeQueriesOf(h, { features: [sketch, extrude, array] })
      .filter((q) => q.endsWith(':edge') && q.includes(`${SK}/${OUTER}`))
    expect(rims.length).toBe(4)

    const spec = {
      features: [sketch, extrude, array, {
        id: FIL, kind: 'fillet', label: 'fillet 1', fillet: { radius: 0.4, edges: rims },
      }],
    }
    const result = h.run(spec)
    expect((h.res(result, FIL) as { status: string }).status).toBe('ok')

    const queries = (h.body(result, BODY).edge_queries as string[]) ?? []
    expect(queries.length).toBeGreaterThan(rims.length)

    // No edge may fall back to the body-wide `profile_queries` ancestry: that
    // string is the same for every unnamed edge, which is what made one pick
    // resolve to several edges.
    const nameless = queries.filter((q) => !q.includes('@u|'))
    expect(nameless).toEqual([])

    // ... and therefore every pick is unique.
    expect(new Set(queries).size).toBe(queries.length)
  })

  it('keeps inherited faces inherited when the result had to be healed', () => {
    // This corpus heals: the corner blend comes out of BRepFilletAPI invalid
    // (missing pcurves) and ShapeFix repairs it. ShapeFix re-makes every face
    // rather than editing in place, so reading the names and the BrepDiff off
    // the HEALED shape breaks the sub-shape identity that ties them to the
    // maker's Modified() history -- every inherited face then looks fresh, the
    // builder re-attributes the whole body's ancestry to this fillet, and the
    // picks stored against those faces are evicted. Faces have no geometry
    // fallback in edgeModifierDiff (only edges do), so nothing else catches it.
    const rims = edgeQueriesOf(h, { features: [sketch, extrude, array] })
      .filter((q) => q.endsWith(':edge') && q.includes(`${SK}/${OUTER}`))
    const result = h.run({
      features: [sketch, extrude, array, {
        id: FIL, kind: 'fillet', label: 'fillet 1', fillet: { radius: 0.4, edges: rims },
      }],
    })

    const state = result._build_state as unknown as {
      checkpoints: Record<string, { body_store_snapshot: Record<string, { brep_diff: { new_faces: unknown[]; inherited_faces: unknown[] } | null }> }>
    }
    const diff = state.checkpoints[FIL].body_store_snapshot[BODY].brep_diff
    expect(diff).not.toBeNull()
    // The flats, bores and bottoms predate the fillet and must stay inherited;
    // only the blend faces and their corner patch are new. Reading off the
    // healed shape collapsed this to 11 new / 1 inherited.
    expect(diff!.inherited_faces.length).toBeGreaterThan(1)
    expect(diff!.new_faces.length).toBeLessThan(
      diff!.new_faces.length + diff!.inherited_faces.length,
    )
  })

  it('names the corner patch the same way on a rebuild', () => {
    const rims = edgeQueriesOf(h, { features: [sketch, extrude, array] })
      .filter((q) => q.endsWith(':edge') && q.includes(`${SK}/${OUTER}`))
    const spec = {
      features: [sketch, extrude, array, {
        id: FIL, kind: 'fillet', label: 'fillet 1', fillet: { radius: 0.4, edges: rims },
      }],
    }
    // A neighbour-derived identity is only worth anything if it recomputes:
    // the corner patch has no producer slot of its own, so its UUID (and the
    // UUIDs of the edges around it) must come back byte-identical.
    expect(edgeQueriesOf(h, spec)).toEqual(edgeQueriesOf(h, spec))
  })
})
