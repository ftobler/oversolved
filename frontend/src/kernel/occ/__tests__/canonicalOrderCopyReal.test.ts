// @vitest-environment node
//
// Spike for feature/query-uuid-handoff.md step 1: is a body's canonical
// sub-shape order (TopExp_Explorer order, deduped by IsSame) preserved by the
// two shape copies the build pipeline makes between a producer and a consumer?
//
//   1. `copyShape` (BRepBuilderAPI_Copy, copyGeom=true), called directly.
//   2. Checkpoint restore: an incremental build whose dirty tail starts after
//      the body was made, so the body reaches the final store as the
//      `copyBodyShape` restore copy rather than the shape its producer built.
//
// "Preserved" is checked two independent ways per index, so a geometric tie
// between two elements cannot hide a swap:
//   - geometry: face centroid + normal + orientation, edge midpoint, vertex point;
//   - topology: each face's bounding edge indices and each edge's vertex
//     indices, expressed in the canonical order of the same shape.
// Each copy is also checked to share no TShape with its source, so the
// comparison is between two real shapes and not one shape read twice.
//
// Skips when opencascade.js or the Rust solver is absent.

import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from '../loadOcc'
import { SharedHarness } from '../sharedHarness'
import { DisposeScope } from '../disposeScope'
import { copyShape } from '../transforms'
import { faceCentroid, faceNormal } from '../primitives'
import { edgeMidpoint } from '../constructionLineage'
import { SubShapeDedup, SubShapeIndexMap } from '../subshapeIdentity'
import { base64ToBytes } from '../stepIo'
import { setSketchSolver, resetSketchSolver } from '../../features/sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import type { BuildResponse } from '../../builder'
import type { Body } from '../../types3d'
import type { OccModule, OccOrientedShape, OccShape, OccSubShape } from '../occTypes'
import corpus from '../__fixtures__/pickIdentityCorpus.json'
import importFixture from '../__fixtures__/importStep.json'

const oc = await loadOcc()
const solveBytes = loadSolver()
const importFiles = new Map<string, Uint8Array>([
  ['imp1', base64ToBytes((importFixture as unknown as { file_data: string }).file_data)],
])

type Spec = { features: Array<Record<string, unknown>> }
type Kind = 'FACE' | 'EDGE' | 'VERTEX'

// ─── Canonical order and its signature ───

/** Unique sub-shapes of `kind` in TopExp_Explorer order: the proposed canonical order. */
function canonical(occ: OccModule, scope: DisposeScope, shape: OccShape, kind: Kind): OccSubShape[] {
  const E = occ.TopAbs_ShapeEnum
  const exp = scope.track(new occ.TopExp_Explorer_2(shape, E[`TopAbs_${kind}`], E.TopAbs_SHAPE))
  // The typed downcast the face/edge/vertex readers' embind signatures require.
  const cast = { FACE: occ.TopoDS.Face_1, EDGE: occ.TopoDS.Edge_1, VERTEX: occ.TopoDS.Vertex_1 }[kind]
  const dedup = new SubShapeDedup()
  const out: OccSubShape[] = []
  for (; exp.More(); exp.Next()) {
    const s = scope.track(cast(scope.track(exp.Current()))) as OccSubShape
    if (dedup.add(s)) out.push(s)
  }
  return out
}

function indexOf(list: OccSubShape[]): SubShapeIndexMap {
  const map = new SubShapeIndexMap()
  list.forEach((s, i) => map.set(s, i))
  return map
}

/** Indices (in `index`) of the unique `kind` sub-shapes under `parent`, in explorer order. */
function childIndices(occ: OccModule, scope: DisposeScope, parent: OccShape, kind: Kind, index: SubShapeIndexMap): number[] {
  return canonical(occ, scope, parent, kind).map((c) => index.get(c))
}

const r6 = (v: number): number => Math.round(v * 1e6) / 1e6 + 0  // + 0 folds -0
const vec = (v: ArrayLike<number>): string => Array.from(v, r6).join(',')

