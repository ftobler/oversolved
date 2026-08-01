// @vitest-environment node
//
// Gated real-OCC parity gate for the import_step leaf (features/importStep.ts +
// occ/stepIo.ts). Feeds the same base64 STEP box as
// the now-removed gen_importstep_fixture.py through solveImportStep at scale 1
// and scale 2, and asserts the result dict + imported body volume match Python.
// Exercises the emscripten-FS STEP read path (write/export is deferred to phase 3).
//
// Skips when opencascade.js is absent. The fixture is a frozen golden snapshot;
// its generator (gen_importstep_fixture.py) was deleted with the Python kernel
// in phase 4d.
//
// Also gates the multi-part split: a STEP holding several parts must land as one
// body per solid, both at the leaf and through a full build.

import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from '../occ/loadOcc'
import { DisposeScope } from '../occ/disposeScope'
import { HandleTable } from '../occ/handleTable'
import { volumeOf } from '../occ/booleans'
import { makeBoxAt } from '../occ/primitives'
import { makeTranslationTrsf } from '../occ/transforms'
import { stepShapeToBytes } from '../occ/stepIo'
import { SharedHarness } from '../occ/sharedHarness'
import { repoFromSnapshot } from '../builder'
import { readFileSync } from 'node:fs'
import { Repository } from '../query'
import { solveImportStep } from './importStep'
import type { Body } from '../types3d'
import type { OccModule, OccShape } from '../occ/occTypes'
import fixture from '../occ/__fixtures__/importStep.json'

const oc = await loadOcc()

type Case = { name: string; scale: number; feature_id: string; result: Record<string, unknown>; volume: number }
const fx = fixture as unknown as { file_data: string; cases: Case[] }

/** Bytes -> base64, the form `file_data` carries (no Buffer, this also runs in a Worker). */
function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

/**
 * A STEP file holding two disjoint boxes (volumes 1000 and 125), which is what a
 * multi-part STEP looks like once read back: a single compound of two solids.
 * Built here rather than checked in so the volumes stay readable in the asserts.
 */
function twoBoxStepB64(occ: OccModule): string {
  const scope = new DisposeScope()
  try {
    const big = makeBoxAt(occ, scope, [0, 0, 0], 10, 10, 10)
    const small = makeBoxAt(occ, scope, [30, 0, 0], 5, 5, 5)  // far apart, so nothing could fuse them
    const builder = scope.track(new occ.BRep_Builder())
    const compound = scope.track(new occ.TopoDS_Compound())
    builder.MakeCompound(compound)
    builder.Add(compound, big)
    builder.Add(compound, small)
    return bytesToBase64(stepShapeToBytes(occ, scope, compound))
  } finally {
    scope.dispose()
  }
}

describe.skipIf(!oc)('solveImportStep (real OCC)', () => {
  let occ: OccModule
  beforeAll(() => {
    if (!oc) throw new Error('unreachable: skipIf guards this')
    occ = oc
  })

  for (const c of fx.cases) {
    it(`${c.name}: result + imported volume match Python`, () => {
      const scope = new DisposeScope()
      const table = new HandleTable({ finalizerGuard: false })
      try {
        const bodyStore: Record<string, Body> = {}
        const result = solveImportStep(
          occ,
          scope,
          table,
          { id: c.feature_id, file_data: fx.file_data, scale: c.scale },
          new Repository(),
          bodyStore,
        )
        // The fixture predates `body_ids`; a one-solid file yields the single body it named.
        expect(result).toEqual({ ...c.result, body_ids: [c.result.body_id] })
        const body = bodyStore[c.result.body_id as string]
        expect(volumeOf(occ, scope, table.get<OccShape>(body.shape!))).toBeCloseTo(c.volume, 2)
      } finally {
        scope.dispose()
      }
    })
  }

  /**
   * A STEP file holding several parts arrives as one compound. Each solid in it
   * is one of our parts, so the import must land as one body per solid -- the
   * user sees N entries in the Parts list, not one welded blob.
   */
  it('splits a multi-solid STEP into one body per solid', () => {
    const scope = new DisposeScope()
    const table = new HandleTable({ finalizerGuard: false })
    try {
      const fileData = twoBoxStepB64(occ)
      const bodyStore: Record<string, Body> = {}
      const result = solveImportStep(
        occ,
        scope,
        table,
        { id: 'imp1', file_data: fileData },
        new Repository(),
        bodyStore,
      )

      expect(result.body_ids).toEqual(['body_imp1', 'body_imp1_1'])
      expect(result.body_id).toBe('body_imp1')
      expect(Object.keys(bodyStore)).toEqual(['body_imp1', 'body_imp1_1'])
      const volumes = result.body_ids
        .map(id => volumeOf(occ, scope, table.get<OccShape>(bodyStore[id].shape!)))
        .sort((a, b) => a - b)
      expect(volumes[0]).toBeCloseTo(125, 3)
      expect(volumes[1]).toBeCloseTo(1000, 3)
      for (const id of result.body_ids) {
        expect(bodyStore[id].imported).toBe(true)
        expect(bodyStore[id].created_by).toBe('imp1')
      }
    } finally {
      scope.dispose()
    }
  })

  it('scales every solid of a multi-solid STEP', () => {
    const scope = new DisposeScope()
    const table = new HandleTable({ finalizerGuard: false })
    try {
      const fileData = twoBoxStepB64(occ)
      const bodyStore: Record<string, Body> = {}
      const result = solveImportStep(
        occ,
        scope,
        table,
        { id: 'imp2', file_data: fileData, scale: 2 },
        new Repository(),
        bodyStore,
      )

      const volumes = result.body_ids
        .map(id => volumeOf(occ, scope, table.get<OccShape>(bodyStore[id].shape!)))
        .sort((x, y) => x - y)
      expect(volumes[0]).toBeCloseTo(125 * 8, 2)
      expect(volumes[1]).toBeCloseTo(1000 * 8, 2)
    } finally {
      scope.dispose()
    }
  })

  it("rejects missing file_data", () => {
    const scope = new DisposeScope()
    const table = new HandleTable({ finalizerGuard: false })
    try {
      expect(() =>
        solveImportStep(occ, scope, table, { id: 'x', file_data: '' }, new Repository(), {}),
      ).toThrow(/requires 'file_data'/)
    } finally {
      scope.dispose()
    }
  })
})

