// @vitest-environment node
//
// End-to-end tests for the drive CLI's measure round trips, through the real
// kernel: re-import an exported STEP file and match the measures, compare
// against a reference (and fail a perturbed one by name), the document unit in
// every reply, and the frames map filter. Split from cliSmoke;
// driveCliHarness.ts says why.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { FRONTEND_DIR } from './mcpStdioClient'
import { BOX_SCRIPT, IMPORT_SCRIPT, TMP_DIR, drive, driveUnavailable, expectBbox } from './driveCliHarness'

describe.skipIf(driveUnavailable)('drive CLI (real OCC + Rust solver)', () => {
  it('re-imports an exported STEP file and matches the measures', async () => {
    mkdirSync(TMP_DIR, { recursive: true })
    const boxScript = path.join(TMP_DIR, 'box3-script.json')
    const boxDoc = path.join(TMP_DIR, 'box3.yaml')
    const stepFile = path.join(TMP_DIR, 'box3.step')
    const importScript = path.join(TMP_DIR, 'import-script.json')
    const importDoc = path.join(TMP_DIR, 'imported.yaml')
    writeFileSync(boxScript, JSON.stringify(BOX_SCRIPT, null, 1))
    writeFileSync(importScript, JSON.stringify(IMPORT_SCRIPT, null, 1))

    expect((await drive('run', boxScript, '--out', boxDoc)).payload.ok).toBe(true)
    const before = await drive('measure', boxDoc)
    expect((await drive('export', boxDoc, '--format', 'step', '--out', stepFile)).status).toBe(0)

    // The import step needs the file bytes under the feature's file_id, both
    // to build the document and to measure it later.
    const fileFlag = `f1=${stepFile}`
    const built = await drive('run', importScript, '--file', fileFlag, '--out', importDoc)
    expect(built.status).toBe(0)
    expect(built.payload.ok).toBe(true)

    const after = await drive('measure', importDoc, '--file', fileFlag)
    expect(after.status).toBe(0)
    expect(after.payload.bodies).toBe(before.payload.bodies)
    expect(after.payload.faces).toBe(before.payload.faces)
    expect(after.payload.edges).toBe(before.payload.edges)
    expect(after.payload.vertices).toBe(before.payload.vertices)
    expect(after.payload.volume as number).toBeCloseTo(before.payload.volume as number, 6)
    expect(after.payload.area as number).toBeCloseTo(before.payload.area as number, 6)
    const beforeCentroid = before.payload.centroid as number[]
    const afterCentroid = after.payload.centroid as number[]
    for (let axis = 0; axis < 3; axis++) {
      expect(afterCentroid[axis]).toBeCloseTo(beforeCentroid[axis], 6)
    }
    expectBbox(after.payload.bbox, [0, 0, 0, 10, 10, 5])

    // The flag follows the project read rule on both surfaces: a repo-root
    // relative spelling finds the same file, while a path outside the roots is
    // refused before the build.
    const relative = await drive('measure', importDoc, '--file', 'f1=tmp/drive-cli-smoke/box3.step')
    expect(relative.status).toBe(0)
    expect(relative.payload.volume as number).toBeCloseTo(before.payload.volume as number, 6)
    const refused = await drive('measure', importDoc, '--file', 'f1=frontend/package.json')
    expect(refused.status).toBe(1)
    expect(String(refused.payload.error)).toContain('must resolve inside tmp/, bugreports/, scratch/')
  }, 180_000)

  it('compares the seed translation against its reference and fails a perturbed one by name', async () => {
    mkdirSync(TMP_DIR, { recursive: true })
    const seedDir = path.join(FRONTEND_DIR, 'translations/01-cylinder')
    const referenceFile = path.join(seedDir, 'reference.json')

    const passed = await drive('compare', path.join(seedDir, 'recipe.yaml'), referenceFile)
    expect(passed.status).toBe(0)
    expect(passed.payload).toMatchObject({ ok: true, pass: true })
    const rows = passed.payload.rows as Array<{ measure: string; within: boolean; enforced: boolean }>
    expect(rows.map(row => row.measure)).toEqual(['bodies', 'volume', 'area', 'centroid', 'bbox', 'faces', 'edges'])
    expect(rows.every(row => row.within)).toBe(true)

    // Move only the reference volume by 1e-3 relative: the compare must fail
    // on the volume row and leave every other row within.
    const reference = JSON.parse(readFileSync(referenceFile, 'utf8')) as { volume: number }
    reference.volume *= 1 + 1e-3
    const perturbedFile = path.join(TMP_DIR, 'perturbed-reference.json')
    writeFileSync(perturbedFile, JSON.stringify(reference, null, 1))

    const failed = await drive('compare', path.join(seedDir, 'recipe.yaml'), perturbedFile)
    expect(failed.status).toBe(1)
    expect(failed.payload).toMatchObject({ ok: true, pass: false })
    const failedRows = failed.payload.rows as Array<{ measure: string; within: boolean }>
    expect(failedRows.find(row => row.measure === 'volume')).toMatchObject({ within: false })
    expect(failedRows.filter(row => row.measure !== 'volume').every(row => row.within)).toBe(true)
  }, 180_000)

  it('rejects a compare reference without tolerance as a named error', async () => {
    mkdirSync(TMP_DIR, { recursive: true })
    const seedDir = path.join(FRONTEND_DIR, 'translations/01-cylinder')
    const reference = JSON.parse(readFileSync(path.join(seedDir, 'reference.json'), 'utf8')) as Record<string, unknown>
    delete reference.tolerance
    const badFile = path.join(TMP_DIR, 'bad-reference.json')
    writeFileSync(badFile, JSON.stringify(reference, null, 1))

    const result = await drive('compare', path.join(seedDir, 'recipe.yaml'), badFile)
    expect(result.status).toBe(1)
    expect(result.payload.ok).toBe(false)
    expect(result.payload.error).toContain('tolerance')
  }, 60_000)

  it('names the document unit in the CLI run, measure and export replies', async () => {
    mkdirSync(TMP_DIR, { recursive: true })
    const inchScript = path.join(TMP_DIR, 'inch-script.json')
    const inchDoc = path.join(TMP_DIR, 'inch.yaml')
    const stepFile = path.join(TMP_DIR, 'inch.step')
    writeFileSync(inchScript, JSON.stringify({
      steps: [
        { mutation: { type: 'set_length_unit', unit: 'inch' } },
        ...BOX_SCRIPT.steps,
      ],
    }, null, 1))

    const run = await drive('run', inchScript, '--out', inchDoc)
    expect(run.status).toBe(0)
    expect(run.payload.length_unit).toBe('inch')

    const measure = await drive('measure', inchDoc)
    expect(measure.status).toBe(0)
    expect(measure.payload.length_unit).toBe('inch')
    // The box is still the authored 10 x 10 x 5, now stated as inches.
    expect(measure.payload.volume as number).toBeCloseTo(500, 6)

    const exported = await drive('export', inchDoc, '--format', 'step', '--out', stepFile)
    expect(exported.status).toBe(0)
    expect(exported.payload).toMatchObject({ ok: true, length_unit: 'inch', file_unit: 'mm' })
    expect(readFileSync(stepFile).byteLength).toBe(exported.payload.bytes as number)
  }, 180_000)

  it('filters the CLI frames map and restores it with --frames all', async () => {
    mkdirSync(TMP_DIR, { recursive: true })
    const script = path.join(TMP_DIR, 'frames-script.json')
    const doc = path.join(TMP_DIR, 'frames.yaml')
    const inspectScript = path.join(TMP_DIR, 'frames-inspect.json')
    writeFileSync(script, JSON.stringify(BOX_SCRIPT, null, 1))
    writeFileSync(inspectScript, JSON.stringify({ steps: [] }, null, 1))
    expect((await drive('run', script, '--out', doc)).payload.ok).toBe(true)

    // A save-only call on an unchanged document reports no frames key at all.
    const inspect = await drive('run', inspectScript, '--doc', doc)
    expect(inspect.status).toBe(0)
    expect(inspect.payload).not.toHaveProperty('frames')

    // The explicit opt-in restores every resolved frame.
    const all = await drive('run', inspectScript, '--doc', doc, '--frames', 'all')
    expect(all.status).toBe(0)
    expect(Object.keys(all.payload.frames as Record<string, unknown>)).toEqual(['sk1'])
  }, 180_000)
})
