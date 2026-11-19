// @vitest-environment node
//
// A STEP import's file colour through the headless drive, end to end: the
// kernel reads the colour, the solver write-back seeds the NEW part_style entry
// with it, an existing entry (a user recolour) survives a re-solve and a file
// replace, undo/redo re-derives it without an undo entry of its own, and the
// reply names the colour when the file's faces disagreed (part `run` notes and
// the add_step_part step's note). Gated like the other drive suites.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { loadOcc, occInstalled } from '@/kernel/occ/loadOcc'
import { setOccLoader, setSolveLocalsForTest } from '@/kernel/solveLocally'
import { setSketchSolver, resetSketchSolver } from '@/kernel/features/sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { loadPkgNodeExport, PKG_MATE } from '@/wasm-kernel/loadPkgNode'
import type { PartDoc } from '@/types/cad'
import { emptyDriveAssemblyDoc, setMateSolver } from '../headlessAssembly'
import { createHeadlessPart } from '../headlessPart'
import { emptyDriveDoc, runAssemblyHeadless, runHeadless } from '../headlessOps'
import type { ScriptStep } from '../scriptRunner'

const oc = occInstalled()
const solveBytes = loadSolver()
const solveMate = loadPkgNodeExport<(input: Uint8Array) => Uint8Array>('solve_mate_bytes', PKG_MATE)
const describeReal = oc && solveBytes ? describe : describe.skip

function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(new URL(`../../kernel/occ/__fixtures__/${name}`, import.meta.url)))
}

const IMPORT: ScriptStep[] = [{ mutation: { type: 'add_import_step', featureId: 'imp1', fileId: 'f1' } } as ScriptStep]

const colorOf = (doc: PartDoc | null): string | undefined => doc?.part_style?.body_imp1?.color

describeReal('STEP import colour through the headless drive', () => {
  beforeAll(() => {
    setOccLoader(loadOcc)
    setSketchSolver(solveBytes!)
  })

  it('seeds the new part with the file colour and notes the dropped face colour', async () => {
    const run = await runHeadless({ doc: emptyDriveDoc(), steps: IMPORT, files: new Map([['f1', fixture('color_faces.step')]]) })
    expect(run.ok).toBe(true)
    expect(colorOf(run.doc)).toBe('#cc3333')
    const note = run.notes.find((n) => n.ids.includes('imp1'))
    expect(note?.text).toContain('takes #cc3333 from the STEP file')
    expect(note?.text).toContain('1 other colour dropped (#3333cc)')
  })

  it('keeps the palette and adds no note for an uncoloured file', async () => {
    const run = await runHeadless({ doc: emptyDriveDoc(), steps: IMPORT, files: new Map([['f1', fixture('double_with_hole.step')]]) })
    expect(run.ok).toBe(true)
    expect(colorOf(run.doc)).toMatch(/^#[0-9a-fA-F]{6}$/)
    expect(colorOf(run.doc)).not.toBe('#cc3333')
    expect(run.notes).toEqual([])
  })

  it('never repaints an existing entry: a user recolour survives a re-solve and a file replace', async () => {
    // A rename lands a real mutation, so each later run solves and writes back
    // (an empty script never solves) without touching the colour itself.
    const rename = (name: string): ScriptStep[] =>
      [{ mutation: { type: 'rename_part', bodyId: 'body_imp1', name } } as ScriptStep]

    const imported = await runHeadless({ doc: emptyDriveDoc(), steps: IMPORT, files: new Map([['f1', fixture('color_solid.step')]]) })
    expect(colorOf(imported.doc)).toBe('#808080')

    // The file's bytes are replaced under the same id: the part keeps its id and
    // with it the colour an earlier solve seeded, though the new bytes say red.
    // Its own docId works around a known bug, not intended behaviour: the
    // solve cache serves the previous read when only the bytes behind a file
    // id change (planned in feature/bug-import-replace-stale-cache.md).
    const replaced = await runHeadless({
      doc: imported.doc!, docId: 'replace-a', steps: rename('A'), files: new Map([['f1', fixture('color_faces.step')]]),
    })
    expect(replaced.solved).toBe(true)
    expect(replaced.notes.some((n) => n.text.includes('#cc3333'))).toBe(true)
    expect(colorOf(replaced.doc)).toBe('#808080')

    const recoloured = await runHeadless({
      doc: imported.doc!,
      steps: [{ mutation: { type: 'set_part_color', bodyId: 'body_imp1', color: '#123456' } } as ScriptStep],
      files: new Map([['f1', fixture('color_solid.step')]]),
    })
    expect(recoloured.solved).toBe(true)
    expect(colorOf(recoloured.doc)).toBe('#123456')
    const again = await runHeadless({
      doc: recoloured.doc!, docId: 'replace-b', steps: rename('B'), files: new Map([['f1', fixture('color_faces.step')]]),
    })
    expect(again.solved).toBe(true)
    expect(again.notes.some((n) => n.text.includes('#cc3333'))).toBe(true)
    expect(colorOf(again.doc)).toBe('#123456')
  })

  it('re-derives the colour on undo/redo with no undo entry of its own', async () => {
    const part = createHeadlessPart({ doc: emptyDriveDoc(), files: new Map([['f1', fixture('color_solid.step')]]) })
    expect((await part.run(IMPORT)).ok).toBe(true)
    expect(colorOf(part.getDoc())).toBe('#808080')
    // The import is the one entry; the write-back that seeded the colour is not.
    expect(part.session.historyEntries().undo).toHaveLength(1)

    expect((await part.run([{ command: 'undo' }])).ok).toBe(true)
    expect(part.getDoc()?.features?.some((f) => f.id === 'imp1')).toBe(false)
    expect((await part.run([{ command: 'redo' }])).ok).toBe(true)
    expect(colorOf(part.getDoc())).toBe('#808080')
    expect(part.session.historyEntries().undo).toHaveLength(1)
  })
})

const describeAssembly = oc && solveBytes && solveMate ? describe : describe.skip

describeAssembly('add_step_part colour note', () => {
  beforeAll(() => {
    resetSketchSolver()
    setSketchSolver(solveBytes!)
    setSolveLocalsForTest(async () => loadOcc())
    setMateSolver(solveMate)
  })
  afterAll(() => {
    setMateSolver(null)
    setSolveLocalsForTest(null)
    resetSketchSolver()
  })

  it('carries the colour the import picked on the step reply when faces disagreed', async () => {
    const run = await runAssemblyHeadless({
      doc: emptyDriveAssemblyDoc(),
      parts: new Map(),
      files: new Map([['f1', fixture('color_faces.step')]]),
      steps: [{ mutation: { type: 'add_step_part', handle: 'housing', file: 'f1' } }],
    })
    expect(run.ok).toBe(true)
    const step = run.outcome.steps[0] as { note?: string }
    expect(step.note).toContain('takes #cc3333 from the STEP file')
  })

  it('adds no note when the file agrees with itself', async () => {
    const run = await runAssemblyHeadless({
      doc: emptyDriveAssemblyDoc(),
      parts: new Map(),
      // Its own file id: the bundle memo is keyed by the part document and the
      // file ids, so reusing `f1` would hand back the build above.
      files: new Map([['f2', fixture('color_solid.step')]]),
      steps: [{ mutation: { type: 'add_step_part', handle: 'housing', file: 'f2' } }],
    })
    expect(run.ok).toBe(true)
    expect((run.outcome.steps[0] as { note?: string }).note).toBeUndefined()
  })
})
