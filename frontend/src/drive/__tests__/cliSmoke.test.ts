// @vitest-environment node
//
// End-to-end smoke for the drive CLI: build a box from a mutation script
// through the real kernel, measure it, record a command journal into a repro
// and replay it. Gated like the other Real suites: skips when OCC.js or the
// Rust node build is absent, or on a Node too old for --experimental-strip-types.
//
// The CLI is spawned as its own process (one session per process is the v1
// contract) and prints one JSON object per command; the last stdout line is
// the payload (the OCC STEP writer prints its own banner ahead of it).

import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import { loadSolver } from '@/wasm-kernel/loadSolver'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FRONTEND_DIR = path.resolve(__dirname, '../../..')
// The project-internal tmp at the worktree root; never the system /tmp.
const TMP_DIR = path.resolve(FRONTEND_DIR, '../tmp/drive-cli-smoke')

function occInstalled(): boolean {
  try {
    createRequire(import.meta.url).resolve('opencascade.js/dist/opencascade.wasm.js')
    return true
  } catch {
    return false
  }
}

const oc = occInstalled()
const solveBytes = loadSolver()
const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number)
const stripTypes = nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 6)

interface CliResult {
  status: number
  payload: Record<string, unknown>
  stdout: string
}

function drive(...args: string[]): CliResult {
  let stdout = ''
  let status = 0
  try {
    stdout = execFileSync('node', [
      '--experimental-strip-types',
      '--loader=./scripts/driveCli.loader.mjs',
      'scripts/driveCli.ts',
      ...args,
    ], { cwd: FRONTEND_DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (e) {
    const error = e as { status?: number; stdout?: string }
    stdout = error.stdout ?? ''
    status = error.status ?? 1
  }
  const lastLine = stdout.trim().split('\n').filter(Boolean).pop() ?? ''
  return { status, payload: JSON.parse(lastLine) as Record<string, unknown>, stdout }
}

const BOX_SCRIPT = {
  steps: [
    { mutation: { type: 'add_sketch', featureId: 'sk1', label: 'Rectangle', plane: '@builtin_plane_front' } },
    { mutation: { type: 'add_rect', featureId: 'sk1', p0: [0, 0], p1: [10, 10] } },
    { mutation: { type: 'add_extrude', featureId: 'ex1', label: 'Extrude', sketchQuery: '$sk1', distance: 5 } },
  ],
}

const COMMAND_SCRIPT = {
  steps: [
    { command: 'toggle_plane_visibility' },
    { command: 'undo' },
    { command: 'redo' },
  ],
}

describe.skipIf(!oc || !solveBytes || !stripTypes)('drive CLI (real OCC + Rust solver)', () => {
  it('runs a script, measures the box, exports it, records a repro and replays it', () => {
    mkdirSync(TMP_DIR, { recursive: true })
    const boxScript = path.join(TMP_DIR, 'box-script.json')
    const boxDoc = path.join(TMP_DIR, 'box.yaml')
    const commandScript = path.join(TMP_DIR, 'cmd-script.json')
    const reproFile = path.join(TMP_DIR, 'repro.json')
    const stepFile = path.join(TMP_DIR, 'box.step')
    writeFileSync(boxScript, JSON.stringify(BOX_SCRIPT, null, 1))
    writeFileSync(commandScript, JSON.stringify(COMMAND_SCRIPT, null, 1))

    const run = drive('run', boxScript, '--out', boxDoc)
    expect(run.status).toBe(0)
    expect(run.payload.ok).toBe(true)
    expect(run.payload.steps).toHaveLength(3)
    expect((run.payload.solve as { lastError: string | null }).lastError).toBeNull()

    // 10 x 10 x 5 box: 6 faces, 12 edges, 8 vertices, volume 500.
    const measure = drive('measure', boxDoc)
    expect(measure.status).toBe(0)
    expect(measure.payload).toMatchObject({ ok: true, bodyCount: 1, faces: 6, edges: 12, vertices: 8 })
    expect(measure.payload.volume as number).toBeCloseTo(500, 6)

    const exported = drive('export', boxDoc, '--format', 'step', '--out', stepFile)
    expect(exported.status).toBe(0)
    expect(exported.payload).toMatchObject({ ok: true, format: 'step' })
    expect(readFileSync(stepFile).byteLength).toBeGreaterThan(0)

    // Record a command-level journal on top of the built doc, then replay it
    // in a fresh process: every recorded hash must reproduce.
    const recorded = drive('run', commandScript, '--doc', boxDoc, '--repro', reproFile)
    expect(recorded.status).toBe(0)
    expect(recorded.payload.ok).toBe(true)
    const repro = JSON.parse(readFileSync(reproFile, 'utf8')) as { kind: string; journal: unknown[] }
    expect(repro.kind).toBe('oversolved-repro')
    expect(repro.journal).toHaveLength(3)

    const replayed = drive('replay', reproFile)
    expect(replayed.status).toBe(0)
    expect(replayed.payload.ok).toBe(true)
    expect(replayed.payload.finalHash).toBe(recorded.payload.docHash)
  }, 180_000)
})
