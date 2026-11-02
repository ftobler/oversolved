// @vitest-environment node
//
// A STEP file imported straight into an assembly, through the real OCC kernel
// and the real Rust mate solver: the synthesized part document builds, the
// instance mates to the assembly frame, and the placed assembly measures and
// exports. The fixture is the checked-in double_with_hole STEP, so nothing is
// fetched and the bytes match the import_step leaf corpus.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { loadOcc } from '@/kernel/occ/loadOcc'
import { setSolveLocalsForTest } from '@/kernel/solveLocally'
import { setSketchSolver, resetSketchSolver } from '@/kernel/features/sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { loadPkgNodeExport, PKG_MATE } from '@/wasm-kernel/loadPkgNode'
import { emptyDriveAssemblyDoc, setMateSolver } from '../headlessAssembly'
import { exportAssemblyHeadless, measureAssemblyHeadless, runAssemblyHeadless } from '../headlessOps'
import type { ScriptStepOutcome } from '../scriptRunner'

const oc = await loadOcc()
const solveBytes = loadSolver()
const solveMate = loadPkgNodeExport<(input: Uint8Array) => Uint8Array>('solve_mate_bytes', PKG_MATE)
const describeReal = oc && solveBytes && solveMate ? describe : describe.skip

const STEP = new Uint8Array(readFileSync(
  new URL('../../kernel/occ/__fixtures__/double_with_hole.step', import.meta.url),
))

const TOP_FACE = {
  kind: 'face' as const,
  where: { and: [{ type: 'flatface' as const }, { extreme: { axis: 'z' as const, side: 'max' as const } }] },
}

describeReal('STEP imported into an assembly', () => {
  beforeAll(() => {
    resetSketchSolver()
    setSketchSolver(solveBytes!)
    setSolveLocalsForTest(async () => oc)
    setMateSolver(solveMate)
  })
  afterAll(() => {
    setMateSolver(null)
    setSolveLocalsForTest(null)
    resetSketchSolver()
  })

  it('solves the imported instance against the assembly frame and exports it', async () => {
    const files = new Map([['f1', STEP]])
    const run = await runAssemblyHeadless({
      doc: emptyDriveAssemblyDoc(),
      parts: new Map(),
      files,
      steps: [
        { mutation: { type: 'add_step_part', handle: 'housing', file: 'f1', name: 'Housing' } },
        { mutation: {
          type: 'add_mate', featureId: 'm1', kind: 'fixed',
          ref_a: { part: '__assembly', anchor: 'AssemblyFront' },
          ref_b: { part: 'housing', selector: TOP_FACE },
        } },
      ],
    })

    expect(run.ok).toBe(true)
    expect(run.mates).toEqual([])
    expect(run.parts).toEqual([])
    expect(run.solve.verdict).not.toBe('failed')
    expect(run.instances).toHaveLength(1)
    expect(run.instances[0].part).toBe('step_f1')
    // The reply names the part the step created, and the binding carries it so
    // a later call on the composite handle can build it.
    expect((run.outcome.steps[0] as ScriptStepOutcome).part).toEqual({
      docId: 'step_f1', name: 'Housing', fileId: 'f1',
    })
    expect(Object.keys(run.binding)).toEqual(['step_f1'])

    const parts = new Map(Object.entries(run.binding))
    const measured = await measureAssemblyHeadless(run.doc, parts, { files })
    expect(measured).not.toBeNull()
    expect(measured!.ok).toBe(true)
    expect(measured!.measures.bodies).toBe(1)
    expect(measured!.measures.volume).toBeGreaterThan(0)

    const exported = await exportAssemblyHeadless(run.doc, parts, { format: 'step', files })
    expect(exported).not.toBeNull()
    expect(exported!.ok).toBe(true)
    expect(exported!.bytes?.byteLength).toBeGreaterThan(0)
  }, 180_000)
})
