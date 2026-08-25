// @vitest-environment node
//
// Corpus regression for bugreports/pick_identity_20260728_215425.md (and its
// first capture, edge_resolves_not_unique_20260728_213049.md): "fillet 2 has one
// edge pick but 6 faces highlight and fillet 2 fails".
//
// The AST is the user's document verbatim (`__fixtures__/pickIdentityCorpus.json`,
// minus the trailing fillet whose stored pick is the broken query itself --
// this test re-picks instead, which is what the user has to do once). It runs
// extrude -> linear array -> fillet -> transform -> circular array -> sketch on a
// body face -> up_to extrude -> 3-tool boolean union, and every one of those
// stages had to keep its construction names for the last pick to be unique.
//
// What it caught: `features/boolean.ts` never transferred construction names.
// The target body kept its pre-boolean `face_names`, keyed by geom hashes the
// fuse had just invalidated, so 25 of 34 faces and 74 of 96 edges came out of
// the union with no UUID -- and an unnamed edge falls back to
// `createdBy + bodyId + profile_queries`, one string shared by all 74. Six of
// them collided exactly, which is the six the user saw highlight.
//
// Skips when OCC.js or the Rust solver is absent.

import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from '../occ/loadOcc'
import { SharedHarness } from '../occ/sharedHarness'
import { setSketchSolver, resetSketchSolver } from './sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import corpus from '../occ/__fixtures__/pickIdentityCorpus.json'

const oc = await loadOcc()
const solveBytes = loadSolver()

const BODY = 'body_e1tMr2u-m4rxTxhoZSw2z05E'
const BOOLEAN = '4g6penAMAb__68YySKl9knDI'
// The last feature of the corpus that must produce geometry, in AST order.
const SOLID_FEATURES = [
  'e1tMr2u-m4rxTxhoZSw2z05E',  // extrude 1 (the annular tube)
  'hJObESEbHbHJlpZ85sqcIiMg',  // array 2 (linear, fused)
  '2TRh0KUD0ppl01_k4juB-jLF',  // fillet 2 (r=2 on six edges)
  'mK4MMFH6t71ShoRjdd-Hyfkr',  // transform 2
  'duA-45um74zsKKrINmVjYt67',  // circular_array 2 (4 instances)
  'lYuuhb-HO3FIEl_8kHN8a-Hg',  // extrude 2 (up_to, from a sketch on a body face)
  BOOLEAN,                     // boolean 5 (union, three tools)
]

const spec = (): Record<string, unknown> => structuredClone(corpus) as Record<string, unknown>

describe.skipIf(!oc || !solveBytes)('pick identity corpus (real OCC + Rust solver)', () => {
  const h = new SharedHarness(oc!)

  beforeAll(() => {
    if (!oc || !solveBytes) throw new Error('unreachable: skipIf guards this')
    resetSketchSolver()
    setSketchSolver(solveBytes)
  })

  it('every pick on the fused body is one edge, not six', () => {
    const result = h.run(spec())
    for (const fid of SOLID_FEATURES) {
      expect(`${fid}: ${(h.res(result, fid) as { status: string }).status}`).toBe(`${fid}: ok`)
    }

    const body = h.body(result, BODY)
    const edges = (body.edge_queries as string[]) ?? []
    const faces = ((body.mesh as { face_queries?: string[] }).face_queries) ?? []
    expect(edges.length).toBeGreaterThan(0)
    expect(faces.length).toBeGreaterThan(0)

    // No primitive falls back to the body-wide `profile_queries` ancestry.
    expect([...edges, ...faces].filter((q) => !q.includes('@u|'))).toEqual([])
    // ... so no two primitives are one selectable thing.
    expect(new Set(edges).size).toBe(edges.length)
    expect(new Set(faces).size).toBe(faces.length)
  }, 60_000)

  it('a re-picked edge of the fused body fillets', () => {
    // Re-pick a straightedge on the up_to-face sketch's lineage: its
    // neighbours are planar, so OCC can blend it. Edges bordering the corpus's
    // own r=2 blends (the ArdV8SVWXjjg8-gP faces) genuinely refuse at the
    // kernel level with build_failed, which since the swallowed-failure fix
    // surfaces as a feature exception instead of a green ok that changed
    // nothing.
    const picked = ((h.body(h.run(spec()), BODY).edge_queries as string[]) ?? [])
      .filter((q) => q.endsWith(':straightedge') && q.includes('/pwfYD59xKWiSyQhm@'))
    expect(picked.length).toBeGreaterThan(0)

    const withFillet = spec()
    ;(withFillet.features as Array<Record<string, unknown>>).push({
      id: 'fil_repick', kind: 'fillet', label: 'fillet re-pick',
      fillet: { edges: [picked[0]], radius: 0.2 },
    })
    expect((h.res(h.run(withFillet), 'fil_repick') as { status: string }).status).toBe('ok')
  }, 60_000)
})
