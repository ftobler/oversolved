// @vitest-environment node
//
// End-to-end tests for the MCP server over its stdio protocol, through the
// real kernel: build, edit, measure and export by docHash, chain sessions,
// path handling, and the stalled-solve replies. The server is spawned once per
// test and spoken to over newline-delimited JSON-RPC. Split from cliSmoke;
// driveCliHarness.ts says why.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { docHashOf } from '@/drive/docHash'
import { DOC_HANDLE_CAPACITY } from '@/drive/docHandleStore'
import { CURRENT_DOC_VERSION, loadPartDoc } from '@/persistence/docSchema'
import type { PartDoc } from '@/types/cad'
import { HOLE_ON_LINE_SKETCH } from './featureFixtures'
import { spawnMcp, toolPayload, errorPayload } from './mcpStdioClient'
import {
  BOX_SCRIPT, EDIT_SCRIPT, SESSION_BOX_SCRIPT, TMP_DIR, driveUnavailable, expectBbox,
} from './driveCliHarness'

describe.skipIf(driveUnavailable)('MCP server (real OCC + Rust solver)', () => {
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
      expect(built.solved).toBe(true)
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

      // The same failed hole through export: the file is still written, but
      // the reply carries the real feature problem rather than an empty list.
      const holeExportFile = path.join(TMP_DIR, 'mcp-hole.step')
      const holeExport = errorPayload(await client.request('tools/call', {
        name: 'export',
        arguments: { docHash: hole.docHash, format: 'step', out: holeExportFile },
      }))
      expect(holeExport.ok).toBe(false)
      const holeExportFeatures = holeExport.features as Array<Record<string, unknown>>
      expect(holeExportFeatures).toHaveLength(1)
      expect(holeExportFeatures[0]).toMatchObject({ id: 'h1', kind: 'hole', status: 'exception' })
      expect(readFileSync(holeExportFile).byteLength).toBe(holeExport.bytes as number)

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
      // A part export carries the same features channel a run or measure has;
      // the box builds cleanly, so the list is present and empty.
      expect(exported.features).toEqual([])
      expect(exported.solve).toBeUndefined()
      expect(readFileSync(stepFile).byteLength).toBe(exported.bytes as number)

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

      // Prefixed: cliSmokePaths runs concurrently and clears its own copy.
      const nestedDir = path.join(TMP_DIR, 'mcp-does/not/exist')
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
    // Prefixed: cliSmokePaths runs concurrently and removes its own copy.
    const notADir = path.join(TMP_DIR, 'mcp-not-a-dir')
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
      expect(selected.count).toBe(4)
      const queries = selected.queries as string[]
      expect(queries).toHaveLength(4)
      const items = selected.items as Array<{ geometry: { length?: number } }>
      for (const item of items) expect(item.geometry.length).toBeCloseTo(10, 6)

      // The reply-size control through the wired tool: queries-only keeps the
      // count and the same query strings, and carries no per-item summary.
      const queriesOnly = toolPayload(await client.request('tools/call', {
        name: 'select',
        arguments: { docHash: boxHash, selector: { kind: 'edge', where: { parallel: [0, 1, 0] } }, detail: 'queries' },
      }))
      expect(queriesOnly).toMatchObject({ ok: true, docHash: boxHash, count: 4, queries })
      expect(queriesOnly.items).toBeUndefined()

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

  it('answers a stalled solve with the accepted prefix, its docHash and the out file', async () => {
    // The kernel worker's test hook spins forever when the build reaches
    // ex_stuck (bug-fuse-hang D2): the stand-in for a kernel operation that
    // never returns. The server must kill that worker and answer the call with
    // the state the accepted prefix holds, then serve the next call on a fresh
    // worker.
    const client = spawnMcp({
      // Roomy enough that the OCC load under a loaded full suite never trips
      // it before the first feature mark; the worker boot is warmed below.
      OVERSOLVED_MCP_SOLVE_BUDGET_MS: '10000',
      OVERSOLVED_MCP_TEST_HANG_FEATURE: 'ex_stuck',
    })
    try {
      await client.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'cliSmoke', version: '0' } })
      // Warm the worker first. A fresh worker's boot counts against the budget
      // and posts no checkpoint, so on a loaded runner (seen on Node 22) a cold
      // boot alone could spend the 10 s and answer with the bare timeout this
      // test is not about. Warm, the steps settle at once and the stall lands
      // in the final flush, after every checkpoint is posted.
      const warm = toolPayload(await client.request('tools/call', { name: 'run', arguments: { steps: BOX_SCRIPT.steps } }))
      expect(warm.ok).toBe(true)
      const stuckSteps = BOX_SCRIPT.steps.map(step =>
        step.mutation.type === 'add_extrude' ? { mutation: { ...step.mutation, featureId: 'ex_stuck' } } : step)
      const outFile = path.join(TMP_DIR, 'mcp-stall-prefix.yaml')
      rmSync(outFile, { force: true })
      const t0 = performance.now()
      const stuck = await client.request('tools/call', { name: 'run', arguments: { steps: stuckSteps, out: outFile } })
      expect(performance.now() - t0).toBeLessThan(60_000)
      expect(stuck.error).toBeUndefined()
      const stuckResult = errorPayload(stuck)
      expect(stuckResult.ok).toBe(false)
      // Every step applied; the run's final solve is the one that hung, so the
      // reply describes the accepted prefix rather than naming every feature
      // missing.
      expect(stuckResult.solved).toBe(true)
      expect(stuckResult.error).toBeUndefined()
      const stuckOutcomes = stuckResult.steps as Array<{
        index: number; kind: string; id: string; ok: boolean; error?: { code: string; message: string }
      }>
      expect(stuckOutcomes.map(step => step.index)).toEqual([0, 1, 2, 3])
      expect(stuckOutcomes.slice(0, 3).map(step => step.ok)).toEqual([true, true, true])
      expect(stuckOutcomes[3]).toMatchObject({
        index: 3,
        kind: 'mutation',
        id: 'final solve',
        ok: false,
        error: { code: 'solve-timeout', message: 'solve timed out after 10 s in feature ex_stuck' },
      })
      expect(typeof stuckResult.docHash).toBe('string')
      expect((stuckResult.solve as { lastError: string | null }).lastError)
        .toBe('solve timed out after 10 s in feature ex_stuck')
      expect(stuckResult.featureDeltas).toBeNull()
      expect(stuckResult.frames).toBeNull()
      expect(stuckResult.summary).toContain('bodies: not solved (final solve timed out)')
      expect(stuckResult.summary).not.toContain('refused')

      // 3D negative: the saved document is the checkpoint's (every accepted
      // step applied), never this call's empty input document. The hung
      // feature's mutation landed; only its settle is missing.
      expect(stuckResult.file).toBe(outFile)
      const saved = loadPartDoc(parseYaml(readFileSync(outFile, 'utf8')), { name: outFile })
      expect(saved.ok).toBe(true)
      if (!saved.ok) throw new Error('unreachable')
      const savedIds = (saved.doc.features ?? []).map(feature => feature.id)
      expect(savedIds).toContain('sk1')
      expect(savedIds).toContain('ex_stuck')
      expect(savedIds).not.toContain('ex1')

      const next = toolPayload(await client.request('tools/call', { name: 'run', arguments: { steps: BOX_SCRIPT.steps } }))
      expect(next.ok).toBe(true)
      expect(next.summary).toContain('body_ex1')
    } finally {
      await client.close()
    }
  }, 240_000)

  it('saves the input document when a stalled inspect applied no step', async () => {
    // din_rail: the hang hits the call's first solve (steps: []), so there is no
    // checkpoint. The input document is also the final document and is saved.
    const client = spawnMcp({
      OVERSOLVED_MCP_SOLVE_BUDGET_MS: '10000',
      OVERSOLVED_MCP_TEST_HANG_FEATURE: 'ex_stuck',
    })
    try {
      await client.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'cliSmoke', version: '0' } })
      // Build a valid document first (this server only hangs on ex_stuck), then
      // rename its extrude so the inspect call stalls in its first solve.
      const built = toolPayload(await client.request('tools/call', {
        name: 'run',
        arguments: { steps: BOX_SCRIPT.steps, returnDoc: true },
      }))
      const source = built.doc as PartDoc
      const stuckDoc = {
        ...source,
        features: (source.features ?? []).map(feature =>
          feature.id === 'ex1' ? { ...feature, id: 'ex_stuck' } : feature),
      } as PartDoc
      const inputHash = docHashOf(stuckDoc)
      const outFile = path.join(TMP_DIR, 'mcp-stall-input.yaml')
      rmSync(outFile, { force: true })

      const stalled = errorPayload(await client.request('tools/call', {
        name: 'run',
        arguments: { doc: stuckDoc, steps: [], out: outFile },
      }))
      expect(stalled.ok).toBe(false)
      expect(stalled.solved).toBe(false)
      expect(stalled.docHash).toBe(inputHash)
      expect(stalled.error).toBe('solve timed out after 10 s in feature ex_stuck')
      expect(stalled.file).toBe(outFile)
      expect(stalled.format).toBe('yaml')

      const loaded = loadPartDoc(parseYaml(readFileSync(outFile, 'utf8')), { name: outFile })
      expect(loaded.ok).toBe(true)
      if (!loaded.ok) throw new Error('unreachable')
      expect(loaded.doc).toEqual(stuckDoc)
    } finally {
      await client.close()
    }
  }, 240_000)
})
