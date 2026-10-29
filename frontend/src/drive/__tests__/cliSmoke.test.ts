// @vitest-environment node
//
// End-to-end tests for the drive CLI and the MCP server: build a box from a
// mutation script through the real kernel, measure it, record a command
// journal into a repro and replay it; build a filleted box and measure it;
// edit one dimension and rebuild; snapshot the `commands` registry listing;
// export STEP and re-import it, matching the measures; and drive the same
// surface over the MCP stdio protocol (build, edit, measure, export). Gated
// like the other Real suites: skips when OCC.js or the Rust node build is
// absent, or on a Node too old for --experimental-strip-types.
//
// The CLI is spawned as its own process (one session per process is the v1
// contract) and prints one JSON object per command; the last stdout line is
// the payload (the OCC STEP writer prints its own banner ahead of it). The MCP
// server is spawned once and spoken to over newline-delimited JSON-RPC.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { docHashOf } from '@/drive/docHash'
import { DOC_HANDLE_CAPACITY } from '@/drive/docHandleStore'
import { CURRENT_DOC_VERSION } from '@/persistence/docSchema'
import { HOLE_ON_LINE_SKETCH } from './featureFixtures'
import { spawnMcp, toolPayload, errorPayload, FRONTEND_DIR } from './mcpStdioClient'

const execFileAsync = promisify(execFile)

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

// Asynchronous so the vitest worker's event loop stays free while the child
// solves; a synchronous spawn for a minute of OCC work starves the worker RPC.
async function drive(...args: string[]): Promise<CliResult> {
  let stdout = ''
  let status = 0
  try {
    const result = await execFileAsync('node', [
      '--experimental-strip-types',
      '--loader=./scripts/driveCli.loader.mjs',
      'scripts/driveCli.ts',
      ...args,
    ], { cwd: FRONTEND_DIR, encoding: 'utf8' })
    stdout = result.stdout
  } catch (e) {
    const error = e as { status?: number; stdout?: string }
    stdout = error.stdout ?? ''
    status = error.status ?? 1
  }
  const lastLine = stdout.trim().split('\n').filter(Boolean).pop() ?? ''
  return { status, payload: JSON.parse(lastLine) as Record<string, unknown>, stdout }
}

// AddOptimal can land a coordinate a few ulp off the analytic corner on a
// curved body (a fillet), so bboxes compare component-wise, not by identity.
function expectBbox(actual: unknown, expected: number[]): void {
  const bbox = actual as number[]
  expect(bbox).toHaveLength(expected.length)
  bbox.forEach((value, i) => expect(value).toBeCloseTo(expected[i], 9))
}

const BOX_SCRIPT = {
  steps: [
    { mutation: { type: 'add_sketch', featureId: 'sk1', label: 'Rectangle', plane: '@builtin_plane_front' } },
    { mutation: { type: 'add_rect', featureId: 'sk1', p0: [0, 0], p1: [10, 10] } },
    { mutation: { type: 'add_extrude', featureId: 'ex1', label: 'Extrude', sketchQuery: '$sk1', distance: 5 } },
  ],
}

