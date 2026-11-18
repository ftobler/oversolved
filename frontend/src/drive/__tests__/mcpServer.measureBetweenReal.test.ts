// @vitest-environment node
//
// The MCP `measure between` op over the real MCP server: one pick or pick pair,
// answered through the same pure core the viewport uses and, for a kernel cell,
// from the same build. The number is stated in the document's own unit, so an
// inch document reads its inches and not the millimetres the geometry is
// stored as internally.
//
// The pair is two whole bodies, which the table marks a clearance: 20 apart,
// then the same two bodies moved onto each other.
import { describe, it, expect } from 'vitest'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { occInstalled } from '@/kernel/occ/loadOcc'
import { spawnMcp, toolPayload, errorPayload } from './mcpStdioClient'

const oc = occInstalled()
const solveBytes = loadSolver()
const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number)
const stripTypes = nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 6)

/** Two 10 x 10 x 10 boxes; `gap` sets the second one's offset along x. */
function twoBoxes(gap: number): unknown[] {
  return [
    { mutation: { type: 'add_sketch', featureId: 'skA', label: 'Rectangle', plane: '@builtin_plane_front' } },
    { mutation: { type: 'add_rect', featureId: 'skA', p0: [0, 0], p1: [10, 10] } },
    { mutation: { type: 'add_extrude', featureId: 'exA', label: 'Extrude', sketchQuery: '$skA', distance: 10, operation: 'new' } },
    { mutation: { type: 'add_sketch', featureId: 'skB', label: 'Rectangle', plane: '@builtin_plane_front' } },
    { mutation: { type: 'add_rect', featureId: 'skB', p0: [gap, 0], p1: [gap + 10, 10] } },
    { mutation: { type: 'add_extrude', featureId: 'exB', label: 'Extrude', sketchQuery: '$skB', distance: 10, operation: 'new' } },
  ]
}

const BETWEEN = ['@body_exA', '@body_exB']

/** Two r=5 cylinders 30 apart in x, each extruded 10 along the Front normal. */
function twoCylinders(): unknown[] {
  return [
    { mutation: { type: 'add_sketch', featureId: 'skA', label: 'Circle', plane: '@builtin_plane_front' } },
    { mutation: { type: 'add_entity', featureId: 'skA', kind: 'circle', params: [0, 0, 5], entityId: 'cA' } },
    { mutation: { type: 'add_extrude', featureId: 'exA', label: 'Extrude', sketchQuery: '$skA', distance: 10, operation: 'new' } },
    { mutation: { type: 'add_sketch', featureId: 'skB', label: 'Circle', plane: '@builtin_plane_front' } },
    { mutation: { type: 'add_entity', featureId: 'skB', kind: 'circle', params: [30, 0, 5], entityId: 'cB' } },
    { mutation: { type: 'add_extrude', featureId: 'exB', label: 'Extrude', sketchQuery: '$skB', distance: 10, operation: 'new' } },
  ]
}

