// @vitest-environment node
//
// Gated real-OCC parity gate for the boolean leaf (features/boolean.ts). Rebuilds
// the same target + tool box bodies as
// the now-removed gen_boolean_solve_fixture.py, runs solveBoolean for
// union / subtract / intersect / keep-tools / subtract-split, and asserts the
// result dict plus the post-op body store (per body: volume, created_by,
// modified_by) match Python.
//
// Skips when opencascade.js is absent. The fixture is a frozen golden snapshot;
// its generator (gen_boolean_solve_fixture.py) was deleted with the Python
// kernel in phase 4d.

import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from '../occ/loadOcc'
import { DisposeScope } from '../occ/disposeScope'
import { HandleTable } from '../occ/handleTable'
import { makeBoxAt, type Vec3 } from '../occ/primitives'
import { volumeOf, countSolids } from '../occ/booleans'
import { makeTranslationTrsf, transformCopy } from '../occ/transforms'
import { Repository } from '../query'
import { solveBoolean } from './boolean'
import type { Body } from '../types3d'
import type { OccModule, OccShape } from '../occ/occTypes'
import fixture from '../occ/__fixtures__/booleanSolve.json'

const oc = await loadOcc()

type BodyState = { volume: number | null; created_by: string; modified_by: string[] }
type BoxSpec = [number[], number[]]
type Case = {
  name: string
  operation: string
  tool_refs: string[]
  keep_tools: boolean
  target_spec: BoxSpec
  tool_specs: BoxSpec[]
  result: { status: string; body_id: string; body_ids: string[]; operation: string }
  store: Record<string, BodyState>
}
const fx = fixture as unknown as { cases: Case[] }

function bodyFromSpec(
  occ: OccModule,
  scope: DisposeScope,
  table: HandleTable,
  id: string,
  createdBy: string,
  spec: BoxSpec,
): Body {
  const box = makeBoxAt(occ, scope, spec[0] as Vec3, spec[1][0], spec[1][1], spec[1][2])
  return {
    id,
    created_by: createdBy,
    modified_by: [],
    shape: table.register(box, createdBy),
    sketch_id: id === 'body_t' ? 'sk_t' : 'sk_u',
    brep_diff: null,
    profile_queries: [],
  }
}

// The L5 fixture: a solid whose shell is open by a hairline. A box's top face
// is lowered 0.001 so its edges no longer meet the side walls, then the six
// faces are sewn into a shell and BRepBuilderAPI_MakeSolid is called on it --
// the shape is still a TopoDS_Solid, but VolumeProperties with OnlyClosed=true
// integrates it to ~0. double_with_hole.step was probed first and is properly
// closed (its import reads a real volume), and a STEP round-trip of this shape
// heals the gap back into a plain shell, so the fixture is built here rather
// than read from a file.
function makeOpenShellBox(occ: OccModule, scope: DisposeScope): OccShape {
  const occAny = occ as unknown as {
    TopoDS_Shell: new () => { delete(): void }
    BRep_Builder: new () => {
      MakeShell(shell: unknown): void
      Add(shell: unknown, part: unknown): void
      delete(): void
    }
    BRepBuilderAPI_MakeSolid_3: new (shell: unknown) => { Shape(): unknown; delete(): void }
  }
  const E = occ.TopAbs_ShapeEnum
  const base = makeBoxAt(occ, scope, [0, 0, 0], 10, 10, 10)
  const faces: OccShape[] = []
  const exp = scope.track(new occ.TopExp_Explorer_2(base, E.TopAbs_FACE, E.TopAbs_SHAPE))
  for (; exp.More(); exp.Next()) faces.push(scope.track(exp.Current()) as OccShape)
  const shell = scope.track(new occAny.TopoDS_Shell())
  const builder = scope.track(new occAny.BRep_Builder())
  builder.MakeShell(shell)
  const top = scope.track(transformCopy(occ, scope, faces[5], makeTranslationTrsf(occ, scope, 0, 0, -0.001)))
  for (let i = 0; i < 5; i++) builder.Add(shell, faces[i])
  builder.Add(shell, top)
  const maker = scope.track(new occAny.BRepBuilderAPI_MakeSolid_3(shell))
  return maker.Shape() as OccShape
}