// The first real agent session's part: a 40 x 30 sketch on Top extruded 10
// along +Y. Its four Y-parallel edges are the ones `select {parallel:[0,1,0]}`
// returns, each 10 long.
const SESSION_BOX_SCRIPT = {
  steps: [
    { mutation: { type: 'add_sketch', featureId: 'sk1', label: 'Rectangle', plane: '@builtin_plane_top' } },
    { mutation: { type: 'add_rect', featureId: 'sk1', p0: [0, 0], p1: [40, 30] } },
    { mutation: { type: 'add_extrude', featureId: 'ex1', label: 'Extrude', sketchQuery: '$sk1', distance: 10 } },
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
  it('runs a script, measures the box, exports it, records a repro and replays it', async () => {
    mkdirSync(TMP_DIR, { recursive: true })
    const boxScript = path.join(TMP_DIR, 'box-script.json')
    const boxDoc = path.join(TMP_DIR, 'box.yaml')
    const commandScript = path.join(TMP_DIR, 'cmd-script.json')
    const reproFile = path.join(TMP_DIR, 'repro.json')
    const stepFile = path.join(TMP_DIR, 'box.step')
    writeFileSync(boxScript, JSON.stringify(BOX_SCRIPT, null, 1))
    writeFileSync(commandScript, JSON.stringify(COMMAND_SCRIPT, null, 1))

    const run = await drive('run', boxScript, '--out', boxDoc)
    expect(run.status).toBe(0)
    expect(run.payload.ok).toBe(true)
    expect(run.payload.steps).toHaveLength(3)
    expect((run.payload.solve as { lastError: string | null }).lastError).toBeNull()
    // The problem list rides every run reply, empty for a clean build.
    expect(run.payload.features).toEqual([])
    // The per-feature delta makes the extrude's contribution visible without a
    // second measure: the 10 x 10 x 5 prism is the whole 500.
    const deltas = run.payload.featureDeltas as Array<{
      id: string; kind: string; status: string; volume: number; volumeDelta: number; bbox: number[]
    }>
    const extrudeDelta = deltas.find(row => row.id === 'ex1')!
    expect(extrudeDelta).toMatchObject({ kind: 'extrude', status: 'ok' })
    expect(extrudeDelta.volume).toBeCloseTo(500, 6)
    expect(extrudeDelta.volumeDelta).toBeCloseTo(500, 6)
    expectBbox(extrudeDelta.bbox, [0, 0, 0, 10, 10, 5])
    expect(deltas.find(row => row.id === 'sk1')).toMatchObject({ volumeDelta: 0 })

    // The canonical script executed a second time in a fresh process must
    // build the byte-identical document: the seeded id source is what makes
    // the rect's internally minted entities repeat.
    // The second run also exercises the relative-path rule: the CLI's cwd is
    // frontend/, so `tmp/...` must name the repo's tmp, not frontend/tmp.
    const second = await drive('run', boxScript, '--out', 'tmp/drive-cli-smoke/box.json')
    expect(second.status).toBe(0)
    expect(second.payload.docHash).toBe(run.payload.docHash)
    expect(String(second.payload.file)).toBe(path.join(TMP_DIR, 'box.json'))
    // The format follows the extension: a .json path must contain JSON, not the
    // YAML the CLI used to write for every path.
    const jsonDoc = JSON.parse(readFileSync(path.join(TMP_DIR, 'box.json'), 'utf8')) as {
      version: number
      kind: string
      features: Array<{ id: string }>
    }
    expect(jsonDoc).toMatchObject({ version: CURRENT_DOC_VERSION, kind: 'part' })
    expect(jsonDoc.features.map(feature => feature.id)).toContain('ex1')

    // 10 x 10 x 5 box: 6 faces, 12 edges, 8 vertices, volume 500.
    const measure = await drive('measure', boxDoc)
    expect(measure.status).toBe(0)
    expect(measure.payload).toMatchObject({ ok: true, bodies: 1, faces: 6, edges: 12, vertices: 8 })
    expect(measure.payload.volume as number).toBeCloseTo(500, 6)
    expect(measure.payload.features).toEqual([])
    const perBody = measure.payload.perBody as Array<{ id: string; volume: number; centroid: number[] }>
    expect(perBody).toHaveLength(1)
    expect(perBody[0].id).toBe('body_ex1')
    expect(perBody[0].volume).toBeCloseTo(500, 6)
    expect(perBody[0].centroid).toHaveLength(3)
    expectBbox(measure.payload.bbox, [0, 0, 0, 10, 10, 5])

    const exported = await drive('export', boxDoc, '--format', 'step', '--out', stepFile)
    expect(exported.status).toBe(0)
    expect(exported.payload).toMatchObject({ ok: true, format: 'step' })
    expect(readFileSync(stepFile).byteLength).toBeGreaterThan(0)

    // The other offered format: pin the binary STL container from the bytes
    // the CLI wrote (80B header, uint32 triangle count, 50B per triangle).
    const stlFile = path.join(TMP_DIR, 'box.stl')
    const stl = await drive('export', boxDoc, '--format', 'stl', '--out', stlFile)
    expect(stl.status).toBe(0)
    expect(stl.payload).toMatchObject({ ok: true, format: 'stl' })
    const stlBytes = readFileSync(stlFile)
    expect(stlBytes.byteLength).toBeGreaterThan(84)
    const triangleCount = new DataView(stlBytes.buffer, stlBytes.byteOffset, stlBytes.byteLength).getUint32(80, true)
    expect(triangleCount).toBeGreaterThan(0)
    expect(stlBytes.byteLength).toBe(84 + triangleCount * 50)

    // Record a command-level journal on top of the built doc, then replay it
    // in a fresh process: every recorded hash must reproduce. The journal
    // stores the mutations the commands produced, not the commands.
    const recorded = await drive('run', commandScript, '--doc', boxDoc, '--repro', reproFile)
    expect(recorded.status).toBe(0)
    expect(recorded.payload.ok).toBe(true)
    const repro = JSON.parse(readFileSync(reproFile, 'utf8')) as {
      kind: string
      journal: Array<{ kind: string; payload: { type?: string } }>
    }
    expect(repro.kind).toBe('oversolved-repro')
    expect(repro.journal).toHaveLength(2)
    expect(repro.journal.map(e => e.payload.type)).toEqual(['toggle_plane_visibility', 'toggle_sketch_plane_visibility'])

    const replayed = await drive('replay', reproFile)
    expect(replayed.status).toBe(0)
    expect(replayed.payload.ok).toBe(true)
    expect(replayed.payload.finalHash).toBe(recorded.payload.docHash)
  }, 180_000)

  it('builds a filleted box and measures it, then edits the extrude distance and rebuilds', async () => {
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

    const built = await drive('run', filletScript, '--out', filletDoc)
    expect(built.status).toBe(0)
    expect(built.payload.ok).toBe(true)
    expect((built.payload.solve as { lastError: string | null }).lastError).toBeNull()
    // One edge of the box is filleted, so the last feature's delta is the
    // material the fillet removed.
    const filletDelta = (built.payload.featureDeltas as Array<{ id: string; volumeDelta: number }>)
      .find(row => row.id === 'f1')
    expect(filletDelta!.volumeDelta).toBeCloseTo(-(1 - Math.PI / 4) * 5, 6)

    // Radius-1 fillet on one edge of the 10 x 10 x 5 box: the edge is 5 long,
    // so the volume drops by (1 - pi/4) * 5, the two removed strips outweigh
    // the added quarter cylinder in area, a seventh face appears, and the AABB
    // is unchanged.
    const fillet = await drive('measure', filletDoc)
    expect(fillet.status).toBe(0)
    expect(fillet.payload).toMatchObject({ ok: true, bodies: 1, faces: 7 })
    expect(fillet.payload.volume as number).toBeCloseTo(500 - (1 - Math.PI / 4) * 5, 6)
    expect(fillet.payload.area as number).toBeCloseTo(397.42477796076935, 6)
    expect(fillet.payload.centroid as number[]).toHaveLength(3)
    expectBbox(fillet.payload.bbox, [0, 0, 0, 10, 10, 5])

    const builtBox = await drive('run', boxScript, '--out', boxDoc)
    expect(builtBox.status).toBe(0)
    expect((await drive('measure', boxDoc)).payload.volume as number).toBeCloseTo(500, 6)

    // Edit one dimension against the saved document and rebuild: the same
    // document (same feature ids) with the extrude distance set to 8.
    const edited = await drive('run', editScript, '--doc', boxDoc, '--out', boxTall)
    expect(edited.status).toBe(0)
    expect(edited.payload.ok).toBe(true)
    const measure = await drive('measure', boxTall)
    expect(measure.payload.volume as number).toBeCloseTo(800, 6)
    expectBbox(measure.payload.bbox, [0, 0, 0, 10, 10, 8])
    expect(measure.payload.centroid as number[]).toHaveLength(3)
  }, 180_000)

  it('lists the command registry with its params', async () => {
    const run = await drive('commands')
    expect(run.status).toBe(0)
    expect(run.payload.ok).toBe(true)
    const commands = run.payload.commands as Array<{ id: string; params: unknown[] }>
    expect(commands.length).toBeGreaterThan(0)
    expect(commands.every(c => Array.isArray(c.params))).toBe(true)
    // The snapshot pins every id, label, shortcut, param field and enabled
    // verdict: the registry is the public surface, so drift must be visible.
    expect(run.payload).toMatchSnapshot()
  }, 60_000)

  it('reports a failed feature while ok stays true', async () => {
    mkdirSync(TMP_DIR, { recursive: true })
    const holeScript = path.join(TMP_DIR, 'hole-line-sketch.json')
    writeFileSync(holeScript, JSON.stringify({ steps: HOLE_ON_LINE_SKETCH }, null, 1))

    const run = await drive('run', holeScript)
    expect(run.status).toBe(0)
    expect(run.payload.ok).toBe(true)
    expect((run.payload.solve as { lastError: string | null }).lastError).toBeNull()
    const features = run.payload.features as Array<Record<string, unknown>>
    expect(features).toHaveLength(1)
    expect(features[0]).toMatchObject({ id: 'h1', kind: 'hole', status: 'exception' })
    expect(features[0].message).toMatch(/has no point/)
  }, 120_000)

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
})

