// @vitest-environment node
//
// The MCP stdio protocol for assemblies: build two parts, run the pin-on-plate
// script with a parts binding, measure and export the composite handle, read
// the assembly and its parts as resources, and refuse select on an assembly.
// P2 pins the stall budget naming the part.

import { describe, it, expect } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { readZipTree } from '@/workspace/zipCarrier'
import { errorPayload, spawnMcp, TMP_DIR, toolPayload } from './mcpStdioClient'

const OUT_DIR = path.join(TMP_DIR, 'assembly-mcp')

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

const PLATE_STEPS = [
  { mutation: { type: 'add_sketch', featureId: 'sk1', label: 'Plate', plane: '@builtin_plane_front' } },
  { mutation: { type: 'add_rect', featureId: 'sk1', p0: [0, 0], p1: [100, 60] } },
  { mutation: { type: 'add_extrude', featureId: 'ex1', label: 'Plate', sketchQuery: '$sk1', distance: 10, operation: 'new' } },
]

const PIN_STEPS = [
  { mutation: { type: 'add_sketch', featureId: 'sk1', label: 'Pin', plane: '@builtin_plane_front' } },
  { mutation: { type: 'add_entity', featureId: 'sk1', kind: 'circle', params: [0, 0, 5] } },
  { mutation: { type: 'add_extrude', featureId: 'ex1', label: 'Pin', sketchQuery: '$sk1', distance: 20, operation: 'new' } },
]

const FLAT = (axis: [number, number, number], side: 'min' | 'max') => ({
  kind: 'face' as const,
  where: { and: [{ type: 'flatface' }, { extreme: { axis, side } }] },
})

const MATE = {
  mutation: {
    type: 'add_mate', featureId: 'm1', kind: 'fixed',
    ref_a: { part: 'plate', selector: FLAT([0, 0, 1], 'max') },
    ref_b: { part: 'pin', selector: FLAT([0, 0, 1], 'min') },
    flip: true,
  },
}

// A second fixed mate at a different offset cannot hold with m1: the pair is
// the overconstrained export case.
const CONFLICTING_MATE = {
  mutation: {
    type: 'add_mate', featureId: 'm2', kind: 'fixed',
    ref_a: { part: 'plate', selector: FLAT([0, 0, 1], 'max') },
    ref_b: { part: 'pin', selector: FLAT([0, 0, 1], 'min') },
    flip: true, offset: 10,
  },
}

const PLATE_VOLUME = 6000 * 10
const PIN_VOLUME = Math.PI * 25 * 20
const TOTAL_VOLUME = PLATE_VOLUME + PIN_VOLUME

async function initialize(client: ReturnType<typeof spawnMcp>) {
  return client.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'mcpAssembly', version: '0' },
  })
}