describe.skipIf(!oc)('solveBoolean (real OCC)', () => {
  let occ: OccModule
  beforeAll(() => {
    if (!oc) throw new Error('unreachable: skipIf guards this')
    occ = oc
  })

  for (const c of fx.cases) {
    it(`${c.name}: result + body store match Python`, () => {
      const scope = new DisposeScope()
      const table = new HandleTable()
      try {
        const bodyStore: Record<string, Body> = {
          body_t: bodyFromSpec(occ, scope, table, 'body_t', 'ex_t', c.target_spec),
        }
        c.tool_specs.forEach((spec, i) => {
          bodyStore[`body_u${i}`] = bodyFromSpec(occ, scope, table, `body_u${i}`, `ex_u${i}`, spec)
        })

        const result = solveBoolean(
          occ,
          scope,
          table,
          { id: 'bool1', boolean: { operation: c.operation, target: 'body_t', tools: c.tool_refs, keep_tools: c.keep_tools } },
          new Repository(),
          bodyStore,
        )
        expect(result).toEqual(c.result)

        const got: Record<string, BodyState> = {}
        for (const [bid, b] of Object.entries(bodyStore)) {
          got[bid] = {
            volume: b.shape === null ? null : volumeOf(occ, scope, table.get<OccShape>(b.shape)),
            created_by: b.created_by,
            modified_by: b.modified_by,
          }
        }
        // Volumes within tolerance; structural fields exact.
        expect(Object.keys(got).sort()).toEqual(Object.keys(c.store).sort())
        for (const bid of Object.keys(c.store)) {
          expect(got[bid].created_by).toBe(c.store[bid].created_by)
          expect(got[bid].modified_by).toEqual(c.store[bid].modified_by)
          if (c.store[bid].volume === null) expect(got[bid].volume).toBeNull()
          else expect(got[bid].volume as number).toBeCloseTo(c.store[bid].volume as number, 3)
        }
      } finally {
        scope.dispose()
      }
    })
  }

  describe('boolean inline cases', () => {
    it('multiple tools are all consumed', () => {
      // Boolean with two tools should consume both.
      const scope = new DisposeScope()
      const table = new HandleTable()
      try {
        const bodyStore: Record<string, Body> = {
          body_t: bodyFromSpec(occ, scope, table, 'body_t', 'ex_t', [[0, 0, 0], [10, 10, 10]]),
          body_u0: bodyFromSpec(occ, scope, table, 'body_u0', 'ex_u0', [[0, 0, 0], [2, 2, 2]]),
          body_u1: bodyFromSpec(occ, scope, table, 'body_u1', 'ex_u1', [[3, 0, 0], [2, 2, 2]]),
        }
        const targetVol = volumeOf(occ, scope, table.get<OccShape>(bodyStore.body_t.shape!))

        const result = solveBoolean(
          occ, scope, table,
          { id: 'bool1', boolean: { operation: 'subtract', target: 'body_t', tools: ['body_u0', 'body_u1'] } },
          new Repository(),
          bodyStore,
        )
        expect(result.status).toBe('ok')
        expect(result.operation).toBe('subtract')
        // Both tools consumed
        expect('body_u0' in bodyStore).toBe(false)
        expect('body_u1' in bodyStore).toBe(false)
        // Target volume reduced
        expect(volumeOf(occ, scope, table.get<OccShape>(bodyStore.body_t.shape!))).toBeLessThan(targetVol)
      } finally {
        scope.dispose()
      }
    })

    it('subtract of a disjoint tool keeps the tool instead of consuming it (KE-M2)', () => {
      // A subtract whose tool does not overlap the target must not silently eat
      // the tool body; it is skipped and a solver warning names the miss.
      const scope = new DisposeScope()
      const table = new HandleTable()
      try {
        const bodyStore: Record<string, Body> = {
          body_t: bodyFromSpec(occ, scope, table, 'body_t', 'ex_t', [[0, 0, 0], [10, 10, 10]]),
          body_u0: bodyFromSpec(occ, scope, table, 'body_u0', 'ex_u0', [[100, 0, 0], [2, 2, 2]]),
        }
        const targetVol = volumeOf(occ, scope, table.get<OccShape>(bodyStore.body_t.shape!))

        const result = solveBoolean(
          occ, scope, table,
          { id: 'bool1', boolean: { operation: 'subtract', target: 'body_t', tools: ['body_u0'] } },
          new Repository(),
          bodyStore,
        )
        expect(result.status).toBe('ok')
        // The missed tool is preserved (the old code consumed it anyway).
        expect('body_u0' in bodyStore).toBe(true)
        // Target is unchanged because nothing was subtracted.
        expect(volumeOf(occ, scope, table.get<OccShape>(bodyStore.body_t.shape!))).toBeCloseTo(targetVol, 3)
        expect(result.solver_warning).toContain('does not intersect')
      } finally {
        scope.dispose()
      }
    })

    it('intersect of disjoint bodies keeps the target and warns instead of an empty compound (KE-M2)', () => {
      // A common/ of two disjoint solids yields an empty compound; the leaf must
      // not report that as a successful boolean but skip the disjoint tool.
      const scope = new DisposeScope()
      const table = new HandleTable()
      try {
        const bodyStore: Record<string, Body> = {
          body_t: bodyFromSpec(occ, scope, table, 'body_t', 'ex_t', [[0, 0, 0], [10, 10, 10]]),
          body_u0: bodyFromSpec(occ, scope, table, 'body_u0', 'ex_u0', [[100, 0, 0], [2, 2, 2]]),
        }
        const targetVol = volumeOf(occ, scope, table.get<OccShape>(bodyStore.body_t.shape!))

        const result = solveBoolean(
          occ, scope, table,
          { id: 'bool1', boolean: { operation: 'intersect', target: 'body_t', tools: ['body_u0'] } },
          new Repository(),
          bodyStore,
        )
        expect(result.status).toBe('ok')
        // The disjoint tool is preserved (not consumed by an empty common).
        expect('body_u0' in bodyStore).toBe(true)
        // Target volume is unchanged (no empty compound replaced it).
        expect(volumeOf(occ, scope, table.get<OccShape>(bodyStore.body_t.shape!))).toBeCloseTo(targetVol, 3)
        expect(result.solver_warning).toContain('does not intersect')
      } finally {
        scope.dispose()
      }
    })

    it('runs the clean pass exactly once per folded tool (M18 pin)', () => {
      // M18's evidence: the probe used to run the whole booleanWithDiff
      // pipeline (boolean.ts:107) just to read one number, so a folding
      // subtract constructed ShapeUpgrade_UnifySameDomain_2 TWICE per tool:
      // once for the probe's common, once for the real cut. The probe is now
      // shapesIntersect (a bare Common, history off), so this is exactly ONE
      // per folded tool -- the real boolean only.
      const scope = new DisposeScope()
      const table = new HandleTable()
      try {
        const bodyStore: Record<string, Body> = {
          body_t: bodyFromSpec(occ, scope, table, 'body_t', 'ex_t', [[0, 0, 0], [10, 10, 10]]),
          body_u0: bodyFromSpec(occ, scope, table, 'body_u0', 'ex_u0', [[0, 0, 0], [2, 2, 2]]),
        }

        const occAny = occ as unknown as { ShapeUpgrade_UnifySameDomain_2: unknown }
        const ctor = occAny.ShapeUpgrade_UnifySameDomain_2 as new (...args: unknown[]) => { delete: () => void }
        let count = 0
        occAny.ShapeUpgrade_UnifySameDomain_2 = function (this: unknown, ...args: unknown[]) {
          count++
          return new ctor(...args)
        }
        try {
          const result = solveBoolean(
            occ, scope, table,
            { id: 'bool1', boolean: { operation: 'subtract', target: 'body_t', tools: ['body_u0'] } },
            new Repository(),
            bodyStore,
          )
          expect(result.status).toBe('ok')
        } finally {
          occAny.ShapeUpgrade_UnifySameDomain_2 = ctor
        }
        expect(count).toBe(1)
      } finally {
        scope.dispose()
      }
    })

    it('consumes an overlapping tool on an open-shell body the volume oracle read as disjoint (L5)', () => {
      // The L5 finding pinned on the built fixture: a cut whose Common is a
      // solid (countSolids > 0) that integrates to ~0 under volumeOf's
      // OnlyClosed=true. The OLD probe skipped such a cut with a "does not
      // intersect" warning; the solid-count oracle sees the Common's solid and
      // the cut runs. The tool crosses the open seam, which is what makes the
      // Common's own shell open.
      const scope = new DisposeScope()
      const table = new HandleTable()
      try {
        const targetShape = makeOpenShellBox(occ, scope)
        const tool = makeBoxAt(occ, scope, [5, -5, -5], 10, 10, 20)

        const algo = scope.track(new occ.BRepAlgoAPI_Common_1())
        const args = scope.track(new occ.TopTools_ListOfShape_1())
        args.Append_1(targetShape)
        const tools = scope.track(new occ.TopTools_ListOfShape_1())
        tools.Append_1(tool)
        algo.SetArguments(args)
        algo.SetTools(tools)
        algo.SetToFillHistory(false)
        algo.Build()
        const inter = scope.track(algo.Shape())
        expect(countSolids(occ, scope, inter)).toBeGreaterThan(0)
        expect(volumeOf(occ, scope, inter)).toBeLessThan(1e-10)

        const bodyStore: Record<string, Body> = {
          body_t: {
            id: 'body_t', created_by: 'ex_t', modified_by: [], sketch_id: '',
            shape: table.register(targetShape, 'ex_t'), brep_diff: null, profile_queries: [], imported: true,
          },
          body_u0: {
            id: 'body_u0', created_by: 'ex_u0', modified_by: [], sketch_id: 'sk',
            shape: table.register(tool, 'ex_u0'), brep_diff: null, profile_queries: [],
          },
        }
        const result = solveBoolean(
          occ, scope, table,
          { id: 'bool1', boolean: { operation: 'subtract', target: 'body_t', tools: ['body_u0'] } },
          new Repository(), bodyStore,
        )
        expect(result.status).toBe('ok')
        expect(result.solver_warning).toBeUndefined()
        expect('body_u0' in bodyStore).toBe(false)  // the tool was consumed, not skipped
        expect('body_t' in bodyStore).toBe(true)    // the cut ran and the body survived
      } finally {
        scope.dispose()
      }
    })

    it('a cut whose tool swallows the target deletes the body and reports nothing survives', () => {
      // M15-b: when the boolean consumes the whole target, resplitBody removes
      // it from the store. The result must return body_ids: [] (not a live id),
      // and a later feature targeting the gone body must fail by name rather
      // than read a null shape.
      const scope = new DisposeScope()
      const table = new HandleTable()
      try {
        const bodyStore: Record<string, Body> = {
          body_t: bodyFromSpec(occ, scope, table, 'body_t', 'ex_t', [[0, 0, 0], [10, 10, 10]]),
          body_u0: bodyFromSpec(occ, scope, table, 'body_u0', 'ex_u0', [[-5, -5, -5], [20, 20, 20]]),
        }

        const result = solveBoolean(
          occ, scope, table,
          { id: 'bool1', boolean: { operation: 'subtract', target: 'body_t', tools: ['body_u0'] } },
          new Repository(),
          bodyStore,
        )
        expect(result.status).toBe('ok')
        expect(result.body_ids).toEqual([])
        expect(result.body_id).toBe('body_t')  // still names the consumed body
        expect(result.solver_warning).toMatch(/removed all of body 'body_t'; the body was deleted/)
        expect('body_t' in bodyStore).toBe(false)
        // The tool is consumed too (keep_tools false), leaving an empty store.
        expect('body_u0' in bodyStore).toBe(false)

        // A second feature naming the deleted target fails by name, not with a
        // null-shape error.
        expect(() =>
          solveBoolean(
            occ, scope, table,
            { id: 'bool2', boolean: { operation: 'subtract', target: 'body_t', tools: ['body_u0'] } },
            new Repository(),
            bodyStore,
          ),
        ).toThrow(/body not found for ref 'body_t'/)
      } finally {
        scope.dispose()
      }
    })
  })
})
