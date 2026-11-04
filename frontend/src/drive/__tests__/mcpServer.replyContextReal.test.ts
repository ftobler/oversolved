// @vitest-environment node
//
// The part replies' unit context over the real MCP server: an inch document
// names length_unit (and an export names file_unit: "mm"), and compare scales
// its rows into millimetres so a reference, which is millimetres by
// construction, is not off by 25.4 on every length row. The parser and reply
// builder halves are pinned without a kernel in mcpServer.test.ts and
// mcpDocRef.test.ts.

import { createRequire } from 'node:module'
import { mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { spawnMcp, toolPayload, TMP_DIR } from './mcpStdioClient'

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

// A 1 x 1 x 1 inch box: the flange-xy and socket-head-cap-screw shape, a
// document whose stored numbers are inches.
const INCH_BOX_SCRIPT = {
  steps: [
    { mutation: { type: 'set_length_unit', unit: 'inch' } },
    { mutation: { type: 'add_sketch', featureId: 'sk1', label: 'Rectangle', plane: '@builtin_plane_front' } },
    { mutation: { type: 'add_rect', featureId: 'sk1', p0: [0, 0], p1: [1, 1] } },
    { mutation: { type: 'add_extrude', featureId: 'ex1', label: 'Extrude', sketchQuery: '$sk1', distance: 1, operation: 'new' } },
  ],
}

// The same box in millimetres, the absent-field default.
const MM_BOX_SCRIPT = {
  steps: [
    { mutation: { type: 'add_sketch', featureId: 'sk1', label: 'Rectangle', plane: '@builtin_plane_front' } },
    { mutation: { type: 'add_rect', featureId: 'sk1', p0: [0, 0], p1: [10, 10] } },
    { mutation: { type: 'add_extrude', featureId: 'ex1', label: 'Extrude', sketchQuery: '$sk1', distance: 5, operation: 'new' } },
  ],
}

function scaled(value: number): number {
  return value * 25.4
}

describe.skipIf(!oc || !solveBytes || !stripTypes)('part reply units (real OCC + Rust solver)', () => {
  it('names length_unit on run and measure, and both units on export', async () => {
    const outDir = path.join(TMP_DIR, 'reply-context')
    mkdirSync(outDir, { recursive: true })
    const stepFile = path.join(outDir, 'mcp-inch-unit.step')
    const client = spawnMcp()
    try {
      await client.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'replyContext', version: '0' } })

      const inch = toolPayload(await client.request('tools/call', {
        name: 'run',
        arguments: { steps: INCH_BOX_SCRIPT.steps },
      }))
      expect(inch.ok).toBe(true)
      expect(inch.length_unit).toBe('inch')

      const inchMeasure = toolPayload(await client.request('tools/call', {
        name: 'measure',
        arguments: { docHash: inch.docHash },
      }))
      expect(inchMeasure.length_unit).toBe('inch')
      // The numbers really are inches: a 1 x 1 x 1 box measures 1, not 16387.
      expect(inchMeasure.volume as number).toBeCloseTo(1, 6)

      const plain = toolPayload(await client.request('tools/call', {
        name: 'run',
        arguments: { steps: MM_BOX_SCRIPT.steps },
      }))
      expect(plain.length_unit).toBe('mm')
      const plainMeasure = toolPayload(await client.request('tools/call', {
        name: 'measure',
        arguments: { docHash: plain.docHash },
      }))
      expect(plainMeasure.length_unit).toBe('mm')

      const exported = toolPayload(await client.request('tools/call', {
        name: 'export',
        arguments: { docHash: inch.docHash, format: 'step', out: stepFile },
      }))
      expect(exported).toMatchObject({ ok: true, length_unit: 'inch', file_unit: 'mm' })
      expect(readFileSync(stepFile).byteLength).toBe(exported.bytes as number)
    } finally {
      await client.close()
    }
  }, 240_000)

  it('compares an inch document against a millimetre reference by scaling the rows', async () => {
    const client = spawnMcp()
    try {
      await client.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'replyContext', version: '0' } })
      const inch = toolPayload(await client.request('tools/call', {
        name: 'run',
        arguments: { steps: INCH_BOX_SCRIPT.steps },
      }))
      expect(inch.length_unit).toBe('inch')

      // A 1 x 1 x 1 inch box is a 25.4 mm box: the reference states the
      // millimetre measures, as every corpus source and exporter does.
      const reference = {
        source: { tool: 'hand', version: '1', file: '-' },
        tolerance: { rel: 1e-6, abs: 1e-6 },
        bodies: 1,
        volume: 25.4 ** 3,
        area: 6 * 25.4 ** 2,
        centroid: [scaled(0.5), scaled(0.5), scaled(0.5)],
        bbox: [0, 0, 0, 25.4, 25.4, 25.4],
      }
      const compared = toolPayload(await client.request('tools/call', {
        name: 'compare',
        arguments: { docHash: inch.docHash, reference },
      }))
      expect(compared).toMatchObject({ ok: true, pass: true, length_unit: 'inch', compared_in: 'mm' })
      const rows = compared.rows as Array<{ measure: string; ours: number | number[] }>
      expect(rows.every(row => row.ours !== null)).toBe(true)
      const volume = rows.find(row => row.measure === 'volume')!
      expect(volume.ours as number).toBeCloseTo(25.4 ** 3, 6)
      const bbox = rows.find(row => row.measure === 'bbox')!
      const bboxValues = bbox.ours as number[]
      bboxValues.forEach((value, index) => expect(value).toBeCloseTo([0, 0, 0, 25.4, 25.4, 25.4][index], 9))
      // `measures` stays the document's own record, labelled by length_unit.
      const measures = compared.measures as { volume: number }
      expect(measures.volume).toBeCloseTo(1, 6)
    } finally {
      await client.close()
    }
  }, 240_000)
})
