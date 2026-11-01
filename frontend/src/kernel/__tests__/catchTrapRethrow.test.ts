// @vitest-environment node
//
// A best-effort builder catch may swallow a document error, but not a WASM
// trap: the linear memory is undefined after one, and carrying on defers the
// failure to the next OCC call, where solvedLocally can no longer tell which
// feature broke the heap. Every non-teardown catch in the converted helper set
// calls swallowUnlessTrap first.
//
// The source sweep pins the whole converted set so a new bare catch in one of
// these files fails here; the real-OCC cases inject a trap into the entry
// points that own the plan's named catches and prove it propagates while a
// plain error still takes the old fallback.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import * as ts from 'typescript'
import { loadOcc } from '../occ/loadOcc'
import { DisposeScope } from '../occ/disposeScope'
import { HandleTable } from '../occ/handleTable'
import { canonicalFaces, emptyShapeNames } from '../occ/bodyNames'
import { makeBox } from '../occ/primitives'
import { Repository } from '../query'
import { applyShellWithLineage } from '../occ/thickSolid'
import { applyDeleteFacesWithLineage } from '../occ/defeature'
import { shapesIntersect } from '../occ/booleans'
import { solveHole } from '../features/hole'
import { isKernelTrap, swallowUnlessTrap } from '../errors'
import type { Body } from '../types3d'
import type { OccModule, OccShape } from '../occ/occTypes'

const oc = await loadOcc()

const HEAP_TRAP = () => new WebAssembly.RuntimeError('memory access out of bounds')

/** A real OCC module whose named class constructor throws `thrown`. */
function ocWithThrowingClass(name: string, thrown: () => unknown): OccModule {
  return new Proxy(oc!, {
    get(target, prop) {
      if (prop === name) return function () { throw thrown() }
      return Reflect.get(target, prop, target)
    },
  }) as OccModule
}

describe('swallowUnlessTrap', () => {
  it('rethrows a WASM trap and swallows a plain error', () => {
    const trap = new WebAssembly.RuntimeError('unreachable')
    expect(() => swallowUnlessTrap(trap)).toThrow('unreachable')
    expect(isKernelTrap(trap)).toBe(true)
    expect(() => swallowUnlessTrap(new Error('ordinary failure'))).not.toThrow()
    expect(() => swallowUnlessTrap(6684320)).not.toThrow()
    // Embind's class-registry mismatch is how a refused builder call reports
    // itself; the linear memory is intact, so the bisection fallback stays.
    expect(() => swallowUnlessTrap(
      new WebAssembly.RuntimeError('null function or function signature mismatch'),
    )).not.toThrow()
  })
})