// The leaf tests above prove the body store splits; this proves the split
// survives the whole build, which is what fills the Parts list and the viewport.
describe.skipIf(!oc)('multi-part STEP through a full build', () => {
  it('renders one selectable body per part', () => {
    const occ = oc!
    const h = new SharedHarness(occ)
    const IMP = 'stepimp1'
    const r = h.run({
      features: [{ id: IMP, kind: 'import_step', file_data: twoBoxStepB64(occ), label: 'two_boxes.step' }],
    })

    expect(h.res(r, IMP).status).toBe('ok')
    const bodyIds = Object.keys(r.bodies as Record<string, unknown>)
    expect(bodyIds).toEqual([`body_${IMP}`, `body_${IMP}_1`])
    for (const bid of bodyIds) {
      const mesh = h.body(r, bid).mesh as { vertices?: unknown[]; faces?: unknown[] } | undefined
      expect(mesh?.faces?.length).toBeGreaterThan(0)
      // Each part must own its faces, or picking one would select the other.
      expect((h.body(r, bid).mesh as { face_queries?: string[] }).face_queries?.length).toBe(6)
    }
  }, 60000)
})

// ─── imported faces are individually selectable (imported-face-naming) ───
//
// The bug: with nothing symbolic to name an imported face by, `buildFaceQuery`
// collapsed to `@<feature>@<body>` -- the SAME string for every face of the body.
// Picking one matched all of them and the resolver threw AmbiguousQueryError
// ("Query matched 56 elements"). Faces are now named from the STEP file's own
// entity ids, so each one carries a distinct `@u|` token.

/** The checked-in fixture (7 faces, one cylindrical) as `file_data` base64. */
function holeStepB64(): string {
  const bytes = readFileSync(new URL('../occ/__fixtures__/double_with_hole.step', import.meta.url))
  let bin = ''
  for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b)
  return btoa(bin)
}

/** The `@u|<uuid>` token of a query string, or null when it carries none. */
function uuidToken(query: string): string | null {
  const m = /@u\|([A-Za-z0-9_]+)/.exec(query)
  return m ? m[1] : null
}