describe.skipIf(!oc || !solveBytes || !stripTypes)('MCP assembly protocol (real OCC + mate solver)', () => {
  it('builds parts, runs the assembly, measures, exports and serves both kinds', async () => {
    mkdirSync(OUT_DIR, { recursive: true })
    const stepFile = path.join(OUT_DIR, 'pin_plate.step')
    const zipFile = path.join(OUT_DIR, 'pin_plate.zip')
    const client = spawnMcp()
    try {
      await initialize(client)

      const list = await client.request('tools/list', {})
      const tools = (list.result as { tools: Array<{ name: string; inputSchema: { properties?: Record<string, unknown> } }> }).tools
      const runTool = tools.find(tool => tool.name === 'run')!
      expect(runTool.inputSchema.properties!.kind).toBeDefined()
      expect(runTool.inputSchema.properties!.parts).toBeDefined()

      const schema = await client.request('resources/read', { uri: 'oversolved://schema/assembly-document' })
      const schemaContents = (schema.result as { contents: Array<{ text: string }> }).contents
      expect(JSON.parse(schemaContents[0].text)).toMatchObject({ $schema: 'http://json-schema.org/draft-07/schema#' })

      const plate = toolPayload(await client.request('tools/call', { name: 'run', arguments: { steps: PLATE_STEPS } }))
      const pin = toolPayload(await client.request('tools/call', { name: 'run', arguments: { steps: PIN_STEPS } }))

      // A binding with no `kind` is refused, not dropped into an empty part.
      const stray = errorPayload(await client.request('tools/call', {
        name: 'run',
        arguments: { steps: [], parts: { plate: plate.docHash } },
      }))
      expect(stray.error).toContain('applies only to an assembly document')
      expect(typeof plate.docHash).toBe('string')
      expect(typeof pin.docHash).toBe('string')
      expect(plate.docHash).not.toBe(pin.docHash)

      const assembly = toolPayload(await client.request('tools/call', {
        name: 'run',
        arguments: {
          kind: 'assembly',
          parts: { plate: plate.docHash, pin: pin.docHash },
          steps: [
            { mutation: { type: 'add_part', handle: 'plate', part: 'plate', fixed: true } },
            { mutation: { type: 'add_part', handle: 'pin', part: 'pin', position: [30, 30, 40] } },
            MATE,
          ],
        },
      }))
      expect(assembly.ok).toBe(true)
      expect(assembly.kind).toBe('assembly')
      expect(assembly.doc).toBeUndefined()
      const a1 = assembly.docHash as string
      expect(typeof a1).toBe('string')
      expect(assembly.mates).toEqual([])
      expect((assembly.solve as { verdict: string }).verdict).toBe('fully_constrained')

      // A chained measure needs no second argument: the binding travels with
      // the composite handle.
      const measured = toolPayload(await client.request('tools/call', { name: 'measure', arguments: { docHash: a1 } }))
      expect(measured.ok).toBe(true)
      expect(measured.kind).toBe('assembly')
      expect(measured.volume as number).toBeCloseTo(TOTAL_VOLUME, 3)
      expect((measured.perBody as Array<{ id: string }>).map(body => body.id).sort()).toEqual([
        'pin/body_ex1', 'plate/body_ex1',
      ])

      // Offset the mate by 5 along the plate normal (plus convention: B at A
      // plus the offset): the pin rises from z 10 to 15, and an undo in the
      // same call returns to A1's pose.
      const moved = toolPayload(await client.request('tools/call', {
        name: 'run',
        arguments: { docHash: a1, steps: [{ mutation: { type: 'update_mate', featureId: 'm1', offset: { z: 5 } } }] },
      }))
      const movedPin = (moved.instances as Array<{ handle: string; position: number[] }>).find(i => i.handle === 'pin')!
      expect(movedPin.position[2]).toBeCloseTo(15, 3)

      const undone = toolPayload(await client.request('tools/call', {
        name: 'run',
        arguments: {
          docHash: a1,
          steps: [
            { mutation: { type: 'update_mate', featureId: 'm1', offset: { z: 5 } } },
            { command: 'undo' },
          ],
        },
      }))
      expect(undone.docHash).toBe(a1)
      const undonePin = (undone.instances as Array<{ handle: string; position: number[] }>).find(i => i.handle === 'pin')!
      expect(undonePin.position[2]).toBeCloseTo(10, 3)

      // detail "changed" lists only what the call moved: the one-field edit
      // moves the pin, and an edit that changes nothing lists no instance.
      const changed = toolPayload(await client.request('tools/call', {
        name: 'run',
        arguments: { docHash: a1, detail: 'changed', steps: [{ mutation: { type: 'update_mate', featureId: 'm1', offset: { z: 5 } } }] },
      }))
      expect(changed.stepsAccepted).toBe(1)
      expect(changed.steps).toBeUndefined()
      expect((changed.instances as Array<{ handle: string }>).map(i => i.handle)).toEqual(['pin'])
      expect(Object.keys(changed.mateFrames as object)).toEqual(['m1'])
      const quiet = toolPayload(await client.request('tools/call', {
        name: 'run',
        arguments: { docHash: a1, detail: 'changed', steps: [] },
      }))
      expect(quiet.instances).toEqual([])
      expect(quiet.mateFrames).toEqual({})
      const brief = toolPayload(await client.request('tools/call', {
        name: 'run',
        arguments: { docHash: a1, detail: 'summary', steps: [] },
      }))
      expect(brief.instances).toBeUndefined()
      expect((brief.solve as { verdict: string }).verdict).toBe('fully_constrained')
      expect(measured.perBody as Array<{ id: string }>).toHaveLength(2)
      const briefMeasure = toolPayload(await client.request('tools/call', { name: 'measure', arguments: { docHash: a1, detail: 'summary' } }))
      expect(briefMeasure.instances).toBeUndefined()
      // summary trims the per-body table, not the aggregate numbers.
      expect(briefMeasure.perBody).toBeUndefined()
      expect(briefMeasure.bodies).toBe(2)
      expect(briefMeasure.volume as number).toBeCloseTo(TOTAL_VOLUME, 3)
      const changedMeasure = toolPayload(await client.request('tools/call', { name: 'measure', arguments: { docHash: a1, detail: 'changed' } }))
      expect(changedMeasure.instances).toBeUndefined()
      expect(changedMeasure.perBody).toBeUndefined()
      expect(changedMeasure.volume as number).toBeCloseTo(TOTAL_VOLUME, 3)

      const exported = toolPayload(await client.request('tools/call', {
        name: 'export',
        arguments: { docHash: a1, format: 'step', out: stepFile },
      }))
      expect(exported).toMatchObject({ ok: true, format: 'step', docHash: a1 })
      // An assembly export carries the measure-style verdict, not just bytes:
      // a clean export has a clean solve, no mate or part problems, and the
      // poses it wrote.
      expect(exported.kind).toBe('assembly')
      expect(exported.solve).toMatchObject({ verdict: 'fully_constrained' })
      expect(exported.mates).toEqual([])
      expect(exported.parts).toEqual([])
      expect((exported.instances as Array<{ handle: string }>).map(i => i.handle).sort()).toEqual(['pin', 'plate'])
      expect(String(exported.summary)).toContain('instances: plate (plate, fixed), pin (pin)')
      expect(readFileSync(stepFile).byteLength).toBe(exported.bytes as number)

      // An export's product is the file: detail trims the verdict to the
      // problem rows, summary and file fields, and `changed` is the same reply
      // because an export has no starting document to diff against.
      const briefFile = path.join(OUT_DIR, 'pin_plate_brief.step')
      const briefExport = toolPayload(await client.request('tools/call', {
        name: 'export',
        arguments: { docHash: a1, format: 'step', out: briefFile, detail: 'summary' },
      }))
      expect(briefExport).toMatchObject({
        ok: true, kind: 'assembly', format: 'step', docHash: a1, file: briefFile,
        bytes: expect.any(Number), summary: expect.any(String),
      })
      expect(briefExport.instances).toBeUndefined()
      expect(briefExport.mateFrames).toBeUndefined()
      expect(briefExport.solve).not.toHaveProperty('mates')
      expect(briefExport.solve).not.toHaveProperty('parts')
      expect(briefExport.mates).toEqual([])
      expect(briefExport.parts).toEqual([])
      expect(readFileSync(briefFile).byteLength).toBe(briefExport.bytes as number)
      const changedFile = path.join(OUT_DIR, 'pin_plate_changed.step')
      const changedExport = toolPayload(await client.request('tools/call', {
        name: 'export',
        arguments: { docHash: a1, format: 'step', out: changedFile, detail: 'changed' },
      }))
      expect(Object.keys(changedExport).sort()).toEqual(Object.keys(briefExport).sort())
      expect(readFileSync(changedFile).byteLength).toBe(changedExport.bytes as number)

      // A part export refuses detail: the switch is assembly-only.
      const refusedDetail = errorPayload(await client.request('tools/call', {
        name: 'export',
        arguments: { docHash: plate.docHash, format: 'step', out: stepFile, detail: 'summary' },
      }))
      expect(String(refusedDetail.error)).toContain('detail applies only to assembly documents')

      const refusedBody = errorPayload(await client.request('tools/call', {
        name: 'export',
        arguments: { docHash: a1, format: 'step', out: stepFile, body: 'body_ex1' },
      }))
      expect(String(refusedBody.error)).toContain('per-instance export')

      // Two conflicting fixed mates make the solve overconstrained. The export
      // still writes the best-effort placement, but says so: ok false with the
      // verdict and the wildcard mate problem.
      const conflicted = toolPayload(await client.request('tools/call', {
        name: 'run',
        arguments: { docHash: a1, steps: [CONFLICTING_MATE] },
      }))
      expect((conflicted.solve as { verdict: string }).verdict).toBe('overconstrained')
      const conflictFile = path.join(OUT_DIR, 'pin_plate_overconstrained.step')
      const conflictExport = errorPayload(await client.request('tools/call', {
        name: 'export',
        arguments: { docHash: conflicted.docHash, format: 'step', out: conflictFile },
      }))
      expect(conflictExport.ok).toBe(false)
      expect(conflictExport.kind).toBe('assembly')
      expect((conflictExport.solve as { verdict: string }).verdict).toBe('overconstrained')
      expect(conflictExport.mates).toContainEqual(expect.objectContaining({ id: '*', status: 'overconstrained' }))
      expect(conflictExport.parts).toEqual([])
      expect(readFileSync(conflictFile).byteLength).toBeGreaterThan(0)

      // The trim keeps the export's own ok, computed from the full state: a
      // conflicting mate still makes a summary export ok false, with the file
      // written and the problem row present.
      const conflictBriefFile = path.join(OUT_DIR, 'pin_plate_overconstrained_brief.step')
      const conflictBrief = errorPayload(await client.request('tools/call', {
        name: 'export',
        arguments: { docHash: conflicted.docHash, format: 'step', out: conflictBriefFile, detail: 'summary' },
      }))
      expect(conflictBrief.ok).toBe(false)
      expect(conflictBrief.kind).toBe('assembly')
      expect(conflictBrief.instances).toBeUndefined()
      expect((conflictBrief.solve as { verdict: string }).verdict).toBe('overconstrained')
      expect(conflictBrief.mates).toContainEqual(expect.objectContaining({ id: '*', status: 'overconstrained' }))
      expect(readFileSync(conflictBriefFile).byteLength).toBeGreaterThan(0)

      const zipped = toolPayload(await client.request('tools/call', {
        name: 'run',
        arguments: { docHash: a1, steps: [], out: zipFile },
      }))
      expect(zipped).toMatchObject({ ok: true, format: 'zip' })
      const tree = await readZipTree(new Uint8Array(readFileSync(zipFile)))
      expect(Object.values(tree.manifest.entries).filter(row => row.kind === 'document')).toHaveLength(3)

      // The document resource serves the assembly plus its part hashes, and
      // each part hash reads back as a part document.
      const docRead = await client.request('resources/read', { uri: `oversolved://doc/${a1}` })
      const docContents = (docRead.result as { contents: Array<{ text: string }> }).contents
      const stored = JSON.parse(docContents[0].text) as {
        kind: string
        assembly: { kind: string }
        parts: Record<string, string>
      }
      expect(stored.kind).toBe('assembly')
      expect(stored.assembly.kind).toBe('assembly')
      expect(Object.keys(stored.parts).sort()).toEqual(['pin', 'plate'])
      for (const partHash of Object.values(stored.parts)) {
        const partRead = await client.request('resources/read', { uri: `oversolved://doc/${partHash}` })
        const partContents = (partRead.result as { contents: Array<{ text: string }> }).contents
        expect(JSON.parse(partContents[0].text)).toMatchObject({ kind: 'part' })
      }

      const refusedSelect = errorPayload(await client.request('tools/call', {
        name: 'select',
        arguments: { docHash: a1, selector: { kind: 'face' } },
      }))
      expect(String(refusedSelect.error)).toContain("select runs on a part document; pass the part's docHash")

      // featureDeltas is a part-only argument.
      const refusedDeltas = errorPayload(await client.request('tools/call', {
        name: 'run',
        arguments: { docHash: a1, steps: [], featureDeltas: 'all' },
      }))
      expect(String(refusedDeltas.error)).toContain('featureDeltas')
    } finally {
      await client.close()
    }
  }, 240_000)

  it('imports a STEP from the files map and instances, measures and exports it', async () => {
    mkdirSync(OUT_DIR, { recursive: true })
    // The checked-in STEP fixture, copied where the files-path rule allows a
    // read (tmp/); the test never touches the network.
    const stepCase = path.join(OUT_DIR, 'double_with_hole.step')
    writeFileSync(stepCase, readFileSync(new URL('../../kernel/occ/__fixtures__/double_with_hole.step', import.meta.url)))
    const exportedStep = path.join(OUT_DIR, 'step_instance.step')
    const zipFile = path.join(OUT_DIR, 'step_instance.zip')
    const files = [{ id: 'f1', path: stepCase }]
    const client = spawnMcp()
    try {
      await initialize(client)

      const assembly = toolPayload(await client.request('tools/call', {
        name: 'run',
        arguments: {
          kind: 'assembly',
          files,
          out: zipFile,
          steps: [
            { mutation: { type: 'add_step_part', handle: 'housing', file: 'f1', name: 'Housing' } },
          ],
        },
      }))
      expect(assembly.ok).toBe(true)
      expect(assembly.steps).toEqual([
        expect.objectContaining({
          id: 'add_step_part',
          ok: true,
          part: { docId: 'step_f1', name: 'Housing', fileId: 'f1' },
        }),
      ])
      expect(assembly.instances).toEqual([expect.objectContaining({ handle: 'housing', part: 'step_f1' })])
      expect(assembly.parts).toEqual([])
      // The workspace zip carries the part the run synthesized, not only the
      // binding the call started from.
      const zipped = await readZipTree(new Uint8Array(readFileSync(zipFile)))
      expect(Object.values(zipped.manifest.entries).filter(row => row.kind === 'document')).toHaveLength(2)

      // The composite handle carries the part the step bound, so measure and
      // export need only the same files map.
      const handle = assembly.docHash as string
      const measured = toolPayload(await client.request('tools/call', {
        name: 'measure',
        arguments: { docHash: handle, files },
      }))
      expect(measured.ok).toBe(true)
      expect(measured.kind).toBe('assembly')
      expect(measured.bodies).toBe(1)
      expect(measured.volume as number).toBeGreaterThan(0)

      const exported = toolPayload(await client.request('tools/call', {
        name: 'export',
        arguments: { docHash: handle, format: 'step', out: exportedStep, files },
      }))
      expect(exported).toMatchObject({ ok: true, kind: 'assembly', format: 'step', docHash: handle })
      expect(exported.bytes as number).toBeGreaterThan(0)
      expect(readFileSync(exportedStep).byteLength).toBe(exported.bytes as number)
    } finally {
      await client.close()
    }
  }, 240_000)

  it('names the part in a stalled assembly bundle build, then serves the next call', async () => {
    mkdirSync(OUT_DIR, { recursive: true })
    // Build both part documents on a healthy server, then hand them inline to
    // the stalling one: a part run with ex_stuck would stall on its own.
    const healthy = spawnMcp()
    let plateDoc: unknown
    let pinDoc: unknown
    try {
      await initialize(healthy)
      const plate = toolPayload(await healthy.request('tools/call', { name: 'run', arguments: { steps: PLATE_STEPS, returnDoc: true } }))
      const pin = toolPayload(await healthy.request('tools/call', { name: 'run', arguments: { steps: PIN_STEPS, returnDoc: true } }))
      plateDoc = plate.doc
      pinDoc = pin.doc
    } finally {
      await healthy.close()
    }
    // Mark the plate's extrude as the stalling feature.
    const stuckPlate = structuredClone(plateDoc) as { features: Array<{ id: string; kind: string }> }
    const extrude = stuckPlate.features.find(feature => feature.kind === 'extrude')!
    extrude.id = 'ex_stuck'

    const stalling = spawnMcp({
      OVERSOLVED_MCP_SOLVE_BUDGET_MS: '10000',
      OVERSOLVED_MCP_TEST_HANG_FEATURE: 'ex_stuck',
    })
    try {
      await initialize(stalling)
      const failed = errorPayload(await stalling.request('tools/call', {
        name: 'run',
        arguments: {
          kind: 'assembly',
          parts: { plate: { doc: stuckPlate }, pin: { doc: pinDoc } },
          steps: [
            { mutation: { type: 'add_part', handle: 'plate', part: 'plate', fixed: true } },
            { mutation: { type: 'add_part', handle: 'pin', part: 'pin', position: [30, 30, 40] } },
          ],
        },
      }))
      expect(String(failed.error)).toContain('part plate')
      // The next call is served by a fresh worker.
      const next = toolPayload(await stalling.request('tools/call', { name: 'commands', arguments: {} }))
      expect(next.ok).toBe(true)
    } finally {
      await stalling.close()
    }
  }, 240_000)
})