describe.skipIf(!oc)('operational catches rethrow traps (real OCC)', () => {
  it('shapesIntersect rethrows a trap but keeps the failed-probe fallback', () => {
    const trapOc = ocWithThrowingClass('BRepAlgoAPI_Common_1', HEAP_TRAP)
    expect(() => shapesIntersect(trapOc, {} as OccShape, {} as OccShape)).toThrow(WebAssembly.RuntimeError)
    const plainOc = ocWithThrowingClass('BRepAlgoAPI_Common_1', () => new Error('probe failed'))
    expect(shapesIntersect(plainOc, {} as OccShape, {} as OccShape)).toBe(true)
  })

  it('an open shell rethrows a trap from MakeThickSolidByJoin', () => {
    const scope = new DisposeScope()
    try {
      const box = makeBox(oc!, scope, 10, 10, 10)
      const closing = canonicalFaces(oc!, scope, box)[0]
      const trapOc = ocWithThrowingClass('BRepOffsetAPI_MakeThickSolid_1', HEAP_TRAP)
      expect(() => applyShellWithLineage(trapOc, scope, box, [closing], 1, 'inward'))
        .toThrow(WebAssembly.RuntimeError)
    } finally {
      scope.dispose()
    }
  })

  it('a sealed shell rethrows a trap from MakeOffsetShape', () => {
    const scope = new DisposeScope()
    try {
      const box = makeBox(oc!, scope, 10, 10, 10)
      const oldNames = { ...emptyShapeNames(), createdBy: 'ex1' }
      const trapOc = ocWithThrowingClass('BRepOffsetAPI_MakeOffsetShape_1', HEAP_TRAP)
      expect(() => applyShellWithLineage(trapOc, scope, box, [], 1, 'inward', oldNames))
        .toThrow(WebAssembly.RuntimeError)
    } finally {
      scope.dispose()
    }
  })

  it('a sealed shell rethrows a trap from the closing boolean', () => {
    const scope = new DisposeScope()
    try {
      const box = makeBox(oc!, scope, 10, 10, 10)
      const oldNames = { ...emptyShapeNames(), createdBy: 'ex1' }
      const trapOc = ocWithThrowingClass('BRepAlgoAPI_Cut_1', HEAP_TRAP)
      expect(() => applyShellWithLineage(trapOc, scope, box, [], 1, 'inward', oldNames))
        .toThrow(WebAssembly.RuntimeError)
    } finally {
      scope.dispose()
    }
  })

  it('delete-face rethrows a trap from the defeature build', () => {
    const scope = new DisposeScope()
    try {
      const box = makeBox(oc!, scope, 10, 10, 10)
      const faces = canonicalFaces(oc!, scope, box) as OccShape[]
      const trapOc = ocWithThrowingClass('BRepAlgoAPI_Defeaturing', HEAP_TRAP)
      expect(() => applyDeleteFacesWithLineage(trapOc, scope, box, [faces[0]]))
        .toThrow(WebAssembly.RuntimeError)
    } finally {
      scope.dispose()
    }
  })

  it('a drill-site intersection probe rethrows a trap', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    const repo = new Repository()
    try {
      const box = makeBox(oc!, scope, 20, 20, 20)
      const body: Body = {
        id: 'body_t', created_by: 'ex', modified_by: [], shape: table.register(box, 'ex'),
        sketch_id: 'sk', brep_diff: null, profile_queries: [],
      }
      repo.register('_pt_sk', {
        origin: [0, 0, 0], x_axis: [1, 0, 0], y_axis: [0, 1, 0], normal: [0, 0, 1],
      })
      repo.register('sk/p1/xy', { external_xy: [5, 5] })
      const trapOc = ocWithThrowingClass('BRepAlgoAPI_Common_1', HEAP_TRAP)
      expect(() => solveHole(trapOc, scope, table, {
        id: 'h1', kind: 'hole',
        hole: { sketch: '@sk', target: 'body_t', diameter: 2, depth: 5 },
      }, repo, { body_t: body }, { sk: { entities: [{ id: 'p1', kind: 'point' }] } }))
        .toThrow(WebAssembly.RuntimeError)
    } finally {
      table.disposeAll()
      scope.dispose()
    }
  })

  it('keeps the recoverable fallback for plain errors at each entry point', () => {
    // Open shell: the two join attempts fail as ordinary build errors.
    {
      const scope = new DisposeScope()
      try {
        const box = makeBox(oc!, scope, 10, 10, 10)
        const closing = canonicalFaces(oc!, scope, box)[0]
        const plainOc = ocWithThrowingClass('BRepOffsetAPI_MakeThickSolid_1', () => new Error('join failed'))
        expect(applyShellWithLineage(plainOc, scope, box, [closing], 1, 'inward').success).toBe(false)
      } finally {
        scope.dispose()
      }
    }
    // Sealed shell: the offset attempt fails as an ordinary build error.
    {
      const scope = new DisposeScope()
      try {
        const box = makeBox(oc!, scope, 10, 10, 10)
        const oldNames = { ...emptyShapeNames(), createdBy: 'ex1' }
        const plainOc = ocWithThrowingClass('BRepOffsetAPI_MakeOffsetShape_1', () => new Error('offset failed'))
        expect(applyShellWithLineage(plainOc, scope, box, [], 1, 'inward', oldNames).success).toBe(false)
      } finally {
        scope.dispose()
      }
    }
    // Sealed shell: the closing boolean fails as an ordinary build error.
    {
      const scope = new DisposeScope()
      try {
        const box = makeBox(oc!, scope, 10, 10, 10)
        const oldNames = { ...emptyShapeNames(), createdBy: 'ex1' }
        const plainOc = ocWithThrowingClass('BRepAlgoAPI_Cut_1', () => new Error('cut failed'))
        expect(applyShellWithLineage(plainOc, scope, box, [], 1, 'inward', oldNames).success).toBe(false)
      } finally {
        scope.dispose()
      }
    }
    // Delete-face: the defeature build fails as an ordinary refusal.
    {
      const scope = new DisposeScope()
      try {
        const box = makeBox(oc!, scope, 10, 10, 10)
        const faces = canonicalFaces(oc!, scope, box) as OccShape[]
        const plainOc = ocWithThrowingClass('BRepAlgoAPI_Defeaturing', () => new Error('build failed'))
        const result = applyDeleteFacesWithLineage(plainOc, scope, box, [faces[0]])
        expect(result.applied).toBe(false)
        expect(result.failedGroups.length).toBeGreaterThan(0)
      } finally {
        scope.dispose()
      }
    }
    // Hole: a failed intersection probe still lets the real cut run.
    {
      const scope = new DisposeScope()
      const table = new HandleTable()
      const repo = new Repository()
      try {
        const box = makeBox(oc!, scope, 20, 20, 20)
        const body: Body = {
          id: 'body_t', created_by: 'ex', modified_by: [], shape: table.register(box, 'ex'),
          sketch_id: 'sk', brep_diff: null, profile_queries: [],
        }
        repo.register('_pt_sk', {
          origin: [0, 0, 0], x_axis: [1, 0, 0], y_axis: [0, 1, 0], normal: [0, 0, 1],
        })
        repo.register('sk/p1/xy', { external_xy: [5, 5] })
        const plainOc = ocWithThrowingClass('BRepAlgoAPI_Common_1', () => new Error('probe failed'))
        const result = solveHole(plainOc, scope, table, {
          id: 'h1', kind: 'hole',
          hole: { sketch: '@sk', target: 'body_t', diameter: 2, depth: 5 },
        }, repo, { body_t: body }, { sk: { entities: [{ id: 'p1', kind: 'point' }] } })
        expect(result.status).toBe('ok')
        expect(result.hole_count).toBe(1)
      } finally {
        table.disposeAll()
        scope.dispose()
      }
    }
  })
})

