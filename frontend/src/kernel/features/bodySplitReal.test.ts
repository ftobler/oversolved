// @vitest-environment node
//
// The gate for "one Body == one solid" (knowledgebase.agent.md, "Separated").
//
// The rule used to be hand-copied into six feature leaves and missing from five
// more, so a union of two disjoint bodies, an array with a pitch wider than the
// part, a mirror across a gap and a severing hole each produced ONE Parts-list
// row that was really N parts. Every leaf now routes through
// features/bodySplit.ts; these tests drive the leaves directly against real OCC
// and assert the body STORE, not just the ids a leaf happens to return.
//
// Skips when opencascade.js is absent.

import { describe, it, expect } from 'vitest'
import { loadOcc } from '../occ/loadOcc'
import { DisposeScope } from '../occ/disposeScope'
import { HandleTable } from '../occ/handleTable'
import { countSolids, volumeOf, booleanWithDiff } from '../occ/booleans'
import { makeBoxAt, readSolidVertices } from '../occ/primitives'
import { faceGh } from '../occ/lineageHash'
import { Repository } from '../query'
import { bareBody } from './shared'
import { solveBoolean } from './boolean'
import { solveArray } from './array'
import { solveMirror, solveTransform } from './transformMirror'
import { solveHole } from './hole'
import { applyBodyOperation } from './bodyOps'
import { registerSplitBodies, resplitBody, assertOneSolidPerBody, splitSolids } from './bodySplit'
import type { Body } from '../types3d'
import type { OccShape } from '../occ/occTypes'

// Nothing excludes a *Real suite from the default run: the CI frontend job
// installs no opencascade.js (only the parity job does), so an unguarded
// non-null assertion here turned every case into a null-deref. Assert non-null
// for the helpers below and gate every describe on `hasOcc`, as the other
// *Real suites do.
const loadedOcc = await loadOcc()
const hasOcc = loadedOcc !== null
const oc = loadedOcc!

interface Rig {
  scope: DisposeScope
  table: HandleTable
  store: Record<string, Body>
}

function rig(): Rig {
  return { scope: new DisposeScope(), table: new HandleTable({ finalizerGuard: false }), store: {} }
}

/** Seed a body holding one axis-aligned box. */
function seedBox(r: Rig, id: string, corner: [number, number, number], dx: number, dy = dx, dz = dx): Body {
  const b = bareBody(id, id.replace(/^body_/, ''))
  b.shape = r.table.register(makeBoxAt(oc, r.scope, corner, dx, dy, dz), b.created_by)
  r.store[id] = b
  return b
}

/** A compound of several shapes: what a multi-part body looks like from inside. */
function compoundOf(scope: DisposeScope, parts: OccShape[]): OccShape {
  const comp = scope.track(new oc.TopoDS_Compound())
  const bld = scope.track(new oc.BRep_Builder())
  bld.MakeCompound(comp)
  for (const p of parts) bld.Add(comp, p)
  return comp
}

function volumeOfBody(r: Rig, id: string): number {
  const b = r.store[id]
  return b?.shape ? volumeOf(oc, r.scope, r.table.get<OccShape>(b.shape)) : 0
}

/** Smallest X over a shape's vertices, a cheap "which half is this" probe. */
function minX(r: Rig, shape: OccShape): number {
  return Math.min(...readSolidVertices(oc, r.scope, shape).map((v) => v[0]))
}

/** Every body in the store holds exactly one solid, and there are `expected` of them. */
function expectOnePartEach(r: Rig, expected: number): void {
  expect(Object.keys(r.store)).toHaveLength(expected)
  const counts = Object.fromEntries(
    Object.entries(r.store).map(([id, b]) => [
      id, b.shape === null ? 0 : countSolids(oc, r.scope, r.table.get<OccShape>(b.shape)),
    ]),
  )
  expect(counts).toEqual(Object.fromEntries(Object.keys(r.store).map((id) => [id, 1])))
  expect(() => assertOneSolidPerBody(oc, r.scope, r.table, r.store)).not.toThrow()
}

