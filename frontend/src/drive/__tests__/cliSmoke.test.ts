// @vitest-environment node
//
// End-to-end tests for the drive CLI: build a box from a mutation script
// through the real kernel, measure it, record a command journal into a repro
// and replay it; build a filleted box and measure it; edit one dimension and
// rebuild; snapshot the `commands` registry listing; export STEP and re-import
// it, matching the measures. Gated like the other Real suites: skips when
// OCC.js or the Rust node build is absent, or on a Node too old for
// --experimental-strip-types.
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
    { command: 'toggle_sketch_plane_visibility' },
  ],
}

// The 10 x 10 x 5 box with one edge filleted (radius 1). The edge alias
// `?body_ex1:edge:0` is the deterministic index the builder registers, so the
// script selects the same edge on every run.
const FILLET_SCRIPT = {
  steps: [
    ...BOX_SCRIPT.steps,
    { mutation: { type: 'add_fillet', featureId: 'f1', label: 'Fillet' } },
    { mutation: { type: 'add_fillet_edge', featureId: 'f1', edgeQuery: '?body_ex1:edge:0' } },
  ],
}

// One typed dimension change: extrude 5 -> 8, the "edit a dimension and
// rebuild" path.
const EDIT_SCRIPT = {
  steps: [
    { mutation: { type: 'set_extrude_field', featureId: 'ex1', field: 'distance', value: 8 } },
  ],
}