describe('converted catch audit', () => {
  const files = [
    'builderAncestry.ts',
    'occ/canonicalSurfaces.ts',
    'occ/prismProfile.ts',
    'occ/booleans.ts',
    'occ/prismLineage.ts',
    'occ/edgeModifier.ts',
    'occ/constructionLineage.ts',
    'occ/thickSolid.ts',
    'occ/defeature.ts',
    'occ/halfSpace.ts',
    'occ/primitives.ts',
    'occ/faceLoops.ts',
    'occ/sharedHarness.ts',
    'features/bodyOps.ts',
    'features/extrude.ts',
    'features/revolve.ts',
    'features/sweep.ts',
    'features/hole.ts',
    'features/boolean.ts',
    'features/filletChamfer.ts',
    'features/faceProfile.ts',
    'features/sketch.ts',
    'features/upTo.ts',
  ]

  function catchLines(src: string, rel: string): Array<{ line: number; body: string; caught: string | null }> {
    const source = ts.createSourceFile(rel, src, ts.ScriptTarget.Latest, true)
    const out: Array<{ line: number; body: string; caught: string | null }> = []
    const visit = (node: ts.Node): void => {
      if (ts.isCatchClause(node)) {
        out.push({
          line: source.getLineAndCharacterOfPosition(node.block.getStart(source)).line + 1,
          body: node.block.getText(source),
          caught: node.variableDeclaration?.name.getText(source) ?? null,
        })
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
    return out
  }

  it('every catch in the converted files guards or rethrows the caught value', () => {
    for (const rel of files) {
      const src = readFileSync(new URL('../' + rel, import.meta.url), 'utf8')
      const unguarded: number[] = []
      for (const { line, body, caught } of catchLines(src, rel)) {
        const guarded = /swallowUnlessTrap\(/.test(body)
        // A bare `throw e` hands the caught value (trap included) to the caller,
        // so it needs no guard. A rethrow that REPLACES the value (`throw new
        // Error(...)`) does, or the trap stops being recognizable.
        const bareRethrow = caught !== null &&
          new RegExp(`throw\\s+${caught.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(body)
        if (!guarded && !bareRethrow) unguarded.push(line)
      }
      expect(unguarded, `${rel} catch lines without swallowUnlessTrap or a bare rethrow`).toEqual([])
    }
  })
})
