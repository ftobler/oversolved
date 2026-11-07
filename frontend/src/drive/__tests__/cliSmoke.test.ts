// @vitest-environment node
//
// End-to-end tests for the drive CLI: build a box from a mutation script
// through the real kernel, measure it, record a command journal into a repro
// and replay it; build a filleted box and measure it; edit one dimension and
// rebuild; snapshot the `commands` registry listing. The path handling, the
// STEP and measure round trips and the MCP server live in cliSmokePaths,
// cliSmokeMeasure and mcpSmoke; driveCliHarness.ts says why they are split.
//
// The CLI is spawned as its own process (one session per process is the v1
// contract) and prints one JSON object per command; the last stdout line is
// the payload (the OCC STEP writer prints its own banner ahead of it).

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { CURRENT_DOC_VERSION } from '@/persistence/docSchema'
import {
  BOX_SCRIPT, COMMAND_SCRIPT, EDIT_SCRIPT, FILLET_SCRIPT, RESOLVED_WARNING_SCRIPT, TMP_DIR,
  drive, driveUnavailable, expectBbox,
} from './driveCliHarness'

describe.skipIf(driveUnavailable)('drive CLI (real OCC + Rust solver)', () => {
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
    // The CLI prints the same state flag the MCP reply carries.
    expect(run.payload.solved).toBe(true)
    expect(run.payload.steps).toHaveLength(3)
    expect((run.payload.solve as { lastError: string | null }).lastError).toBeNull()
    // The problem list rides every run reply, empty for a clean build.
    expect(run.payload.features).toEqual([])
    // A document with no length_unit is millimetres, named explicitly.
    expect(run.payload.length_unit).toBe('mm')
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

  it('prints the informational notes a run and a measure carry', async () => {
    mkdirSync(TMP_DIR, { recursive: true })
    const script = path.join(TMP_DIR, 'resolved-warning-script.json')
    const doc = path.join(TMP_DIR, 'resolved-warning.yaml')
    writeFileSync(script, JSON.stringify(RESOLVED_WARNING_SCRIPT, null, 1))

    const run = await drive('run', script, '--out', doc)
    expect(run.status).toBe(0)
    expect(run.payload.ok).toBe(true)
    expect(run.payload.features).toEqual([])
    expect(run.payload.notes).toEqual([{
      ids: ['ex4'],
      text: 'extrude: the new solid also touches body_ex2, body_ex3; add a boolean union to fuse it',
    }])

    // The measure printer builds its own reply record, so it carries the note
    // too: the resolved warning is visible without re-running the script.
    const measure = await drive('measure', doc)
    expect(measure.status).toBe(0)
    expect(measure.payload.notes).toEqual(run.payload.notes)
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
})