describe.skipIf(!hasOcc)('bodySplit: the shared helper', () => {
  it('registerSplitBodies makes one body per solid', () => {
    const r = rig()
    const shape = compoundOf(r.scope, [
      makeBoxAt(oc, r.scope, [0, 0, 0], 10, 10, 10),
      makeBoxAt(oc, r.scope, [50, 0, 0], 2, 2, 2),
    ])
    expect(registerSplitBodies(oc, r.scope, r.table, r.store, shape, { id: 'body_x', createdBy: 'x' }))
      .toEqual(['body_x', 'body_x_1'])
    expectOnePartEach(r, 2)
    r.scope.dispose()
  })

  it('registerSplitBodies keeps a lone solid as one body under the base id', () => {
    const r = rig()
    expect(registerSplitBodies(
      oc, r.scope, r.table, r.store, makeBoxAt(oc, r.scope, [0, 0, 0], 3, 3, 3), { id: 'body_x', createdBy: 'x' }))
      .toEqual(['body_x'])
    expectOnePartEach(r, 1)
    r.scope.dispose()
  })

  it('a shell-only shape (no solid at all) still yields exactly one body', () => {
    // A surfaces-only STEP has nothing to split; dropping it would leave the
    // feature with no body id at all.
    const r = rig()
    const box = makeBoxAt(oc, r.scope, [0, 0, 0], 4, 4, 4)
    const E = oc.TopAbs_ShapeEnum
    const exp = r.scope.track(new oc.TopExp_Explorer_2(box, E.TopAbs_FACE, E.TopAbs_SHAPE))
    const face = r.scope.track(oc.TopoDS.Face_1(exp.Current()))
    expect(registerSplitBodies(oc, r.scope, r.table, r.store, face, { id: 'body_s', createdBy: 's' }))
      .toEqual(['body_s'])
    expect(Object.keys(r.store)).toEqual(['body_s'])
    expect(countSolids(oc, r.scope, r.table.get<OccShape>(r.store.body_s.shape!))).toBe(0)
    r.scope.dispose()
  })

  it('sibling ids skip ids the store already holds', () => {
    const r = rig()
    seedBox(r, 'body_x_1', [900, 0, 0], 1)  // squats on the id a split would want
    const shape = compoundOf(r.scope, [
      makeBoxAt(oc, r.scope, [0, 0, 0], 10, 10, 10),
      makeBoxAt(oc, r.scope, [50, 0, 0], 2, 2, 2),
    ])
    expect(registerSplitBodies(oc, r.scope, r.table, r.store, shape, { id: 'body_x', createdBy: 'x' }))
      .toEqual(['body_x', 'body_x_2'])
    expectOnePartEach(r, 3)
    r.scope.dispose()
  })

  it('repeated calls with the same base id produce one flat gap-free run', () => {
    // The array leaf registers instance after instance; an instance that itself
    // splits must not silently overwrite the next instance's id.
    const r = rig()
    const first = compoundOf(r.scope, [
      makeBoxAt(oc, r.scope, [0, 0, 0], 5, 5, 5),
      makeBoxAt(oc, r.scope, [30, 0, 0], 5, 5, 5),
    ])
    expect(registerSplitBodies(oc, r.scope, r.table, r.store, first, { id: 'body_a', createdBy: 'a' }))
      .toEqual(['body_a', 'body_a_1'])
    expect(registerSplitBodies(
      oc, r.scope, r.table, r.store, makeBoxAt(oc, r.scope, [60, 0, 0], 5, 5, 5), { id: 'body_a', createdBy: 'a' }))
      .toEqual(['body_a_2'])
    expectOnePartEach(r, 3)
    r.scope.dispose()
  })

  it('resplitBody keeps the original body object on the first sibling', () => {
    const r = rig()
    const body = seedBox(r, 'body_t', [0, 0, 0], 10)
    const newShape = compoundOf(r.scope, [
      makeBoxAt(oc, r.scope, [0, 0, 0], 10, 10, 10),
      makeBoxAt(oc, r.scope, [50, 0, 0], 2, 2, 2),
    ])
    expect(resplitBody(oc, r.scope, r.table, r.store, body, newShape, 'f1')).toEqual(['body_t', 'body_t_1'])
    expect(r.store.body_t).toBe(body)  // identity preserved, not replaced
    expectOnePartEach(r, 2)
    r.scope.dispose()
  })

  it('resplitBody hands siblings the creator, sketch, profiles and imported flag', () => {
    const r = rig()
    const body = seedBox(r, 'body_t', [0, 0, 0], 10)
    body.sketch_id = 'sk9'
    body.imported = true
    body.profile_queries = ['@sk9/r1']
    const newShape = compoundOf(r.scope, [
      makeBoxAt(oc, r.scope, [0, 0, 0], 10, 10, 10),
      makeBoxAt(oc, r.scope, [50, 0, 0], 2, 2, 2),
    ])
    resplitBody(oc, r.scope, r.table, r.store, body, newShape, 'f1')
    const sib = r.store.body_t_1
    expect(sib.created_by).toBe(body.created_by)
    expect(sib.sketch_id).toBe('sk9')
    expect(sib.imported).toBe(true)
    expect(sib.profile_queries).toEqual(['@sk9/r1'])
    r.scope.dispose()
  })

  it('a split sibling carries the same modified_by history as the body it broke off', () => {
    // An empty history would read as "untouched since created_by", and
    // reuseCleanImportedBodyMeshes (builder.ts) would then serve a sibling of an
    // imported body last solve's mesh while the splitting feature is dirty.
    const r = rig()
    const body = seedBox(r, 'body_t', [0, 0, 0], 10)
    body.imported = true
    body.modified_by = ['fillet1']
    const newShape = compoundOf(r.scope, [
      makeBoxAt(oc, r.scope, [0, 0, 0], 10, 10, 10),
      makeBoxAt(oc, r.scope, [50, 0, 0], 2, 2, 2),
    ])
    resplitBody(oc, r.scope, r.table, r.store, body, newShape, 'cut1')
    expect(r.store.body_t_1.modified_by).toEqual(['fillet1', 'cut1'])
    expect(r.store.body_t_1.brep_diff).toBeNull()  // the diff describes the whole pre-split shape
    r.scope.dispose()
  })

  it('a caller that already pushed the feature id does not get it twice', () => {
    // The leaves disagree on whether they push before or after resplitBody
    // (array/boolean/bodyOps push first, mirror/hole/fillet push after), so the
    // helper takes the id explicitly and tolerates both orders.
    const r = rig()
    const body = seedBox(r, 'body_t', [0, 0, 0], 10)
    body.modified_by = ['cut1']  // caller pushed before calling
    const newShape = compoundOf(r.scope, [
      makeBoxAt(oc, r.scope, [0, 0, 0], 10, 10, 10),
      makeBoxAt(oc, r.scope, [50, 0, 0], 2, 2, 2),
    ])
    resplitBody(oc, r.scope, r.table, r.store, body, newShape, 'cut1')
    expect(r.store.body_t_1.modified_by).toEqual(['cut1'])
    r.scope.dispose()
  })

  it('split siblings each get the construction names of their OWN faces', () => {
    // Before the shared helper the sibling got no names at all and the first
    // body kept names for faces it no longer owned, so picks on either half
    // fell through to the ancestral path.
    const r = rig()
    const body = seedBox(r, 'body_t', [0, 0, 0], 10)
    const newShape = compoundOf(r.scope, [
      makeBoxAt(oc, r.scope, [0, 0, 0], 10, 10, 10),
      makeBoxAt(oc, r.scope, [50, 0, 0], 2, 2, 2),
    ])

    const E = oc.TopAbs_ShapeEnum
    const faceNames: Record<string, string> = {}
    const faceAncestry: Record<string, string[]> = {}
    const exp = r.scope.track(new oc.TopExp_Explorer_2(newShape, E.TopAbs_FACE, E.TopAbs_SHAPE))
    let n = 0
    for (; exp.More(); exp.Next()) {
      const gh = faceGh(oc, r.scope, r.scope.track(oc.TopoDS.Face_1(exp.Current())))
      const uuid = `@u|f${n++}`
      faceNames[gh] = uuid
      faceAncestry[uuid] = ['@body_t']
    }
    expect(n).toBe(12)  // two boxes, six faces each
    body.face_names = faceNames
    body.face_ancestry = faceAncestry

    resplitBody(oc, r.scope, r.table, r.store, body, newShape, 'f1')
    const a = Object.keys(r.store.body_t.face_names ?? {})
    const b = Object.keys(r.store.body_t_1.face_names ?? {})
    expect(a).toHaveLength(6)
    expect(b).toHaveLength(6)
    for (const k of a) expect(b).not.toContain(k)  // no face claimed by both
    expect(Object.keys(r.store.body_t.face_ancestry ?? {})).toHaveLength(6)
    expect(Object.keys(r.store.body_t_1.face_ancestry ?? {})).toHaveLength(6)
    r.scope.dispose()
  })

  it('splitSolids orders siblings by relative position, not OCC walk order', () => {
    const r = rig()
    // Compound built +X first on purpose: explore order would put it first.
    const shape = compoundOf(r.scope, [
      makeBoxAt(oc, r.scope, [50, 0, 0], 4, 4, 4),
      makeBoxAt(oc, r.scope, [0, 0, 0], 4, 4, 4),
    ])
    const solids = splitSolids(oc, r.scope, shape)
    expect(solids).toHaveLength(2)
    expect(minX(r, solids[0])).toBeLessThan(minX(r, solids[1]))
    r.scope.dispose()
  })

  it('sibling order is stable, so _1 denotes the same half across a rebuild', () => {
    // The identity point. With raw TopExp order `_1` means "whatever OCC
    // enumerated second"; ordered by relative centroid it means the +X half
    // whether the cut sits at x=40 or x=60. doc.part_style keys a part's name
    // and colour on that id, so this is what stops a rebuild swapping them.
    const measured: { base: number; sib: number }[] = []
    for (const cutAt of [40, 60]) {
      const r = rig()
      const bar = bareBody('body_bar', 'bar')
      bar.shape = r.table.register(makeBoxAt(oc, r.scope, [0, 0, 0], 100, 5, 5), 'bar')
      r.store.body_bar = bar
      seedBox(r, 'body_tool', [cutAt, -1, -1], 10, 7, 7)
      solveBoolean(oc, r.scope, r.table, {
        id: 'sub1', boolean: { operation: 'subtract', target: '@body_bar', tools: ['@body_tool'] },
      }, new Repository(), r.store)
      expectOnePartEach(r, 2)
      measured.push({ base: volumeOfBody(r, 'body_bar'), sib: volumeOfBody(r, 'body_bar_1') })
      r.scope.dispose()
    }
    // Cut at 40 -> halves 1000 / 1250; cut at 60 -> 1500 / 750. The base id
    // holds the -X half in both, so moving the cut right grows it and shrinks
    // the sibling. If the order came from OCC these would not track.
    expect(measured[0].base).toBeCloseTo(1000, 6)
    expect(measured[0].sib).toBeCloseTo(1250, 6)
    expect(measured[1].base).toBeCloseTo(1500, 6)
    expect(measured[1].sib).toBeCloseTo(750, 6)
  })

  it('assertOneSolidPerBody catches a body that holds two solids', () => {
    const r = rig()
    const b = bareBody('body_bad', 'bad')
    b.shape = r.table.register(compoundOf(r.scope, [
      makeBoxAt(oc, r.scope, [0, 0, 0], 3, 3, 3),
      makeBoxAt(oc, r.scope, [30, 0, 0], 3, 3, 3),
    ]), 'bad')
    r.store.body_bad = b
    expect(() => assertOneSolidPerBody(oc, r.scope, r.table, r.store)).toThrow(/body_bad \(2 solids\)/)
    r.scope.dispose()
  })
})

