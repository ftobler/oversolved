// @vitest-environment node
//
// The regression-corpus writer against the real kernel: `regressions:add` writes
// a case the loader accepts and the runner passes, refuses to overwrite it, and
// `regressions:regen` rewrites only the live-derived fields, byte-stably.
//
// The functions under test are the same ones the npm scripts call, so the test
// does not pay a second process and a second OCC heap.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadOcc } from '@/kernel/occ/loadOcc'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { loadRegressionCase, parseChecks } from '../corpus'
import { runRegressionCase } from '../run'
import { addCase, initKernel, regenCases } from '../../../scripts/regressions'

const oc = await loadOcc()
const solveBytes = loadSolver()
const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number)
const stripTypes = nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 6)
const ready = oc !== null && solveBytes !== null && stripTypes

mkdirSync(join(process.cwd(), 'tmp'), { recursive: true })
const workDir = mkdtempSync(join(process.cwd(), 'tmp', 'regressions-script-'))

// A plain cylinder: one constrained profile, one extrude, one body.
const FIXTURE = [
  'kind: part',
  'version: 3',
  'features:',
  '  - id: sk1',
  '    kind: sketch',
  '    plane: "@builtin_plane_front"',
  '    entities:',
  '      - id: c',
  '        kind: circle',
  '    initial:',
  '      c:',
  '        - 10',
  '        - 10',
  '        - 4',
  '  - id: ex1',
  '    kind: extrude',
  '    extrude:',
  '      sketch: $sk1',
  '      distance: 12',
  '      direction: normal',
  '      operation: new',
  '',
].join('\n')

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true })
  rmSync(join(workDir, 'fixture.yaml'), { force: true })
})

describe.skipIf(!ready)('regression corpus writer (real kernel)', () => {
  const sourcePath = join(workDir, 'fixture.yaml')
  const caseName = 'fixture-case'
  const caseDir = join(workDir, caseName)

  beforeAll(async () => {
    writeFileSync(sourcePath, FIXTURE)
    await initKernel()
  })

  it('add writes a case the meta-loader accepts and the real runner passes', { timeout: 120_000 }, async () => {
    const added = await addCase(sourcePath, caseName, { root: workDir, snapshot: true })
    expect(added.dir).toBe(caseDir)
    expect(existsSync(join(caseDir, 'recipe.yaml'))).toBe(true)
    expect(existsSync(join(caseDir, 'checks.json'))).toBe(true)
    expect(existsSync(join(caseDir, 'snapshot.json'))).toBe(true)

    const loaded = loadRegressionCase(caseName, workDir)
    expect(loaded.checks.origin.kind).toBe('bug_report')
    expect(loaded.checks.severity).toBe('hard')
    expect(loaded.checks.measures.bodies).toBe(1)
    expect(Object.keys(loaded.snapshot?.bodies ?? {})).toHaveLength(1)

    const run = await runRegressionCase(loaded)
    expect(run.issues).toEqual([])
    expect(run.pass).toBe(true)
  })

  it('refuses to overwrite an existing case', { timeout: 120_000 }, async () => {
    await expect(addCase(sourcePath, caseName, { root: workDir })).rejects.toThrow(/refusing to overwrite/)
  })

  it('regen rewrites measures and features, leaves provenance and tolerance, and is byte-stable', { timeout: 120_000 }, async () => {
    const checksPath = join(caseDir, 'checks.json')
    const live = parseChecks(caseName, readFileSync(checksPath, 'utf8'))
    const liveVolume = live.measures.volume as number
    // `area` is deliberately omitted: regen must keep it omitted rather than
    // silently re-freezing every live measure.
    const keptMeasures = { ...live.measures, volume: liveVolume + 1000 }
    delete keptMeasures.area
    const custom = {
      ...live,
      origin: { kind: 'fuzz' as const, ref: 'a hand-written note', date: '2026-01-02' },
      license: 'own',
      severity: 'soft' as const,
      what: 'a user-written description',
      tolerance: { rel: 1e-4, abs: 1e-4 },
      // A deliberately wrong live-derived value, to prove regen rewrites it.
      measures: keptMeasures,
      features: { default: 'ok' },
    }
    writeFileSync(checksPath, `${JSON.stringify(custom, null, 2)}\n`)

    const results = await regenCases([caseName], { root: workDir })
    expect(results).toEqual([{ name: caseName, changed: true }])

    const checksBytes = readFileSync(checksPath, 'utf8')
    const after = parseChecks(caseName, checksBytes)
    expect(after.origin).toEqual(custom.origin)
    expect(after.license).toBe(custom.license)
    expect(after.severity).toBe(custom.severity)
    expect(after.what).toBe(custom.what)
    expect(after.tolerance).toEqual(custom.tolerance)
    expect(after.measures.volume).toBeCloseTo(liveVolume, 6)
    expect(after.measures.area, 'regen must not re-freeze an omitted measure').toBeUndefined()
    // Textually, not just semantically: the user-owned blocks are untouched in
    // the rewritten file, so a later regen cannot quietly reformat them.
    for (const fragment of [
      '"origin": {\n    "kind": "fuzz",\n    "ref": "a hand-written note",\n    "date": "2026-01-02"\n  }',
      '"license": "own"',
      '"severity": "soft"',
      '"what": "a user-written description"',
      '"tolerance": {\n    "rel": 0.0001,\n    "abs": 0.0001\n  }',
    ]) {
      expect(checksBytes, fragment).toContain(fragment)
    }
    expect(checksBytes, 'omitted measure').not.toContain('"area"')
    // The regen-pinned status set is the live one, which for this fixture is
    // the sketch verdict plus extrude ok, so it matches the freshly added case.
    expect(after.features).toEqual(live.features)

    const snapshotBytes = readFileSync(join(caseDir, 'snapshot.json'), 'utf8')
    await regenCases([caseName], { root: workDir })
    expect(readFileSync(checksPath, 'utf8')).toBe(checksBytes)
    expect(readFileSync(join(caseDir, 'snapshot.json'), 'utf8')).toBe(snapshotBytes)

    // And the rewritten case still passes the runner.
    const run = await runRegressionCase(loadRegressionCase(caseName, workDir))
    expect(run.issues).toEqual([])
  })

  it('reports a snapshot-only rewrite as changed', { timeout: 120_000 }, async () => {
    const snapshotPath = join(caseDir, 'snapshot.json')
    const good = readFileSync(snapshotPath, 'utf8')
    writeFileSync(snapshotPath, `${JSON.stringify({ bodies: {} }, null, 2)}\n`)

    const results = await regenCases([caseName], { root: workDir })
    expect(results).toEqual([{ name: caseName, changed: true }])
    expect(readFileSync(snapshotPath, 'utf8')).toBe(good)
    // The checks text did not move, so the change came from the snapshot alone.
    const second = await regenCases([caseName], { root: workDir })
    expect(second).toEqual([{ name: caseName, changed: false }])
  })
})