// Adopt a STEP file as the document's only solid; the bytes arrive through
// --file as f1.
const IMPORT_SCRIPT = {
  steps: [
    { mutation: { type: 'add_import_step', featureId: 'imp1', fileId: 'f1' } },
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

    // The canonical script executed a second time in a fresh process must
    // build the byte-identical document: the seeded id source is what makes
    // the rect's internally minted entities repeat.
    const second = drive('run', boxScript)
    expect(second.status).toBe(0)
    expect(second.payload.docHash).toBe(run.payload.docHash)

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
    // in a fresh process: every recorded hash must reproduce. The journal
    // stores the mutations the commands produced, not the commands.
    const recorded = drive('run', commandScript, '--doc', boxDoc, '--repro', reproFile)
    expect(recorded.status).toBe(0)
    expect(recorded.payload.ok).toBe(true)
    const repro = JSON.parse(readFileSync(reproFile, 'utf8')) as {
      kind: string
      journal: Array<{ kind: string; payload: { type?: string } }>
    }
    expect(repro.kind).toBe('oversolved-repro')
    expect(repro.journal).toHaveLength(2)
    expect(repro.journal.map(e => e.payload.type)).toEqual(['toggle_plane_visibility', 'toggle_sketch_plane_visibility'])

    const replayed = drive('replay', reproFile)
    expect(replayed.status).toBe(0)
    expect(replayed.payload.ok).toBe(true)
    expect(replayed.payload.finalHash).toBe(recorded.payload.docHash)
  }, 180_000)

  it('builds a filleted box and measures it, then edits the extrude distance and rebuilds', () => {
    mkdirSync(TMP_DIR, { recursive: true })
    const filletScript = path.join(TMP_DIR, 'fillet-script.json')
    const filletDoc = path.join(TMP_DIR, 'fillet.yaml')
    const boxScript = path.join(TMP_DIR, 'box2-script.json')
    const boxDoc = path.join(TMP_DIR, 'box2.yaml')
    const boxTall = path.join(TMP_DIR, 'box2-tall.yaml')
    const editScript = path.join(TMP_DIR, 'edit-script.json')
    writeFileSync(filletScript, JSON.stringify(FILLET_SCRIPT, null, 1))
    writeFileSync(boxScript, JSON.stringify(BOX_SCRIPT, null, 1))
    writeFileSync(editScript, JSON.stringify(EDIT_SCRIPT, null, 1))

    const built = drive('run', filletScript, '--out', filletDoc)
    expect(built.status).toBe(0)
    expect(built.payload.ok).toBe(true)
    expect((built.payload.solve as { lastError: string | null }).lastError).toBeNull()

    // Radius-1 fillet on one edge of the 10 x 10 x 5 box: the edge is 5 long,
    // so the volume drops by (1 - pi/4) * 5, the two removed strips outweigh
    // the added quarter cylinder in area, a seventh face appears, and the AABB
    // is unchanged.
    const fillet = drive('measure', filletDoc)
    expect(fillet.status).toBe(0)
    expect(fillet.payload).toMatchObject({ ok: true, bodyCount: 1, faces: 7 })
    expect(fillet.payload.volume as number).toBeCloseTo(500 - (1 - Math.PI / 4) * 5, 6)
    expect(fillet.payload.area as number).toBeCloseTo(397.42477796076935, 6)
    expect(fillet.payload.centroid as number[]).toHaveLength(3)
    expect(fillet.payload.bbox).toMatchObject({ min: [0, 0, 0], max: [10, 10, 5] })

    const builtBox = drive('run', boxScript, '--out', boxDoc)
    expect(builtBox.status).toBe(0)
    expect((drive('measure', boxDoc).payload.volume as number)).toBeCloseTo(500, 6)

    // Edit one dimension against the saved document and rebuild: the same
    // document (same feature ids) with the extrude distance set to 8.
    const edited = drive('run', editScript, '--doc', boxDoc, '--out', boxTall)
    expect(edited.status).toBe(0)
    expect(edited.payload.ok).toBe(true)
    const measure = drive('measure', boxTall)
    expect(measure.payload.volume as number).toBeCloseTo(800, 6)
    expect(measure.payload.bbox).toMatchObject({ min: [0, 0, 0], max: [10, 10, 8] })
    expect(measure.payload.centroid as number[]).toHaveLength(3)
  }, 180_000)

  it('lists the command registry with its params', () => {
    const run = drive('commands')
    expect(run.status).toBe(0)
    expect(run.payload.ok).toBe(true)
    const commands = run.payload.commands as Array<{ id: string; params: unknown[] }>
    expect(commands.length).toBeGreaterThan(0)
    expect(commands.every(c => Array.isArray(c.params))).toBe(true)
    // The snapshot pins every id, label, shortcut, param field and enabled
    // verdict: the registry is the public surface, so drift must be visible.
    expect(run.payload).toMatchSnapshot()
  }, 60_000)

  it('re-imports an exported STEP file and matches the measures', () => {
    mkdirSync(TMP_DIR, { recursive: true })
    const boxScript = path.join(TMP_DIR, 'box3-script.json')
    const boxDoc = path.join(TMP_DIR, 'box3.yaml')
    const stepFile = path.join(TMP_DIR, 'box3.step')
    const importScript = path.join(TMP_DIR, 'import-script.json')
    const importDoc = path.join(TMP_DIR, 'imported.yaml')
    writeFileSync(boxScript, JSON.stringify(BOX_SCRIPT, null, 1))
    writeFileSync(importScript, JSON.stringify(IMPORT_SCRIPT, null, 1))

    expect(drive('run', boxScript, '--out', boxDoc).payload.ok).toBe(true)
    const before = drive('measure', boxDoc)
    expect(drive('export', boxDoc, '--format', 'step', '--out', stepFile).status).toBe(0)

    // The import step needs the file bytes under the feature's file_id, both
    // to build the document and to measure it later.
    const fileFlag = `f1=${stepFile}`
    const built = drive('run', importScript, '--file', fileFlag, '--out', importDoc)
    expect(built.status).toBe(0)
    expect(built.payload.ok).toBe(true)

    const after = drive('measure', importDoc, '--file', fileFlag)
    expect(after.status).toBe(0)
    expect(after.payload.bodyCount).toBe(before.payload.bodyCount)
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
    expect(after.payload.bbox).toMatchObject({ min: [0, 0, 0], max: [10, 10, 5] })
  }, 180_000)
})