describe.skipIf(!hasOcc)('bodySplit: the leaves that used to leak', () => {
  it('boolean union of two DISJOINT bodies makes two parts, not one', () => {
    const r = rig()
    seedBox(r, 'body_a', [0, 0, 0], 10)
    seedBox(r, 'body_b', [50, 0, 0], 10)
    const res = solveBoolean(oc, r.scope, r.table, {
      id: 'bool1', boolean: { operation: 'union', target: '@body_a', tools: ['@body_b'] },
    }, new Repository(), r.store)
    // The tool body is consumed, then the union splits back into two parts.
    expect(res.body_ids).toEqual(['body_a', 'body_a_1'])
    expectOnePartEach(r, 2)
    r.scope.dispose()
  })

  it('boolean union of two TOUCHING bodies stays one part', () => {
    const r = rig()
    seedBox(r, 'body_a', [0, 0, 0], 10)
    seedBox(r, 'body_b', [5, 0, 0], 10)
    const res = solveBoolean(oc, r.scope, r.table, {
      id: 'bool1', boolean: { operation: 'union', target: '@body_a', tools: ['@body_b'] },
    }, new Repository(), r.store)
    expect(res.body_ids).toEqual(['body_a'])
    expectOnePartEach(r, 1)
    r.scope.dispose()
  })

  it('boolean intersect leaving two lumps makes two parts', () => {
    const r = rig()
    const bar = bareBody('body_bar', 'bar')
    bar.shape = r.table.register(makeBoxAt(oc, r.scope, [0, 0, 0], 100, 5, 5), 'bar')
    r.store.body_bar = bar
    const tool = bareBody('body_tool', 'tool')
    tool.shape = r.table.register(compoundOf(r.scope, [
      makeBoxAt(oc, r.scope, [0, 0, 0], 10, 5, 5),
      makeBoxAt(oc, r.scope, [50, 0, 0], 10, 5, 5),
    ]), 'tool')
    r.store.body_tool = tool
    const res = solveBoolean(oc, r.scope, r.table, {
      id: 'bool2', boolean: { operation: 'intersect', target: '@body_bar', tools: ['@body_tool'] },
    }, new Repository(), r.store)
    expect(res.body_ids).toEqual(['body_bar', 'body_bar_1'])
    expectOnePartEach(r, 2)
    r.scope.dispose()
  })

  it('boolean subtract that severs the target still makes two parts', () => {
    const r = rig()
    const bar = bareBody('body_bar', 'bar')
    bar.shape = r.table.register(makeBoxAt(oc, r.scope, [0, 0, 0], 100, 5, 5), 'bar')
    r.store.body_bar = bar
    seedBox(r, 'body_tool', [40, -1, -1], 10, 7, 7)
    const res = solveBoolean(oc, r.scope, r.table, {
      id: 'sub1', boolean: { operation: 'subtract', target: '@body_bar', tools: ['@body_tool'] },
    }, new Repository(), r.store)
    expect(res.body_ids).toEqual(['body_bar', 'body_bar_1'])
    expectOnePartEach(r, 2)
    r.scope.dispose()
  })

  it('array add with a pitch wider than the part makes one part per instance', () => {
    const r = rig()
    seedBox(r, 'body_src', [0, 0, 0], 10)
    const repo = new Repository()
    repo.elements.set('dx', { start: [0, 0, 0], end: [1, 0, 0] })
    const res = solveArray(oc, r.scope, r.table, {
      id: 'arr1',
      array: {
        source_body: '@body_src', mode: 'linear', operation: 'add',
        include_source: true, count_x: 3, pitch_x: 50, direction_x_query: '@dx',
      },
    }, repo, r.store)
    expect(res.body_ids).toEqual(['body_src', 'body_src_1', 'body_src_2'])
    expectOnePartEach(r, 3)
    r.scope.dispose()
  })

  it('array add with an OVERLAPPING pitch still fuses into one part', () => {
    const r = rig()
    seedBox(r, 'body_src', [0, 0, 0], 10)
    const repo = new Repository()
    repo.elements.set('dx', { start: [0, 0, 0], end: [1, 0, 0] })
    const res = solveArray(oc, r.scope, r.table, {
      id: 'arr1',
      array: {
        source_body: '@body_src', mode: 'linear', operation: 'add',
        include_source: true, count_x: 3, pitch_x: 5, direction_x_query: '@dx',
      },
    }, repo, r.store)
    expect(res.body_ids).toEqual(['body_src'])
    expectOnePartEach(r, 1)
    r.scope.dispose()
  })

  it('array new spawns one part per instance', () => {
    const r = rig()
    seedBox(r, 'body_src', [0, 0, 0], 10)
    const repo = new Repository()
    repo.elements.set('dx', { start: [0, 0, 0], end: [1, 0, 0] })
    const res = solveArray(oc, r.scope, r.table, {
      id: 'arr1',
      array: {
        source_body: '@body_src', mode: 'linear', operation: 'new',
        include_source: true, count_x: 3, pitch_x: 50, direction_x_query: '@dx',
      },
    }, repo, r.store)
    expect(res.body_ids).toEqual(['body_arr1', 'body_arr1_1', 'body_arr1_2'])
    expectOnePartEach(r, 4)  // the source body survives alongside the instances
    r.scope.dispose()
  })

  it('mirror merge across a gap makes two parts', () => {
    const r = rig()
    seedBox(r, 'body_src', [20, 0, 0], 10)
    const repo = new Repository()
    repo.elements.set('mp', { origin: [0, 0, 0], normal: [1, 0, 0], x_axis: [0, 1, 0] })
    const res = solveMirror(oc, r.scope, r.table, {
      id: 'mir1', mirror: { body: '@body_src', plane: '@mp', keep_original: true, merge: true },
    }, repo, r.store)
    expect(res.body_ids).toEqual(['body_src', 'body_src_1'])
    expectOnePartEach(r, 2)
    r.scope.dispose()
  })

  it('mirror merge of a body touching the plane stays one part', () => {
    const r = rig()
    seedBox(r, 'body_src', [0, 0, 0], 10)
    const repo = new Repository()
    repo.elements.set('mp', { origin: [0, 0, 0], normal: [1, 0, 0], x_axis: [0, 1, 0] })
    const res = solveMirror(oc, r.scope, r.table, {
      id: 'mir1', mirror: { body: '@body_src', plane: '@mp', keep_original: true, merge: true },
    }, repo, r.store)
    expect(res.body_ids).toEqual(['body_src'])
    expectOnePartEach(r, 1)
    r.scope.dispose()
  })

  it('bodyOps cut that severs a body makes two parts', () => {
    const r = rig()
    const bar = bareBody('body_bar', 'bar')
    bar.shape = r.table.register(makeBoxAt(oc, r.scope, [0, 0, 0], 100, 5, 5), 'bar')
    r.store.body_bar = bar
    const res = applyBodyOperation(oc, r.scope, r.table, {
      toolShape: makeBoxAt(oc, r.scope, [40, -1, -1], 10, 7, 7),
      bodyStore: r.store, operation: 'cut', mergeTarget: null,
      bodyId: 'body_c1', featureId: 'c1', sketchId: '', opName: 'cut',
    })
    expect(res.body_ids).toEqual(['body_bar', 'body_bar_1'])
    expectOnePartEach(r, 2)
    r.scope.dispose()
  })

  it('bodyOps new on a two-solid tool makes two parts carrying the sketch id', () => {
    const r = rig()
    const tool = compoundOf(r.scope, [
      makeBoxAt(oc, r.scope, [0, 0, 0], 5, 5, 5),
      makeBoxAt(oc, r.scope, [40, 0, 0], 5, 5, 5),
    ])
    const res = applyBodyOperation(oc, r.scope, r.table, {
      toolShape: tool, bodyStore: r.store, operation: 'new', mergeTarget: null,
      bodyId: 'body_n1', featureId: 'n1', sketchId: 'sk1', opName: 'extrude',
    })
    expect(res.body_ids).toEqual(['body_n1', 'body_n1_1'])
    expectOnePartEach(r, 2)
    expect(r.store.body_n1_1.sketch_id).toBe('sk1')
    r.scope.dispose()
  })

  it('transform to a new body keeps one part', () => {
    const r = rig()
    seedBox(r, 'body_src', [0, 0, 0], 10)
    const res = solveTransform(oc, r.scope, r.table, {
      id: 'tr1', transform: { bodies: ['@body_src'], operation: 'new', translation: [40, 0, 0] },
    }, new Repository(), r.store)
    expect(res.body_ids).toEqual(['body_tr1'])
    expectOnePartEach(r, 2)
    r.scope.dispose()
  })
})

