// @vitest-environment node
//
// The MCP stdio protocol for assemblies: build two parts, run the pin-on-plate
// script with a parts binding, measure and export the composite handle, read
// the assembly and its parts as resources, and refuse select on an assembly.
// P2 pins the stall budget naming the part.

import { describe, it, expect } from 'vitest'
import { mkdirSync, readFileSync } from 'node:fs'
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
  { mutation: { type: 'add_extrude', featureId: 'ex1', label: 'Plate', sketchQuery: '$sk1', distance: 10 } },
]

const PIN_STEPS = [
  { mutation: { type: 'add_sketch', featureId: 'sk1', label: 'Pin', plane: '@builtin_plane_front' } },
  { mutation: { type: 'add_entity', featureId: 'sk1', kind: 'circle', params: [0, 0, 5] } },
  { mutation: { type: 'add_extrude', featureId: 'ex1', label: 'Pin', sketchQuery: '$sk1', distance: 20 } },
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

      // Offset the mate by 5 along the plate normal: the pin rises from z 10 to
      // 15, and an undo in the same call returns to A1's pose.
      const moved = toolPayload(await client.request('tools/call', {
        name: 'run',
        arguments: { docHash: a1, steps: [{ mutation: { type: 'update_mate', featureId: 'm1', offset: { z: -5 } } }] },
      }))
      const movedPin = (moved.instances as Array<{ handle: string; position: number[] }>).find(i => i.handle === 'pin')!
      expect(movedPin.position[2]).toBeCloseTo(15, 3)

      const undone = toolPayload(await client.request('tools/call', {
        name: 'run',
        arguments: {
          docHash: a1,
          steps: [
            { mutation: { type: 'update_mate', featureId: 'm1', offset: { z: -5 } } },
            { command: 'undo' },
          ],
        },
      }))
      expect(undone.docHash).toBe(a1)
      const undonePin = (undone.instances as Array<{ handle: string; position: number[] }>).find(i => i.handle === 'pin')!
      expect(undonePin.position[2]).toBeCloseTo(10, 3)

      const exported = toolPayload(await client.request('tools/call', {
        name: 'export',
        arguments: { docHash: a1, format: 'step', out: stepFile },
      }))
      expect(exported).toMatchObject({ ok: true, format: 'step', docHash: a1 })
      expect(readFileSync(stepFile).byteLength).toBeGreaterThan(0)

      const refusedBody = errorPayload(await client.request('tools/call', {
        name: 'export',
        arguments: { docHash: a1, format: 'step', out: stepFile, body: 'body_ex1' },
      }))
      expect(String(refusedBody.error)).toContain('per-instance export')

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