describe.skipIf(!oc)('imported face queries are individually selectable', () => {
  it('gives every face of an imported body its own query string', () => {
    const h = new SharedHarness(oc!)
    const IMP = 'stepimp2'
    const r = h.run({ features: [{ id: IMP, kind: 'import_step', file_data: holeStepB64() }] })

    expect(h.res(r, IMP).status).toBe('ok')
    const queries = (h.body(r, `body_${IMP}`).mesh as { face_queries?: string[] }).face_queries ?? []
    expect(queries.length).toBeGreaterThan(1)
    // Pre-change every entry here was the same string, and none was empty --
    // which is exactly why the failure was invisible until a pick was resolved.
    expect(new Set(queries).size).toBe(queries.length)
    for (const q of queries) expect(q).not.toBe('')
    for (const q of queries) expect(uuidToken(q), `no @u| token in ${q}`).not.toBeNull()
  }, 60000)

  it('resolves each face query to exactly that one face', () => {
    const h = new SharedHarness(oc!)
    const IMP = 'stepimp3'
    const r = h.run({ features: [{ id: IMP, kind: 'import_step', file_data: holeStepB64() }] })
    const bid = `body_${IMP}`
    const mesh = h.body(r, bid).mesh as { face_queries: string[]; face_data: { classifiers?: string[] }[] }

    const repo = repoFromSnapshot(
      (r._build_state.checkpoints[IMP] as unknown as { repo_snapshot: Record<string, unknown> }).repo_snapshot,
    )
    // An interior face carries no spatial classifier, so it is the one the old
    // naming could not separate; the bounding-box extremes were already
    // distinguishable and would carry this test on their own.
    const interior = mesh.face_data.filter((fd) => (fd.classifiers ?? []).length === 0)
    expect(interior.length).toBeGreaterThan(0)

    for (let i = 0; i < mesh.face_data.length; i++) {
      const hit = repo.query(mesh.face_queries[i], null, null, null) as { face_index?: number; body_id?: string } | null
      expect(hit, `face ${i} did not resolve`).not.toBeNull()
      expect(hit!.body_id).toBe(bid)
      expect(hit!.face_index).toBe(i)
    }
  }, 60000)

  it('mints the same face UUIDs on a rebuild and at a different scale', () => {
    const h = new SharedHarness(oc!)
    const file = holeStepB64()
    const tokensFor = (id: string, scale?: number): string[] => {
      const r = h.run({ features: [{ id, kind: 'import_step', file_data: file, ...(scale ? { scale } : {}) }] })
      const q = (h.body(r, `body_${id}`).mesh as { face_queries: string[] }).face_queries
      const tokens = q.map(uuidToken)
      // Without this the whole test passes vacuously on all-null token lists.
      expect(tokens.length).toBeGreaterThan(1)
      for (const t of tokens) expect(t).not.toBeNull()
      return tokens as string[]
    }
    // Same feature id twice: byte-identical queries, or a reload would lose picks.
    expect(tokensFor('imp')).toEqual(tokensFor('imp'))
    // The file's entity ids do not move when the geometry does, so scaling the
    // import must not renumber a single face.
    expect(new Set(tokensFor('imp', 3))).toEqual(new Set(tokensFor('imp')))
  }, 60000)

  it('separates two placements of the SAME part by body', () => {
    // A repeated instance shares its TShape, so the file gives both copies the
    // same face entities and both get the same face UUIDs. They stay pickable
    // apart because each solid becomes its own Body and the query carries
    // `@<bodyId>` next to the `@u|` token.
    const occ = oc!
    const scope = new DisposeScope()
    let file: string
    try {
      const builder = scope.track(new occ.BRep_Builder())
      const compound = scope.track(new occ.TopoDS_Compound())
      builder.MakeCompound(compound)
      const part = scope.track(makeBoxAt(occ, scope, [0, 0, 0], 10, 10, 10))
      const mover = scope.track(
        new occ.BRepBuilderAPI_Transform_2(part, makeTranslationTrsf(occ, scope, 40, 0, 0), false),
      )
      mover.Build()
      builder.Add(compound, part)
      builder.Add(compound, mover.Shape())
      file = bytesToBase64(stepShapeToBytes(occ, scope, compound))
    } finally {
      scope.dispose()
    }

    const h = new SharedHarness(occ)
    const IMP = 'stepimp5'
    const r = h.run({ features: [{ id: IMP, kind: 'import_step', file_data: file }] })
    const bodyIds = Object.keys(r.bodies as Record<string, unknown>)
    expect(bodyIds.length).toBe(2)

    const perBody = bodyIds.map((bid) => (h.body(r, bid).mesh as { face_queries: string[] }).face_queries)
    for (const queries of perBody) {
      expect(queries.length).toBe(6)
      for (const q of queries) expect(uuidToken(q)).not.toBeNull()
    }
    // The instances DO share their UUIDs -- that is what the file says -- but
    // no whole query may repeat, or a pick would hit both copies.
    expect(new Set(perBody[0].map(uuidToken))).toEqual(new Set(perBody[1].map(uuidToken)))
    expect(new Set([...perBody[0], ...perBody[1]]).size).toBe(12)
  }, 60000)

  it('keeps two parts of a multi-solid STEP in disjoint name sets', () => {
    const h = new SharedHarness(oc!)
    const IMP = 'stepimp4'
    const r = h.run({ features: [{ id: IMP, kind: 'import_step', file_data: twoBoxStepB64(oc!) }] })
    const bodyIds = Object.keys(r.bodies as Record<string, unknown>)
    expect(bodyIds.length).toBe(2)

    const seen = new Set<string>()
    for (const bid of bodyIds) {
      const queries = (h.body(r, bid).mesh as { face_queries: string[] }).face_queries
      expect(queries.length).toBe(6)
      for (const q of queries) {
        expect(uuidToken(q)).not.toBeNull()
        // A query shared across two bodies would let a pick on one part select
        // the other -- the split-sibling narrowing in `namesForSolid` is what
        // prevents it.
        expect(seen.has(q), `query shared across bodies: ${q}`).toBe(false)
        seen.add(q)
      }
    }
  }, 60000)
})