describe.skipIf(!hasOcc)('bodySplit: a hole can sever a body too', () => {
  // A repo carrying one sketch plane at `origin` with a single point at its centre.
  function holeRepo(origin: number[]): Repository {
    const repo = new Repository()
    repo.elements.set('_pt_sk1', { origin, x_axis: [1, 0, 0], y_axis: [0, 1, 0], normal: [0, 0, 1] })
    repo.elements.set('sk1/p1/xy', { external_xy: [0, 0] })
    return repo
  }
  const sketchFeature = { sk1: { id: 'sk1', entities: [{ id: 'p1', kind: 'point' }] } }

  it('a through-hole that eats the connecting web splits the bar into two parts', () => {
    const r = rig()
    // Two prongs joined by a thin web, fused into ONE solid to start with.
    let shape = makeBoxAt(oc, r.scope, [0, 0, 0], 10, 10, 10)
    for (const part of [
      makeBoxAt(oc, r.scope, [30, 0, 0], 10, 10, 10),
      makeBoxAt(oc, r.scope, [10, 0, 0], 20, 10, 2),
    ]) {
      shape = r.scope.track(booleanWithDiff(oc, r.scope, shape, part, 'fuse').shape)
    }
    const body = bareBody('body_bar', 'bar')
    body.shape = r.table.register(r.scope.detach(shape), 'bar')
    r.store.body_bar = body
    expect(countSolids(oc, r.scope, r.table.get<OccShape>(body.shape))).toBe(1)

    // A hole wide enough to remove the whole web, drilled through Z.
    const res = solveHole(oc, r.scope, r.table, {
      id: 'h1',
      hole: { sketch: '@sk1', diameter: 26, depth_mode: 'through_all', target: '@body_bar' },
    }, holeRepo([20, 5, 0]), r.store, sketchFeature)
    expect(res.body_ids).toEqual(['body_bar', 'body_bar_1'])
    expectOnePartEach(r, 2)
    r.scope.dispose()
  })

  it('a blind hole that does not sever keeps one part', () => {
    const r = rig()
    seedBox(r, 'body_b', [0, 0, 0], 20)
    const res = solveHole(oc, r.scope, r.table, {
      id: 'h1', hole: { sketch: '@sk1', diameter: 4, depth_mode: 'blind', depth: 5, target: '@body_b' },
    }, holeRepo([10, 10, 0]), r.store, sketchFeature)
    expect(res.body_ids).toEqual(['body_b'])
    expectOnePartEach(r, 1)
    r.scope.dispose()
  })
})

describe.skipIf(!hasOcc)('bodySplit: the invariant holds across successive splits', () => {
  it('cutting a body, then cutting its sibling, never collides on ids', () => {
    const r = rig()
    const bar = bareBody('body_bar', 'bar')
    bar.shape = r.table.register(makeBoxAt(oc, r.scope, [0, 0, 0], 100, 5, 5), 'bar')
    r.store.body_bar = bar
    seedBox(r, 'body_t1', [30, -1, -1], 5, 7, 7)
    solveBoolean(oc, r.scope, r.table, {
      id: 's1', boolean: { operation: 'subtract', target: '@body_bar', tools: ['@body_t1'] },
    }, new Repository(), r.store)
    expectOnePartEach(r, 2)

    seedBox(r, 'body_t2', [60, -1, -1], 5, 7, 7)
    const res = solveBoolean(oc, r.scope, r.table, {
      id: 's2', boolean: { operation: 'subtract', target: '@body_bar_1', tools: ['@body_t2'] },
    }, new Repository(), r.store)
    expect(res.body_ids).toEqual(['body_bar_1', 'body_bar_1_1'])
    expectOnePartEach(r, 3)
    r.scope.dispose()
  })
})
