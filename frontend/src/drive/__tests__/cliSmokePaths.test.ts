// @vitest-environment node
//
// End-to-end tests for the drive CLI's failure and path handling, through the
// real kernel: a failed feature with ok still true, refused out, export and
// repro paths outside the project, a malformed script step, fresh nested
// parent directories, the default export path and an export parent that is a
// regular file. Split from cliSmoke; driveCliHarness.ts says why.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { HOLE_ON_LINE_SKETCH } from './featureFixtures'
import { FRONTEND_DIR } from './mcpStdioClient'
import { BOX_SCRIPT, COMMAND_SCRIPT, TMP_DIR, drive, driveUnavailable } from './driveCliHarness'

describe.skipIf(driveUnavailable)('drive CLI (real OCC + Rust solver)', () => {
  it('reports a failed feature while ok stays true, and an export of it as ok false', async () => {
    mkdirSync(TMP_DIR, { recursive: true })
    const holeScript = path.join(TMP_DIR, 'hole-line-sketch.json')
    const holeDoc = path.join(TMP_DIR, 'hole-line-sketch.yaml')
    const stepFile = path.join(TMP_DIR, 'hole-line-sketch.step')
    writeFileSync(holeScript, JSON.stringify({ steps: HOLE_ON_LINE_SKETCH }, null, 1))

    const run = await drive('run', holeScript, '--out', holeDoc)
    expect(run.status).toBe(0)
    expect(run.payload.ok).toBe(true)
    expect((run.payload.solve as { lastError: string | null }).lastError).toBeNull()
    const features = run.payload.features as Array<Record<string, unknown>>
    expect(features).toHaveLength(1)
    expect(features[0]).toMatchObject({ id: 'h1', kind: 'hole', status: 'exception' })
    expect(features[0].message).toMatch(/has no point/)

    // The export still writes the file but must not report it as clean: the
    // hole is named in the reply's own problem list.
    const exported = await drive('export', holeDoc, '--format', 'step', '--out', stepFile)
    expect(exported.status).toBe(1)
    expect(exported.payload.ok).toBe(false)
    const exportedFeatures = exported.payload.features as Array<Record<string, unknown>>
    expect(exportedFeatures).toHaveLength(1)
    expect(exportedFeatures[0]).toMatchObject({ id: 'h1', kind: 'hole', status: 'exception' })
    expect(existsSync(stepFile)).toBe(true)
    expect(readFileSync(stepFile).byteLength).toBe(exported.payload.bytes as number)
  }, 180_000)

  it('refuses an out path outside the project before running the script', async () => {
    mkdirSync(TMP_DIR, { recursive: true })
    const boxScript = path.join(TMP_DIR, 'box-refusal-script.json')
    writeFileSync(boxScript, JSON.stringify(BOX_SCRIPT, null, 1))

    for (const out of ['/etc/drive-out.json', '../drive-out.json']) {
      const refused = await drive('run', boxScript, '--out', out)
      expect(refused.status).toBe(1)
      expect(refused.payload.ok).toBe(false)
      expect(String(refused.payload.error)).toContain('must resolve inside')
    }
  }, 60_000)

  it('rejects a malformed script step with the step named', async () => {
    mkdirSync(TMP_DIR, { recursive: true })
    const badScript = path.join(TMP_DIR, 'bad-script.json')
    writeFileSync(badScript, JSON.stringify({ steps: [{ mutation: null }] }, null, 1))

    const run = await drive('run', badScript)
    expect(run.status).toBe(1)
    expect(run.payload.ok).toBe(false)
    expect(run.payload.error).toContain('step 0')
    expect(run.payload.error).toContain('needs a command or a mutation')
  }, 60_000)

  it('creates the export parent directory when a fresh nested path is asked for', async () => {
    mkdirSync(TMP_DIR, { recursive: true })
    const boxScript = path.join(TMP_DIR, 'parent-script.json')
    const boxDoc = path.join(TMP_DIR, 'parent.yaml')
    writeFileSync(boxScript, JSON.stringify(BOX_SCRIPT, null, 1))
    expect((await drive('run', boxScript, '--out', boxDoc)).payload.ok).toBe(true)

    const nestedDir = path.join(TMP_DIR, 'does/not/exist')
    rmSync(nestedDir, { recursive: true, force: true })
    const stepFile = path.join(nestedDir, 'part.step')
    const exported = await drive('export', boxDoc, '--format', 'step', '--out', stepFile)
    expect(exported.status).toBe(0)
    expect(exported.payload).toMatchObject({ ok: true, file: stepFile, format: 'step' })
    expect(readFileSync(stepFile).byteLength).toBe(exported.payload.bytes as number)
  }, 120_000)

  it('refuses an export out path outside the project and writes nothing', async () => {
    mkdirSync(TMP_DIR, { recursive: true })
    const boxScript = path.join(TMP_DIR, 'refused-export-script.json')
    const boxDoc = path.join(TMP_DIR, 'refused-export.yaml')
    writeFileSync(boxScript, JSON.stringify(BOX_SCRIPT, null, 1))
    expect((await drive('run', boxScript, '--out', boxDoc)).payload.ok).toBe(true)

    const out = path.join(FRONTEND_DIR, 'refused-export.step')
    rmSync(out, { force: true })
    try {
      const refused = await drive('export', boxDoc, '--format', 'step', '--out', out)
      expect(refused.status).toBe(1)
      expect(refused.payload.ok).toBe(false)
      expect(String(refused.payload.error)).toContain('must resolve inside tmp/, bugreports/')
      expect(existsSync(out)).toBe(false)
    } finally {
      rmSync(out, { force: true })
    }
  }, 120_000)

  it('writes the default export to tmp/out.step', async () => {
    mkdirSync(TMP_DIR, { recursive: true })
    const boxScript = path.join(TMP_DIR, 'default-export-script.json')
    const boxDoc = path.join(TMP_DIR, 'default-export.yaml')
    writeFileSync(boxScript, JSON.stringify(BOX_SCRIPT, null, 1))
    expect((await drive('run', boxScript, '--out', boxDoc)).payload.ok).toBe(true)

    const out = path.resolve(TMP_DIR, '../out.step')
    rmSync(out, { force: true })
    const exported = await drive('export', boxDoc, '--format', 'step')
    expect(exported.status).toBe(0)
    expect(exported.payload).toMatchObject({ ok: true, file: out, format: 'step' })
    expect(readFileSync(out).byteLength).toBe(exported.payload.bytes as number)
  }, 120_000)

  it('refuses a repro path outside the project before the script runs', async () => {
    mkdirSync(TMP_DIR, { recursive: true })
    const boxScript = path.join(TMP_DIR, 'refused-repro-script.json')
    writeFileSync(boxScript, JSON.stringify(BOX_SCRIPT, null, 1))
    const outDoc = path.join(TMP_DIR, 'refused-repro-out.yaml')
    const reproFile = path.join(FRONTEND_DIR, 'refused-repro.json')
    rmSync(outDoc, { force: true })
    rmSync(reproFile, { force: true })

    const refused = await drive('run', boxScript, '--out', outDoc, '--repro', reproFile)
    expect(refused.status).toBe(1)
    expect(refused.payload.ok).toBe(false)
    expect(String(refused.payload.error)).toContain('must resolve inside tmp/, bugreports/')
    // Resolved before the run: neither the out document nor the journal exists.
    expect(existsSync(outDoc)).toBe(false)
    expect(existsSync(reproFile)).toBe(false)
  }, 120_000)

  it('reports an export whose parent is a regular file as a clean failure', async () => {
    mkdirSync(TMP_DIR, { recursive: true })
    const boxScript = path.join(TMP_DIR, 'not-a-dir-script.json')
    const boxDoc = path.join(TMP_DIR, 'not-a-dir.yaml')
    writeFileSync(boxScript, JSON.stringify(BOX_SCRIPT, null, 1))
    expect((await drive('run', boxScript, '--out', boxDoc)).payload.ok).toBe(true)

    const notADir = path.join(TMP_DIR, 'not-a-dir')
    try {
      writeFileSync(notADir, 'not a directory\n')
      const out = path.join(notADir, 'part.step')
      const exported = await drive('export', boxDoc, '--format', 'step', '--out', out)
      expect(exported.status).toBe(1)
      expect(exported.payload.ok).toBe(false)
      expect(String(exported.payload.error)).toMatch(/EEXIST/)
    } finally {
      rmSync(notADir, { recursive: true, force: true })
    }
  }, 120_000)

  it('creates the repro parent directory when a fresh nested path is asked for', async () => {
    mkdirSync(TMP_DIR, { recursive: true })
    const boxScript = path.join(TMP_DIR, 'repro-parent-script.json')
    const boxDoc = path.join(TMP_DIR, 'repro-parent.yaml')
    const commandScript = path.join(TMP_DIR, 'repro-parent-cmd.json')
    writeFileSync(boxScript, JSON.stringify(BOX_SCRIPT, null, 1))
    writeFileSync(commandScript, JSON.stringify(COMMAND_SCRIPT, null, 1))
    expect((await drive('run', boxScript, '--out', boxDoc)).payload.ok).toBe(true)

    const nestedDir = path.join(TMP_DIR, 'repro/does/not/exist')
    rmSync(nestedDir, { recursive: true, force: true })
    const reproFile = path.join(nestedDir, 'repro.json')
    const recorded = await drive('run', commandScript, '--doc', boxDoc, '--repro', reproFile)
    expect(recorded.status).toBe(0)
    expect(recorded.payload.ok).toBe(true)
    expect((JSON.parse(readFileSync(reproFile, 'utf8')) as { kind: string }).kind).toBe('oversolved-repro')
  }, 120_000)
})