describe.skipIf(!oc || !solveBytes || !stripTypes)('measure between over MCP (real OCC + Rust solver)', () => {
  it('answers a clearance pair in the document unit, for mm and inch docs', async () => {
    const client = spawnMcp()
    try {
      await client.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'measureBetween', version: '0' } })

      // Millimetres: the second box starts 30 along x, so the gap is 20.
      const mm = toolPayload(await client.request('tools/call', {
        name: 'run',
        arguments: { steps: twoBoxes(30) },
      }))
      expect(mm.ok).toBe(true)
      const mmRead = toolPayload(await client.request('tools/call', {
        name: 'measure',
        arguments: { docHash: mm.docHash, between: BETWEEN },
      }))
      expect(mmRead).toMatchObject({ ok: true, length_unit: 'mm' })
      const mmRow = mmRead.between as { kind: string; value: number; points: number[][]; note?: string }
      expect(mmRow.kind).toBe('clearance')
      expect(mmRow.value).toBeCloseTo(20, 6)
      // The witness points are in the same units: one on each box's facing side.
      expect(mmRow.points).toHaveLength(2)
      expect(Math.abs(mmRow.points[0][0] - 10)).toBeLessThan(1e-6)
      expect(Math.abs(mmRow.points[1][0] - 30)).toBeLessThan(1e-6)
      expect(mmRow.note).toBeUndefined()

      // The same numbers, stated in inches: the doc's own unit.
      const inch = toolPayload(await client.request('tools/call', {
        name: 'run',
        arguments: {
          steps: [
            { mutation: { type: 'set_length_unit', unit: 'inch' } },
            ...twoBoxes(30),
          ],
        },
      }))
      expect(inch.length_unit).toBe('inch')
      const inchRead = toolPayload(await client.request('tools/call', {
        name: 'measure',
        arguments: { docHash: inch.docHash, between: BETWEEN },
      }))
      expect(inchRead).toMatchObject({ ok: true, length_unit: 'inch' })
      const inchRow = inchRead.between as { kind: string; value: number }
      expect(inchRow.kind).toBe('clearance')
      expect(inchRow.value).toBeCloseTo(20, 6)
    } finally {
      await client.close()
    }
  }, 240_000)

  it('states why a clearance is 0, and refuses an unresolvable pick', async () => {
    const client = spawnMcp()
    try {
      await client.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'measureBetween', version: '0' } })
      // The second box starts at x = 10: the two share a face.
      const touching = toolPayload(await client.request('tools/call', {
        name: 'run',
        arguments: { steps: twoBoxes(10) },
      }))
      const read = toolPayload(await client.request('tools/call', {
        name: 'measure',
        arguments: { docHash: touching.docHash, between: BETWEEN },
      }))
      const row = read.between as { kind: string; value: number; note?: string }
      expect(row.value).toBe(0)
      expect(row.note).toBe('touching')

      const refused = errorPayload(await client.request('tools/call', {
        name: 'measure',
        arguments: { docHash: touching.docHash, between: ['@body_nope', '@body_exB'] },
      }))
      expect(refused.ok).toBe(false)
      expect(String(refused.error)).toContain('measure')
    } finally {
      await client.close()
    }
  }, 240_000)

  it('returns the smart relation extras for two parallel rims', async () => {
    const client = spawnMcp()
    try {
      await client.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'measureBetween', version: '0' } })
      const run = toolPayload(await client.request('tools/call', {
        name: 'run',
        arguments: { steps: twoCylinders() },
      }))
      expect(run.ok).toBe(true)

      // One circular rim per body, named by the same query a viewport pick uses.
      const selected = toolPayload(await client.request('tools/call', {
        name: 'select',
        arguments: {
          docHash: run.docHash,
          selector: { kind: 'edge', where: { type: 'circle' } },
        },
      }))
      const items = selected.items as { query: string; part: string }[]
      const byPart = new Map<string, string>()
      for (const item of items) {
        if (!byPart.has(item.part)) byPart.set(item.part, item.query)
      }
      expect(byPart.size).toBe(2)

      const read = toolPayload(await client.request('tools/call', {
        name: 'measure',
        arguments: { docHash: run.docHash, between: [...byPart.values()] },
      }))
      expect(read.ok).toBe(true)
      const row = read.between as {
        kind: string
        label?: string
        value: number
        extra?: { kind: string; label: string; value: number }[]
      }
      // The pitch is the primary, labelled as such, with the layout relations
      // beside it: no second call for the gap or the span.
      expect(row.kind).toBe('distance')
      expect(row.label).toBe('pitch')
      expect(row.value).toBeCloseTo(30, 6)
      const labels = (row.extra ?? []).map((extra) => extra.label)
      expect(labels).toContain('center distance')
      expect(labels).toContain('min gap')
      expect(labels).toContain('max span')
      expect(labels).toContain('dx')
      const minGap = row.extra!.find((extra) => extra.label === 'min gap')!
      expect(minGap.value).toBeCloseTo(20, 6)
    } finally {
      await client.close()
    }
  }, 240_000)
})