/** Per-index signature of a shape's canonical order, plus its sub-shape lists. */
function signature(occ: OccModule, scope: DisposeScope, shape: OccShape) {
  const faces = canonical(occ, scope, shape, 'FACE')
  const edges = canonical(occ, scope, shape, 'EDGE')
  const vertices = canonical(occ, scope, shape, 'VERTEX')
  const edgeIdx = indexOf(edges)
  const vertexIdx = indexOf(vertices)
  return {
    faces, edges, vertices,
    face: faces.map((f) => [
      vec(faceCentroid(occ, scope, f)),
      vec(faceNormal(occ, scope, f)),
      String((f as unknown as OccOrientedShape).Orientation_1().value),
      childIndices(occ, scope, f, 'EDGE', edgeIdx).join(' '),
    ].join(' | ')),
    edge: edges.map((e) => [
      vec(edgeMidpoint(occ, scope, e)),
      childIndices(occ, scope, e, 'VERTEX', vertexIdx).join(' '),
    ].join(' | ')),
    vertex: vertices.map((v) => {
      const p = occ.BRep_Tool.Pnt(v)
      const s = vec([p.X(), p.Y(), p.Z()])
      p.delete()
      return s
    }),
  }
}

type Sig = ReturnType<typeof signature>

function expectSameOrder(a: Sig, b: Sig, label: string): void {
  expect(b.face, `${label}: faces`).toEqual(a.face)
  expect(b.edge, `${label}: edges`).toEqual(a.edge)
  expect(b.vertex, `${label}: vertices`).toEqual(a.vertex)
  // Not vacuous: a real solid, and the two signatures come from distinct TShapes.
  expect(a.face.length, `${label}: has faces`).toBeGreaterThan(0)
  for (const kind of ['faces', 'edges', 'vertices'] as const) {
    a[kind].forEach((s, i) => expect(s.IsPartner(b[kind][i]), `${label}: ${kind}[${i}] shares its TShape`).toBe(false))
  }
}

// ─── Fixtures ───

