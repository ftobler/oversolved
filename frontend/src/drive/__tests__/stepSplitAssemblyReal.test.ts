// @vitest-environment node
//
// The headless B2 import: add_step_part with split: true on a two-box STEP file
// solves to one instance per solid, placed where the bodies sat in the source
// file. The fixture is built in this test with the real OCC module and written
// through the same STEP writer the import reads, so the expected boxes are
// exact; the A-mode run on the same bytes is the reference the split run has to
// reproduce.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { loadOcc } from '@/kernel/occ/loadOcc'
import { DisposeScope } from '@/kernel/occ/disposeScope'
import type { OccModule } from '@/kernel/occ/occTypes'
import { makeBoxAt } from '@/kernel/occ/primitives'
import { stepShapeToBytes } from '@/kernel/occ/stepIo'
import { setSolveLocalsForTest } from '@/kernel/solveLocally'
import { setSketchSolver, resetSketchSolver } from '@/kernel/features/sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { loadPkgNodeExport, PKG_MATE } from '@/wasm-kernel/loadPkgNode'
import { emptyDriveAssemblyDoc, setMateSolver } from '../headlessAssembly'
import { measureAssemblyHeadless, runAssemblyHeadless } from '../headlessOps'
import type { ScriptStepOutcome } from '../scriptRunner'
import type { Bbox6 } from '@/kernel/occ/measure'

const oc = await loadOcc()
const solveBytes = loadSolver()
const solveMate = loadPkgNodeExport<(input: Uint8Array) => Uint8Array>('solve_mate_bytes', PKG_MATE)
const describeReal = oc && solveBytes && solveMate ? describe : describe.skip

const BOX = 10
const OFFSET = 40

// Two disjoint boxes in one compound: the shape a multi-part STEP file reads as.
function twoBoxStep(occ: OccModule): Uint8Array {
  const scope = new DisposeScope()
  try {
    const first = scope.track(makeBoxAt(occ, scope, [0, 0, 0], BOX, BOX, BOX))
    const second = scope.track(makeBoxAt(occ, scope, [OFFSET, 0, 0], BOX, BOX, BOX))
    const builder = scope.track(new occ.BRep_Builder())
    const compound = scope.track(new occ.TopoDS_Compound())
    builder.MakeCompound(compound)
    builder.Add(compound, first)
    builder.Add(compound, second)
    return stepShapeToBytes(occ, scope, compound)
  } finally {
    scope.dispose()
  }
}

// A bbox as a comparable string; the two runs must agree to well inside the
// solver tolerance, and rounding keeps a last-bit difference from failing the
// comparison while still naming a real displacement.
const boxKey = (bbox: Bbox6 | null): string => (bbox ?? []).map(value => value.toFixed(6)).join(',')

describeReal('STEP split into an assembly of parts', () => {
  let step: Uint8Array
  beforeAll(() => {
    resetSketchSolver()
    setSketchSolver(solveBytes!)
    setSolveLocalsForTest(async () => oc)
    setMateSolver(solveMate)
    step = twoBoxStep(oc!)
  })
  afterAll(() => {
    setMateSolver(null)
    setSolveLocalsForTest(null)
    resetSketchSolver()
  })

  it('places one part per solid where the A-mode bodies sat, leaving the free one still', async () => {
    const files = new Map([['boxes', step]])
    const single = await runAssemblyHeadless({
      doc: emptyDriveAssemblyDoc(),
      parts: new Map(),
      files,
      steps: [{ mutation: { type: 'add_step_part', handle: 'whole', file: 'boxes', name: 'Whole' } }],
    })
    expect(single.ok).toBe(true)
    const singleParts = new Map(Object.entries(single.binding))
    const singleMeasured = await measureAssemblyHeadless(single.doc, singleParts, { files })
    expect(singleMeasured?.ok).toBe(true)
    expect(singleMeasured!.measures.perBody).toHaveLength(2)

    const split = await runAssemblyHeadless({
      doc: emptyDriveAssemblyDoc(),
      parts: new Map(),
      files,
      steps: [{ mutation: { type: 'add_step_part', handle: 'box', file: 'boxes', name: 'Box', split: true } }],
    })
    expect(split.ok).toBe(true)
    expect(split.instances.map(instance => instance.handle)).toEqual(['box_1', 'box_2'])
    // The first instance anchors the assembly, the second stays free.
    expect(split.instances.map(instance => instance.fixed)).toEqual([true, false])
    // An unmated free instance keeps its seed pose: the split files carry their
    // own world coordinates, so identity is the whole placement.
    expect(split.instances[1].position).toEqual([0, 0, 0])
    expect(split.instances[1].rotation).toEqual([0, 0, 0])

    const stepOutcome = split.outcome.steps[0] as ScriptStepOutcome
    expect(stepOutcome.handles).toEqual(['box_1', 'box_2'])
    expect(stepOutcome.parts?.map(part => part.name)).toEqual(['Box_1', 'Box_2'])
    expect(stepOutcome.parts?.map(part => part.docId)).toEqual(['step_boxes#1', 'step_boxes#2'])

    // The split's part documents import the derived files the session wrote.
    const splitFiles = new Map([...files, ...Object.entries(split.session.files())])
    const splitMeasured = await measureAssemblyHeadless(
      split.doc, new Map(Object.entries(split.binding)), { files: splitFiles },
    )
    expect(splitMeasured?.ok).toBe(true)
    expect(splitMeasured!.measures.perBody).toHaveLength(2)
    // Every split body sits exactly where one of the A-mode bodies sat.
    expect(splitMeasured!.measures.perBody.map(row => boxKey(row.bbox)).sort())
      .toEqual(singleMeasured!.measures.perBody.map(row => boxKey(row.bbox)).sort())
    expect(splitMeasured!.measures.volume).toBeCloseTo(singleMeasured!.measures.volume, 6)
  }, 180_000)

  it('falls through to the plain import for a one-solid file', async () => {
    const oneBox = (() => {
      const scope = new DisposeScope()
      try {
        return stepShapeToBytes(oc!, scope, scope.track(makeBoxAt(oc!, scope, [0, 0, 0], BOX, BOX, BOX)))
      } finally {
        scope.dispose()
      }
    })()
    const files = new Map([['one', oneBox]])

    const run = await runAssemblyHeadless({
      doc: emptyDriveAssemblyDoc(),
      parts: new Map(),
      files,
      steps: [{ mutation: { type: 'add_step_part', handle: 'part', file: 'one', split: true } }],
    })

    expect(run.ok).toBe(true)
    expect(run.instances).toHaveLength(1)
    expect(run.instances[0].handle).toBe('part')
    const stepOutcome = run.outcome.steps[0] as ScriptStepOutcome
    expect(stepOutcome.handles).toEqual(['part'])
    expect(stepOutcome.part).toEqual({ docId: 'step_one', name: 'one', fileId: 'one' })
  }, 180_000)
})