// ─── MCP server ───

describe.skipIf(!oc || !solveBytes || !stripTypes)('MCP server (real OCC + Rust solver)', () => {
  it('builds, edits a dimension, measures and exports over stdio by docHash', async () => {
    mkdirSync(TMP_DIR, { recursive: true })
    const stepFile = path.join(TMP_DIR, 'mcp-box.step')
    const client = spawnMcp()
    try {
      const init = await client.request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'cliSmoke', version: '0' },
      })
      expect(init.result).toMatchObject({
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'oversolved-mcp' },
      })

      const list = await client.request('tools/list', {})
      const tools = (list.result as { tools: Array<{ name: string; inputSchema: unknown }> }).tools
      expect(tools.map(t => t.name).sort()).toEqual(['commands', 'compare', 'export', 'measure', 'mutations', 'run', 'select'])

      const built = toolPayload(await client.request('tools/call', {
        name: 'run',
        arguments: {
          steps: BOX_SCRIPT.steps,
          // A relative path resolves against the repo root even though the
          // server's cwd is frontend/.
          out: 'tmp/drive-cli-smoke/mcp-relative-out.json',
        },
      }))
      expect(built.ok).toBe(true)
      expect((built.solve as { lastError: string | null }).lastError).toBeNull()
      expect(built.features).toEqual([])
      expect(built.format).toBe('json')
      expect(String(built.file)).toBe(path.join(TMP_DIR, 'mcp-relative-out.json'))
      const written = JSON.parse(readFileSync(String(built.file), 'utf8')) as {
        version: number
        features: Array<{ id: string }>
      }
      expect(written).toMatchObject({ version: CURRENT_DOC_VERSION })
      expect(written.features.map(feature => feature.id)).toContain('ex1')
      // The default reply is a handle, not the document: a session of calls
      // does not re-send the part.
      expect(typeof built.docHash).toBe('string')
      expect(built.doc).toBeUndefined()
      expect(built.steps).toHaveLength(BOX_SCRIPT.steps.length)
      expect((built.steps as Array<{ ok: boolean }>).every(step => step.ok)).toBe(true)
      expect(built.summary).toContain('sk1 (sketch)')
      expect(built.summary).toContain('ex1 (extrude)')
      expect(built.summary).toContain('body_ex1')
      // The run reply carries the extrude's contribution, not just the total.
      const boxDelta = (built.featureDeltas as Array<{ id: string; volumeDelta: number }>)
        .find(row => row.id === 'ex1')
      expect(boxDelta!.volumeDelta).toBeCloseTo(500, 6)

      // The same script twice through one server process, both starting from a
      // fresh document, mints the same ids and hashes the same document: the
      // drive journal's seed is derived from the starting document.
      const again = toolPayload(await client.request('tools/call', { name: 'run', arguments: { steps: BOX_SCRIPT.steps } }))
      expect(again.docHash).toBe(built.docHash)

      // returnDoc is the explicit opt-in for a caller that wants to save or
      // hand-edit the document.
      const returned = toolPayload(await client.request('tools/call', {
        name: 'run',
        arguments: { docHash: built.docHash, steps: [], returnDoc: true },
      }))
      expect(returned.doc).toBeDefined()
      // An empty script still solves the given document: generation > 0 and
      // the feature list is the inspect answer, not a fresh-document default.
      expect((returned.solve as { generation: number }).generation).toBeGreaterThan(0)
      expect(returned.features).toEqual([])

      // A hole whose whole-sketch pick names no drill site fails in the kernel
      // while every step applied: ok stays true and features names it.
      const hole = toolPayload(await client.request('tools/call', {
        name: 'run',
        arguments: { steps: HOLE_ON_LINE_SKETCH },
      }))
      expect(hole.ok).toBe(true)
      expect((hole.solve as { lastError: string | null }).lastError).toBeNull()
      const holeFeatures = hole.features as Array<Record<string, unknown>>
      expect(holeFeatures).toHaveLength(1)
      expect(holeFeatures[0]).toMatchObject({ id: 'h1', kind: 'hole', status: 'exception' })
      expect(holeFeatures[0].message).toMatch(/has no point/)
      expect(hole.summary).toContain('problems: h1 (hole) exception:')

      const holeMeasure = toolPayload(await client.request('tools/call', {
        name: 'measure',
        arguments: { docHash: hole.docHash },
      }))
      expect(holeMeasure.features).toEqual(holeFeatures)

      // A doc passed to select is stored and its hash returned, so a later
      // call can chain on the handle without re-sending the document.
      const selectedByDoc = toolPayload(await client.request('tools/call', {
        name: 'select',
        arguments: { doc: returned.doc, selector: { kind: 'edge', where: { parallel: [0, 0, 1] } } },
      }))
      expect(selectedByDoc.docHash).toBe(docHashOf(returned.doc))
      const measuredByHandle = toolPayload(await client.request('tools/call', {
        name: 'measure',
        arguments: { docHash: selectedByDoc.docHash },
      }))
      expect(measuredByHandle.volume as number).toBeCloseTo(500, 6)
      expect(measuredByHandle.features).toEqual([])

      // Edit the extrude distance through the handle and rebuild.
      const edited = toolPayload(await client.request('tools/call', {
        name: 'run',
        arguments: { docHash: built.docHash, steps: EDIT_SCRIPT.steps },
      }))
      expect(edited.ok).toBe(true)
      expect(edited.doc).toBeUndefined()
      expect(typeof edited.docHash).toBe('string')

      const measure = toolPayload(await client.request('tools/call', {
        name: 'measure',
        arguments: { docHash: edited.docHash },
      }))
      expect(measure.volume as number).toBeCloseTo(800, 6)
      expect(measure.docHash).toBe(edited.docHash)
      const perBody = measure.perBody as Array<{ id: string; volume: number }>
      expect(perBody).toHaveLength(1)
      expect(perBody[0]).toMatchObject({ id: 'body_ex1' })
      expect(perBody[0].volume).toBeCloseTo(800, 6)
      expectBbox(measure.bbox, [0, 0, 0, 10, 10, 8])

      // Compare the same document against a reference stated from its own
      // measures: the call passes, and the rows name every measure.
      const reference = {
        source: { tool: 'cliSmoke', version: '1', file: 'inline' },
        tolerance: { rel: 1e-6, abs: 1e-6 },
        bodies: measure.bodies,
        volume: measure.volume,
        area: measure.area,
        centroid: measure.centroid,
        bbox: measure.bbox,
        faces: measure.faces,
        edges: measure.edges,
      }
      const compared = toolPayload(await client.request('tools/call', {
        name: 'compare',
        arguments: { docHash: edited.docHash, reference },
      }))
      expect(compared).toMatchObject({ ok: true, pass: true, docHash: edited.docHash })
      expect((compared.rows as Array<{ measure: string }>).map(row => row.measure))
        .toEqual(['bodies', 'volume', 'area', 'centroid', 'bbox', 'faces', 'edges'])

      // The same reference read from a project file: referencePath goes through
      // the corpus validator and may be read-only under tmp/.
      const referenceFile = path.join(TMP_DIR, 'mcp-reference.json')
      writeFileSync(referenceFile, JSON.stringify(reference, null, 1))
      const fromFile = toolPayload(await client.request('tools/call', {
        name: 'compare',
        arguments: { docHash: edited.docHash, referencePath: referenceFile },
      }))
      expect(fromFile).toMatchObject({ ok: true, pass: true, docHash: edited.docHash })
      expect((fromFile.rows as Array<{ measure: string }>).map(row => row.measure))
        .toEqual(['bodies', 'volume', 'area', 'centroid', 'bbox', 'faces', 'edges'])

      // A write outside the project's scratch areas is refused, and no file is
      // written: the entry checks the path before it runs the script.
      for (const out of ['/etc/mcp-out.json', '../mcp-out.json']) {
        const refused = await client.request('tools/call', {
          name: 'run',
          arguments: { steps: BOX_SCRIPT.steps, out },
        })
        const refusedResult = refused.result as { isError?: boolean; content: Array<{ text: string }> }
        expect(refusedResult.isError).toBe(true)
        expect((JSON.parse(refusedResult.content[0].text) as { error: string }).error).toContain('must resolve inside')
      }
      const badReference = await client.request('tools/call', {
        name: 'compare',
        arguments: { docHash: edited.docHash, referencePath: '/etc/passwd' },
      })
      const badReferenceResult = badReference.result as { isError?: boolean; content: Array<{ text: string }> }
      expect(badReferenceResult.isError).toBe(true)
      expect((JSON.parse(badReferenceResult.content[0].text) as { error: string }).error).toContain('must resolve inside')

      const exported = toolPayload(await client.request('tools/call', {
        name: 'export',
        arguments: { docHash: edited.docHash, format: 'step', out: stepFile },
      }))
      expect(exported).toMatchObject({ ok: true, format: 'step', docHash: edited.docHash })
      expect(readFileSync(stepFile).byteLength).toBeGreaterThan(0)

      // Select the four vertical edges by predicate, then fillet exactly those
      // queries: the selector output is what a click would have stored.
      const selected = toolPayload(await client.request('tools/call', {
        name: 'select',
        arguments: { docHash: edited.docHash, selector: { kind: 'edge', where: { parallel: [0, 0, 1] } } },
      }))
      expect(selected.ok).toBe(true)
      expect(selected.docHash).toBe(edited.docHash)
      const queries = selected.queries as string[]
      expect(queries).toHaveLength(4)

      const filletSteps = [
        { mutation: { type: 'add_fillet', featureId: 'fi1', label: 'Fillet' } },
        ...queries.map(edgeQuery => ({ mutation: { type: 'add_fillet_edge', featureId: 'fi1', edgeQuery } })),
        { mutation: { type: 'set_fillet_field', featureId: 'fi1', field: 'radius', value: 1 } },
      ]
      const filleted = toolPayload(await client.request('tools/call', {
        name: 'run',
        arguments: { docHash: edited.docHash, steps: filletSteps },
      }))
      expect(filleted.ok).toBe(true)

      const filletMeasure = toolPayload(await client.request('tools/call', {
        name: 'measure',
        arguments: { docHash: filleted.docHash },
      }))
      // Four radius-1 fillets on the 10x10x8 box: the four side faces stay, the
      // two caps stay and four quarter-cylinders appear.
      expect(filletMeasure.faces).toBe(10)
      expect(filletMeasure.volume as number).toBeCloseTo(800 - 4 * (1 - Math.PI / 4) * 8, 6)

      const stlFile = path.join(TMP_DIR, 'mcp-box.stl')
      const stl = toolPayload(await client.request('tools/call', {
        name: 'export',
        arguments: { docHash: edited.docHash, format: 'stl', out: stlFile },
      }))
      expect(stl).toMatchObject({ ok: true, format: 'stl' })
      expect(readFileSync(stlFile).byteLength).toBe(stl.bytes)

      // MCAD stepper F2: export's relative `out` resolves against the repo root
      // like run's, and a path outside the scratch roots is a tool error naming
      // them, not a raw JSON-RPC internal error.
      const relative = toolPayload(await client.request('tools/call', {
        name: 'export',
        arguments: { docHash: edited.docHash, format: 'step', out: 'tmp/drive-cli-smoke/mcp-relative.step' },
      }))
      expect(relative).toMatchObject({ ok: true, file: path.join(TMP_DIR, 'mcp-relative.step') })
      expect(readFileSync(path.join(TMP_DIR, 'mcp-relative.step')).byteLength).toBeGreaterThan(0)
      const outside = await client.request('tools/call', {
        name: 'export',
        arguments: { docHash: edited.docHash, format: 'step', out: 'frontend/x.step' },
      })
      expect(outside.error).toBeUndefined()
      const refused = outside.result as { isError?: boolean; content: Array<{ text: string }> }
      expect(refused.isError).toBe(true)
      expect((JSON.parse(refused.content[0].text) as { error: string }).error).toContain('tmp/, bugreports/')

      // An unknown handle is a tool failure naming the bound, not a crash.
      const unknown = await client.request('tools/call', {
        name: 'measure',
        arguments: { docHash: '0'.repeat(64) },
      })
      const unknownResult = unknown.result as { isError?: boolean; content: Array<{ text: string }> }
      expect(unknownResult.isError).toBe(true)
      expect((JSON.parse(unknownResult.content[0].text) as { error: string }).error).toContain(String(DOC_HANDLE_CAPACITY))

      // A malformed step is a named step outcome, never an internal error
      // from reading step.mutation.type.
      for (const step of [{}, { mutation: null }]) {
        const malformed = await client.request('tools/call', {
          name: 'run',
          arguments: { steps: [step] },
        })
        const malformedResult = malformed.result as { isError?: boolean; content: Array<{ text: string }> }
        expect(malformedResult.isError).toBe(true)
        const malformedPayload = JSON.parse(malformedResult.content[0].text) as {
          ok: boolean
          steps: Array<{ ok: boolean; error?: { code: string } }>
        }
        expect(malformedPayload.ok).toBe(false)
        expect(malformedPayload.steps[0]).toMatchObject({
          ok: false,
          error: { code: 'invalid-mutation' },
        })
      }
      for (const step of [{ command: 123 }, { command: '' }]) {
        const malformed = await client.request('tools/call', {
          name: 'run',
          arguments: { steps: [step] },
        })
        const malformedResult = malformed.result as { isError?: boolean; content: Array<{ text: string }> }
        expect(malformedResult.isError).toBe(true)
        const malformedPayload = JSON.parse(malformedResult.content[0].text) as {
          ok: boolean
          steps: Array<{ ok: boolean; error?: { code: string } }>
        }
        expect(malformedPayload.steps[0]).toMatchObject({ ok: false, error: { code: 'invalid-step' } })
      }

      const commands = toolPayload(await client.request('tools/call', { name: 'commands', arguments: {} }))
      expect((commands.commands as unknown[]).length).toBeGreaterThan(0)
    } finally {
      await client.close()
    }
  }, 240_000)

  it('creates the export parent directory when a fresh nested path is asked for', async () => {
    const client = spawnMcp()
    try {
      await client.request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'cliSmoke', version: '0' },
      })
      const built = toolPayload(await client.request('tools/call', {
        name: 'run',
        arguments: { steps: BOX_SCRIPT.steps },
      }))
      expect(built.ok).toBe(true)

      const nestedDir = path.join(TMP_DIR, 'does/not/exist')
      rmSync(nestedDir, { recursive: true, force: true })
      const stepFile = path.join(nestedDir, 'part.step')
      const exported = toolPayload(await client.request('tools/call', {
        name: 'export',
        arguments: { docHash: built.docHash, format: 'step', out: stepFile },
      }))
      expect(exported).toMatchObject({ ok: true, file: stepFile, format: 'step' })
      expect(readFileSync(stepFile).byteLength).toBe(exported.bytes as number)
    } finally {
      await client.close()
    }
  }, 120_000)

  it('reports an export whose parent is a regular file as a tool error', async () => {
    mkdirSync(TMP_DIR, { recursive: true })
    const client = spawnMcp()
    const notADir = path.join(TMP_DIR, 'not-a-dir')
    try {
      await client.request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'cliSmoke', version: '0' },
      })
      const built = toolPayload(await client.request('tools/call', {
        name: 'run',
        arguments: { steps: BOX_SCRIPT.steps },
      }))
      expect(built.ok).toBe(true)

      // An existing regular file cannot be the export's parent: the mkdir fails
      // inside the write's try, so the caller gets a tool error and not a raw
      // JSON-RPC internal error.
      writeFileSync(notADir, 'not a directory\n')
      const response = await client.request('tools/call', {
        name: 'export',
        arguments: { docHash: built.docHash, format: 'step', out: path.join(notADir, 'part.step') },
      })
      const failed = errorPayload(response)
      expect(failed.ok).toBe(false)
      expect(String(failed.error)).toMatch(/EEXIST/)
    } finally {
      rmSync(notADir, { recursive: true, force: true })
      await client.close()
    }
  }, 120_000)

  it('chains the first session by docHash: box, select, fillet, compare, export', async () => {
    mkdirSync(TMP_DIR, { recursive: true })
    const stepFile = path.join(TMP_DIR, 'mcp-session-box.step')
    const client = spawnMcp()
    try {
      const init = await client.request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'cliSmoke', version: '0' },
      })
      expect(init.result).toBeDefined()

      const built = toolPayload(await client.request('tools/call', {
        name: 'run',
        arguments: { steps: SESSION_BOX_SCRIPT.steps },
      }))
      expect(built.ok).toBe(true)
      const boxHash = built.docHash as string

      // World Y is up, so the four edges parallel to +Y are the 10 mm verticals
      // of this 40 x 10 x 30 block.
      const selected = toolPayload(await client.request('tools/call', {
        name: 'select',
        arguments: { docHash: boxHash, selector: { kind: 'edge', where: { parallel: [0, 1, 0] } } },
      }))
      expect(selected.ok).toBe(true)
      expect(selected.docHash).toBe(boxHash)
      const queries = selected.queries as string[]
      expect(queries).toHaveLength(4)
      const items = selected.items as Array<{ geometry: { length?: number } }>
      for (const item of items) expect(item.geometry.length).toBeCloseTo(10, 6)

      // One add_fillet call carries the whole pick set and the radius, instead
      // of one feature + four edge calls + one field call.
      const filletSteps = [
        { mutation: { type: 'add_fillet', featureId: 'fi1', label: 'Fillet', edges: queries, radius: 3 } },
      ]
      const filleted = toolPayload(await client.request('tools/call', {
        name: 'run',
        arguments: { docHash: boxHash, steps: filletSteps },
      }))
      expect(filleted.ok).toBe(true)
      const filletDelta = (filleted.featureDeltas as Array<{ id: string; volumeDelta: number }>)
        .find(row => row.id === 'fi1')
      expect(filletDelta!.volumeDelta).toBeLessThan(0)

      const measure = toolPayload(await client.request('tools/call', {
        name: 'measure',
        arguments: { docHash: filleted.docHash },
      }))
      expect(measure.volume as number).toBeCloseTo(11922.743, 3)
      expect(measure.area as number).toBeCloseTo(3733.044, 3)

      // The hand reference from the session, flat at the top level.
      const compared = toolPayload(await client.request('tools/call', {
        name: 'compare',
        arguments: {
          docHash: filleted.docHash,
          reference: {
            source: { tool: 'hand', version: '1', file: '-' },
            tolerance: { rel: 1e-4, abs: 0.01 },
            bodies: 1,
            volume: 11922.743,
            area: 3733.044,
            centroid: [20, 5, -15],
            bbox: [0, 0, -30, 40, 10, 0],
          },
        },
      }))
      expect(compared).toMatchObject({ ok: true, pass: true })

      const exported = toolPayload(await client.request('tools/call', {
        name: 'export',
        arguments: { docHash: filleted.docHash, format: 'step', out: stepFile },
      }))
      expect(exported).toMatchObject({ ok: true, format: 'step' })
      expect(readFileSync(stepFile).byteLength).toBeGreaterThan(0)
    } finally {
      await client.close()
    }
  }, 240_000)

  it('chains a second run from the first docHash without repeating its minted ids', async () => {
    const client = spawnMcp()
    try {
      await client.request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'cliSmoke', version: '0' },
      })

      // Each call opens a new sketch and draws a rect in it: the rect's lines
      // and constraints are minted inside the handler, so a repeated id sequence
      // would show up as a duplicate id in the final document.
      const rectSteps = (sketchId: string) => [
        { mutation: { type: 'add_sketch', featureId: sketchId, label: 'Rectangle', plane: '@builtin_plane_front' } },
        { mutation: { type: 'add_rect', featureId: sketchId, p0: [0, 0], p1: [10, 10] } },
      ]
      const first = toolPayload(await client.request('tools/call', {
        name: 'run',
        arguments: { steps: rectSteps('sk2') },
      }))
      expect(first.ok).toBe(true)
      const firstSteps = first.steps as Array<{ ok: boolean; createdIds: string[] }>
      expect(firstSteps).toHaveLength(2)
      expect(firstSteps.every(step => step.ok && step.createdIds.length > 0)).toBe(true)

      const second = toolPayload(await client.request('tools/call', {
        name: 'run',
        arguments: { docHash: first.docHash, steps: rectSteps('sk3') },
      }))
      expect(second.ok).toBe(true)
      const secondSteps = second.steps as Array<{ ok: boolean; createdIds: string[] }>
      expect(secondSteps).toHaveLength(2)
      expect(secondSteps.every(step => step.ok && step.createdIds.length > 0)).toBe(true)

      // The second call reports only what it touched: sk2 already existed and
      // its checkpoint did not move, so it is not repeated.
      expect((first.featureDeltas as Array<{ id: string }>).map(row => row.id)).toEqual(['sk2'])
      expect((second.featureDeltas as Array<{ id: string }>).map(row => row.id)).toEqual(['sk3'])

      // The inspection opt-in restores every clean row on a call that changes
      // nothing.
      const all = toolPayload(await client.request('tools/call', {
        name: 'run',
        arguments: { docHash: second.docHash, steps: [], featureDeltas: 'all' },
      }))
      expect((all.featureDeltas as Array<{ id: string }>).map(row => row.id)).toEqual(['sk2', 'sk3'])

      const returned = toolPayload(await client.request('tools/call', {
        name: 'run',
        arguments: { docHash: second.docHash, steps: [], returnDoc: true },
      }))
      const doc = returned.doc as {
        features: Array<{ id: string; entities?: Array<{ id: string }>; constraints?: Array<{ id: string }> }>
      }
      expect(doc.features.map(f => f.id)).toEqual(expect.arrayContaining(['sk2', 'sk3']))
      const ids = doc.features.flatMap(f => [
        f.id,
        ...(f.entities ?? []).map(e => e.id),
        ...(f.constraints ?? []).map(c => c.id),
      ])
      expect(ids.length).toBeGreaterThan(0)
      expect(new Set(ids).size).toBe(ids.length)
    } finally {
      await client.close()
    }
  }, 240_000)

  it('answers a stalled solve with a timeout naming the feature, then serves the next call', async () => {
    // The kernel worker's test hook spins forever when the build reaches
    // ex_stuck (bug-fuse-hang D2): the stand-in for a kernel operation that
    // never returns. The server must kill that worker, answer the call, and
    // build the next document on a fresh one.
    const client = spawnMcp({
      // Roomy enough that a kernel boot under a loaded full suite (counted
      // against the budget) never trips it before the first feature mark.
      OVERSOLVED_MCP_SOLVE_BUDGET_MS: '10000',
      OVERSOLVED_MCP_TEST_HANG_FEATURE: 'ex_stuck',
    })
    try {
      await client.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'cliSmoke', version: '0' } })
      const stuckSteps = BOX_SCRIPT.steps.map(step =>
        step.mutation.type === 'add_extrude' ? { mutation: { ...step.mutation, featureId: 'ex_stuck' } } : step)
      const t0 = performance.now()
      const stuck = await client.request('tools/call', { name: 'run', arguments: { steps: stuckSteps } })
      expect(performance.now() - t0).toBeLessThan(60_000)
      expect(stuck.error).toBeUndefined()
      const stuckResult = stuck.result as { content: Array<{ text: string }>; isError?: boolean }
      expect(stuckResult.isError).toBe(true)
      expect(JSON.parse(stuckResult.content[0].text)).toEqual({
        ok: false,
        error: 'solve timed out after 10 s in feature ex_stuck',
      })

      const next = toolPayload(await client.request('tools/call', { name: 'run', arguments: { steps: BOX_SCRIPT.steps } }))
      expect(next.ok).toBe(true)
      expect(next.summary).toContain('body_ex1')
    } finally {
      await client.close()
    }
  }, 240_000)
})