function rectSketch(sketchId: string, w: number, h: number, ox = 0, oy = 0) {
  return {
    id: sketchId, kind: 'sketch' as const, label: 'Rectangle', plane: '@builtin_plane_front',
    entities: [
      { id: 'bottom', kind: 'line' as const }, { id: 'right', kind: 'line' as const },
      { id: 'top', kind: 'line' as const }, { id: 'left', kind: 'line' as const },
    ],
    initial: {
      bottom: [ox, oy, ox + w, oy], right: [ox + w, oy, ox + w, oy + h],
      top: [ox + w, oy + h, ox, oy + h], left: [ox, oy + h, ox, oy],
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

function circleSketch(sketchId: string, diameter: number) {
  return {
    id: sketchId, kind: 'sketch' as const, label: 'Circle', plane: '@builtin_plane_front',
    entities: [{ id: 'c1', kind: 'circle' as const }],
    initial: { c1: [0, 0, diameter / 2] },
    constraints: [
      { id: 'co1', kind: 'coincident' as const, a: `$${sketchId}c1center`, b: '@builtin_origin' },
      { id: 'd1', kind: 'diameter' as const, target: `$${sketchId}c1`, value: diameter },
    ],
  }
}

const CORPUS_BODY = 'body_e1tMr2u-m4rxTxhoZSw2z05E'

// Each case: a spec, the body to check, and the build files it needs. The
// filleted box picks its edge from a first build, so it is a function of the harness.
const CASES: Array<{ name: string; body: string; spec: (h: SharedHarness) => Spec; files?: ReadonlyMap<string, Uint8Array> }> = [
  { name: 'box', body: 'body_ex1', spec: () => ({ features: [
    rectSketch('sk1', 10, 10),
    { id: 'ex1', kind: 'extrude', sketch: '$sk1', distance: 5, direction: 'normal', operation: 'new' },
  ] }) },
  { name: 'cylinder (seam edge)', body: 'body_ex1', spec: () => ({ features: [
    circleSketch('sk1', 10),
    { id: 'ex1', kind: 'extrude', sketch: '$sk1', distance: 8, direction: 'normal', operation: 'new' },
  ] }) },
  { name: 'filleted box', body: 'body_ex1', spec: (h) => {
    const base: Spec = { features: [
      rectSketch('sk1', 10, 10),
      { id: 'ex1', kind: 'extrude', sketch: '$sk1', distance: 5, direction: 'normal', operation: 'new' },
    ] }
    const edges = h.body(h.run(base), 'body_ex1').edge_queries as string[]
    return { features: [...base.features, { id: 'fillet1', kind: 'fillet', edges: [edges[0], edges[3]], radius: 1 }] }
  } },
  { name: 'boolean cut (through pocket)', body: 'body_ex1', spec: () => ({ features: [
    rectSketch('sk1', 10, 10),
    { id: 'ex1', kind: 'extrude', sketch: '$sk1', distance: 10, direction: 'normal', operation: 'add' },
    rectSketch('sk2', 4, 4, 3, 3),
    { id: 'ex2', kind: 'extrude', sketch: '$sk2', distance: 12, direction: 'normal', operation: 'cut' },
  ] }) },
  // extrude -> linear array -> fillet -> transform -> circular array -> up_to extrude -> 3-tool union
  { name: 'pick identity corpus', body: CORPUS_BODY, spec: () => structuredClone(corpus) as unknown as Spec },
  { name: 'imported STEP', body: 'body_imp1', files: importFiles, spec: () => ({ features: [
    { id: 'imp1', kind: 'import_step', file_id: 'imp1', scale: 1 },
  ] }) },
]

function finalBody(r: BuildResponse, bodyId: string): Body {
  const state = r._build_state!
  const body = state.checkpoints[state.feature_order[state.feature_order.length - 1]].body_store_snapshot[bodyId]
  expect(body?.shape, `${bodyId} has a shape`).not.toBeNull()
  return body
}

// Sketches report their constraint state and datums are not solved here; only
// the solid-producing features must be ok.
const NOT_SOLID = new Set(['sketch', 'origin', 'plane'])

function expectSolidsOk(h: SharedHarness, spec: Spec, r: BuildResponse): void {
  for (const f of spec.features) {
    if (NOT_SOLID.has(String(f.kind))) continue
    expect((h.res(r, String(f.id)) as { status?: string }).status, `feature ${String(f.id)}`).toBe('ok')
  }
}

// ─── The spike ───

// Each case runs whole solves through the real kernel in WASM, which takes
// longer than vitest's 5 s default on a loaded machine.
const REAL_OCC_TIMEOUT_MS = 60_000

describe.skipIf(!oc || !solveBytes)('canonical sub-shape order survives the pipeline copies (real OCC)', () => {
  const h = new SharedHarness(oc!)
  let occ: OccModule

  beforeAll(() => {
    if (!oc || !solveBytes) throw new Error('unreachable: skipIf guards this')
    occ = oc
    resetSketchSolver()
    setSketchSolver(solveBytes)
  })

  for (const c of CASES) {
    it(`${c.name}: copyShape, and a copy of that copy`, () => {
      const spec = c.spec(h)
      const r = h.run(spec, { files: c.files })
      expectSolidsOk(h, spec, r)
      const scope = new DisposeScope()
      try {
        const original = h.table.get<OccShape>(finalBody(r, c.body).shape!)
        const once = scope.track(copyShape(occ, scope, original))
        const twice = scope.track(copyShape(occ, scope, once))
        const sig0 = signature(occ, scope, original)
        expectSameOrder(sig0, signature(occ, scope, once), `${c.name} copy`)
        expectSameOrder(sig0, signature(occ, scope, twice), `${c.name} copy of copy`)
      } finally {
        scope.dispose()
      }
    }, REAL_OCC_TIMEOUT_MS)

    it(`${c.name}: checkpoint restore of a clean prefix`, () => {
      const spec = c.spec(h)
      const r1 = h.run(spec, { files: c.files })
      expectSolidsOk(h, spec, r1)
      // A trailing sketch dirties only itself, so the body is restored from the
      // previous checkpoint through `copyBodyShape` and left untouched after.
      const tail: Spec = { features: [...spec.features, rectSketch('skTail', 1, 1, 50, 50)] }
      const r2 = h.run(tail, { files: c.files, prevState: r1._build_state })
      expectSolidsOk(h, tail, r2)
      const scope = new DisposeScope()
      try {
        const built = h.table.get<OccShape>(finalBody(r1, c.body).shape!)
        const restored = h.table.get<OccShape>(finalBody(r2, c.body).shape!)
        expectSameOrder(signature(occ, scope, built), signature(occ, scope, restored), `${c.name} restore`)
      } finally {
        scope.dispose()
      }
    }, REAL_OCC_TIMEOUT_MS)
  }
})
