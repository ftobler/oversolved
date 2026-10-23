// @vitest-environment node
//
// The MCP server protocol: initialize, tools/list, tools/call and the framing
// around them (parse errors, notifications, unknown methods), driven through
// fake ops so no kernel is needed. The real tools are pinned by the MCP e2e
// suite in cliSmoke.test.ts.

import { describe, it, expect } from 'vitest'
import Ajv from 'ajv'
import { createMcpServer, MCP_TOOLS, type McpCadOps, type McpToolPayload } from '../mcpServer'
import { MUTATION_CATALOG_URI } from '../mutationCatalogPayload'
import { REFERENCE_FRAME_SENTENCE, worldFrameSentence } from '../worldFrame'

type FakeOps = {
  calls: Array<{ tool: string; args: unknown }>
  ops: McpCadOps
}

function fakeOps(answer: (tool: string, args: unknown) => McpToolPayload = () => ({ ok: true })): FakeOps {
  const calls: Array<{ tool: string; args: unknown }> = []
  const record = (tool: string) => async (args: unknown): Promise<McpToolPayload> => {
    calls.push({ tool, args })
    return answer(tool, args)
  }
  return {
    calls,
    ops: {
      commands: async () => { calls.push({ tool: 'commands', args: undefined }); return answer('commands', undefined) },
      run: record('run') as McpCadOps['run'],
      measure: record('measure') as McpCadOps['measure'],
      compare: record('compare') as McpCadOps['compare'],
      export: record('export') as McpCadOps['export'],
      partDocSchema: () => '{"title":"Oversolved part document"}',
      select: record('select') as McpCadOps['select'],
      documentText: (docHash: string) => (docHash === 'known' ? '{"version":1}' : null),
    },
  }
}

function request(server: ReturnType<typeof createMcpServer>, id: number, method: string, params?: unknown) {
  return server.handle({ jsonrpc: '2.0', id, method, ...(params !== undefined && { params }) })
}

function expectError(response: Awaited<ReturnType<ReturnType<typeof createMcpServer>['handle']>>, code: number) {
  expect(response).toMatchObject({ jsonrpc: '2.0', error: { code } })
}

describe('createMcpServer', () => {
  it('answers initialize with the negotiated version, capabilities and server info', async () => {
    const server = createMcpServer(fakeOps().ops)
    const response = await request(server, 1, 'initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    })
    expect(response).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'oversolved-mcp' },
      },
    })
    const instructions = (response as { result: { instructions: string } }).result.instructions
    expect(instructions).toContain('compare')
    // The frame sentence is generated from BUILTIN_PLANES, so compare the
    // served text with the generator rather than a hand-typed copy.
    expect(instructions).toContain(worldFrameSentence())
  })

  it('falls back to the oldest known version for an unknown one', async () => {
    const server = createMcpServer(fakeOps().ops)
    const response = await request(server, 1, 'initialize', { protocolVersion: '1999-01-01' })
    expect((response as { result: { protocolVersion: string } }).result.protocolVersion).toBe('2024-11-05')
  })

  it('lists the tools with their schemas, and nothing else', async () => {
    const server = createMcpServer(fakeOps().ops)
    const response = await request(server, 2, 'tools/list', {})
    const tools = (response as { result: { tools: typeof MCP_TOOLS } }).result.tools
    expect(tools.map(t => t.name).sort()).toEqual(['commands', 'compare', 'export', 'measure', 'mutations', 'run', 'select'])
    for (const tool of tools) expect(tool.inputSchema).toMatchObject({ type: 'object' })
  })

  it('advertises a select schema whose refs compile and rejects unknown predicates', () => {
    const tool = MCP_TOOLS.find(t => t.name === 'select')
    expect(tool).toBeDefined()
    // Compiling resolves every $ref against the inputSchema root; a dangling one
    // (the definitions nested under properties.selector) throws here.
    const validate = new Ajv().compile(tool!.inputSchema)
    const call = (selector: unknown) => validate({ doc: {}, selector })
    expect(call({ kind: 'edge', where: { parallel: [0, 0, 1] } })).toBe(true)
    // Nested refs (and/or/not/on_face) resolve through the same hoisted $defs.
    expect(call({ kind: 'edge', where: { and: [{ parallel: [0, 0, 1] }, { not: { on_face: { kind: 'face' } } }] } })).toBe(true)
    // An unknown predicate fails additionalProperties on the predicate def.
    expect(call({ kind: 'edge', where: { frobnicate: [0, 0, 1] } })).toBe(false)
    // An extreme axis accepts the letter sugar as well as the vector.
    expect(call({ kind: 'face', where: { extreme: { axis: 'y', side: 'max' } } })).toBe(true)
    expect(call({ kind: 'face', where: { extreme: { axis: [0, 1, 0], side: 'max' } } })).toBe(true)
    expect(call({ kind: 'face', where: { extreme: { axis: 'up', side: 'max' } } })).toBe(false)
    // The schema leaves the one-key rule to validateSelector, which names
    // `and`; capping maxProperties here made the client report only "at most
    // 1 entry" and hid that guidance.
    expect(call({ kind: 'edge', where: { parallel: [0, 0, 1], type: 'line' } })).toBe(true)
    // The `type` description lists the real vocabulary, derived from the same
    // tables the engine reads, so `plane` is not advertised as an alias.
    const schemaText = JSON.stringify(tool!.inputSchema)
    expect(schemaText).toContain('flatface')
    expect(schemaText).toContain('cylinderface')
  })

  it('calls a tool and returns its payload as text content', async () => {
    const { ops, calls } = fakeOps(() => ({ ok: true, value: 7 }))
    const server = createMcpServer(ops)
    const response = await request(server, 3, 'tools/call', { name: 'measure', arguments: { doc: { features: [] } } })
    expect(response).toMatchObject({ jsonrpc: '2.0', id: 3 })
    const result = (response as { result: { content: Array<{ type: string; text: string }>; isError?: boolean } }).result
    expect(result.isError).toBeUndefined()
    expect(JSON.parse(result.content[0].text)).toMatchObject({ ok: true, value: 7 })
    expect(calls).toEqual([{ tool: 'measure', args: { doc: { features: [] }, files: [] } }])
  })

  it('marks a tool payload with ok false as an error result', async () => {
    const server = createMcpServer(fakeOps(() => ({ ok: false, error: 'no solid' })).ops)
    const response = await request(server, 4, 'tools/call', { name: 'export', arguments: { doc: {}, format: 'step', out: 'x.step' } })
    const result = (response as { result: { isError?: boolean; content: Array<{ text: string }> } }).result
    expect(result.isError).toBe(true)
    expect(JSON.parse(result.content[0].text)).toMatchObject({ ok: false, error: 'no solid' })
  })

  it('rejects unknown tools and malformed arguments as invalid params', async () => {
    const server = createMcpServer(fakeOps().ops)
    expectError(await request(server, 5, 'tools/call', { name: 'nope', arguments: {} }), -32602)
    expectError(await request(server, 6, 'tools/call', { name: 'run', arguments: {} }), -32602)
    expectError(await request(server, 7, 'tools/call', { name: 'run', arguments: { steps: [], typo: 1 } }), -32602)
    expectError(await request(server, 8, 'tools/call', { name: 'export', arguments: { doc: {}, format: 'iges', out: 'x' } }), -32602)
    expectError(await request(server, 9, 'tools/call', { name: 'measure', arguments: { doc: {}, files: [{ id: 'f1' }] } }), -32602)
    expectError(await request(server, 16, 'tools/call', { name: 'commands', arguments: { typo: 1 } }), -32602)
  })

  it('reports unknown methods, parse errors and ops bugs without dying', async () => {
    const { ops } = fakeOps()
    const server = createMcpServer({
      ...ops,
      measure: async () => { throw new Error('kernel exploded') },
    })
    expectError(await request(server, 10, 'prompts/list'), -32601)
    const parseError = await server.handleLine('not json')
    expect(JSON.parse(parseError!)).toMatchObject({ id: null, error: { code: -32700 } })
    expectError(await request(server, 11, 'tools/call', { name: 'measure', arguments: { doc: {} } }), -32603)
    // Still serving after the bug.
    const ok = await request(server, 12, 'tools/call', { name: 'run', arguments: { steps: [] } })
    expect(ok).toMatchObject({ id: 12 })
  })

  it('advertises the part-document schema as a resource and serves it', async () => {
    const server = createMcpServer(fakeOps().ops)
    const list = await request(server, 17, 'resources/list', {})
    expect(list).toMatchObject({ id: 17 })
    const resources = (list as { result: { resources: unknown[] } }).result.resources
    expect(resources).toEqual(expect.arrayContaining([
      expect.objectContaining({ uri: 'oversolved://schema/part-document', mimeType: 'application/schema+json' }),
    ]))
    const read = await request(server, 18, 'resources/read', { uri: 'oversolved://schema/part-document' })
    const contents = (read as { result: { contents: Array<{ uri: string; mimeType: string; text: string }> } }).result.contents
    expect(contents[0].mimeType).toBe('application/schema+json')
    expect(JSON.parse(contents[0].text)).toMatchObject({ title: 'Oversolved part document' })
    expectError(await request(server, 19, 'resources/read', { uri: 'oversolved://nope' }), -32602)
    expectError(await request(server, 20, 'resources/read', {}), -32602)
  })

  it('serves a stored document by docHash as a resource template, without listing every hash', async () => {
    const server = createMcpServer(fakeOps().ops)
    const templates = await request(server, 30, 'resources/templates/list', {})
    expect(templates).toMatchObject({
      result: {
        resourceTemplates: [expect.objectContaining({ uriTemplate: 'oversolved://doc/{docHash}', mimeType: 'application/json' })],
      },
    })
    // A hash is a document, not an advertised static resource.
    const list = await request(server, 31, 'resources/list', {})
    const uris = (list as { result: { resources: Array<{ uri: string }> } }).result.resources.map(r => r.uri)
    expect(uris).not.toContain('oversolved://doc/known')

    const read = await request(server, 32, 'resources/read', { uri: 'oversolved://doc/known' })
    const contents = (read as { result: { contents: Array<{ uri: string; mimeType: string; text: string }> } }).result.contents
    expect(contents[0]).toMatchObject({ uri: 'oversolved://doc/known', mimeType: 'application/json' })
    expect(JSON.parse(contents[0].text)).toEqual({ version: 1 })

    const unknown = await request(server, 33, 'resources/read', { uri: 'oversolved://doc/gone' })
    expect(unknown).toMatchObject({ error: { code: -32602 } })
    expect((unknown as { error: { message: string } }).error.message).toContain('32')
    expectError(await request(server, 34, 'resources/read', { uri: 'oversolved://doc/' }), -32602)
  })

  it('serves the mutation catalog as a tool and as the same resource', async () => {    const server = createMcpServer(fakeOps().ops)
    const tool = MCP_TOOLS.find(t => t.name === 'mutations')
    expect(tool).toBeDefined()
    expect(tool!.inputSchema).toEqual({ type: 'object', properties: {}, additionalProperties: false })
    expectError(await request(server, 41, 'tools/call', { name: 'mutations', arguments: { typo: 1 } }), -32602)

    const call = await request(server, 42, 'tools/call', { name: 'mutations', arguments: {} })
    const text = (call as { result: { content: Array<{ text: string }> } }).result.content[0].text
    const payload = JSON.parse(text) as {
      families: Record<string, Array<{ type: string; summary: string; fields: unknown }>>
      examples: Array<{ name: string; steps: unknown[] }>
    }
    expect(payload.examples.map(example => example.name)).toEqual(['box', 'filleted-box'])
    expect(payload.families.sketch.some(entry => entry.type === 'add_sketch')).toBe(true)
    expect(payload.families.features.some(entry => entry.type === 'add_fillet')).toBe(true)

    const list = await request(server, 43, 'resources/list', {})
    const resources = (list as { result: { resources: unknown[] } }).result.resources
    expect(resources).toEqual(expect.arrayContaining([
      expect.objectContaining({ uri: MUTATION_CATALOG_URI, mimeType: 'application/json' }),
    ]))
    const read = await request(server, 44, 'resources/read', { uri: MUTATION_CATALOG_URI })
    const contents = (read as { result: { contents: Array<{ uri: string; mimeType: string; text: string }> } }).result.contents
    expect(contents[0].mimeType).toBe('application/json')
    // The resource and the tool are one JSON source, not two hand-kept copies;
    // the tool adds only the Result `ok` wrapper.
    const { ok: _ok, ...catalog } = payload as unknown as { ok: boolean } & Record<string, unknown>
    expect(JSON.parse(contents[0].text)).toEqual(catalog)
  })

  it('announces the resources capability and answers nothing to a resource notification', async () => {
    const server = createMcpServer(fakeOps().ops)
    const init = await request(server, 21, 'initialize', {})
    expect((init as { result: { capabilities: Record<string, unknown> } }).result.capabilities).toMatchObject({ resources: {} })
    expect(await server.handle({ jsonrpc: '2.0', method: 'resources/list' })).toBeNull()
  })

  it('answers nothing to notifications and to messages that are not requests', async () => {
    const server = createMcpServer(fakeOps().ops)
    expect(await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull()
    expect(await server.handle({ jsonrpc: '2.0', method: 'tools/list' })).toBeNull()
    expect(await server.handle({ jsonrpc: '2.0', id: 1, result: {} })).toBeNull()
    expect(await server.handleLine(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }))).toBeNull()
  })

  it('answers ping and rejects a method-less request that carries an id', async () => {
    const server = createMcpServer(fakeOps().ops)
    expect(await request(server, 13, 'ping')).toMatchObject({ id: 13, result: {} })
    expectError(await server.handle({ jsonrpc: '2.0', id: 14 }), -32600)
  })

  it('validates file entries before they reach the ops', async () => {
    const { ops, calls } = fakeOps()
    const server = createMcpServer(ops)
    const response = await request(server, 15, 'tools/call', {
      name: 'measure',
      arguments: { doc: {}, files: [{ id: 'f1', path: 'box.step' }] },
    })
    expect(response).toMatchObject({ id: 15 })
    expect(calls[0].args).toMatchObject({ files: [{ id: 'f1', path: 'box.step' }] })
  })

  it('validates the select selector and rejects unknown predicates', async () => {
    const { ops, calls } = fakeOps()
    const server = createMcpServer(ops)

    // A well-formed selector is validated and reaches the op.
    const ok = await request(server, 20, 'tools/call', {
      name: 'select',
      arguments: { doc: {}, selector: { kind: 'edge', where: { parallel: [0, 0, 1] } } },
    })
    expect(ok).toMatchObject({ id: 20 })
    expect(calls[0]).toEqual({ tool: 'select', args: expect.objectContaining({ selector: { kind: 'edge', where: { parallel: [0, 0, 1] } } }) })

    // An unknown predicate key is rejected by name, before the op runs.
    expectError(await request(server, 21, 'tools/call', {
      name: 'select',
      arguments: { doc: {}, selector: { kind: 'edge', where: { frobnicate: [0, 0, 1] } } },
    }), -32602)
    expectError(await request(server, 22, 'tools/call', { name: 'select', arguments: { doc: {} } }), -32602)
    expectError(await request(server, 23, 'tools/call', {
      name: 'select',
      arguments: { doc: {}, selector: { kind: 'vertex' } },
    }), -32602)

    // Two side-by-side predicate keys reach validateSelector (the schema does
    // not cap the object), so the error can name `and` and show the wrap.
    const twoKeys = await request(server, 26, 'tools/call', {
      name: 'select',
      arguments: { doc: {}, selector: { kind: 'face', where: { type: 'flatface', extreme: { axis: 'y', side: 'max' } } } },
    })
    expectError(twoKeys, -32602)
    expect((twoKeys as { error: { message: string } }).error.message).toContain('wrap several keys in "and"')
    expect((twoKeys as { error: { message: string } }).error.message).toContain('{"and":[{"type":"line"}')

    // A wrong type name is invalid params with the vocabulary and a hint, not a
    // tool call that runs and matches nothing.
    const wrongType = await request(server, 24, 'tools/call', {
      name: 'select',
      arguments: { doc: {}, selector: { kind: 'face', where: { type: 'plane' } } },
    })
    expectError(wrongType, -32602)
    expect((wrongType as { error: { message: string } }).error.message).toContain('did you mean "flatface"')

    // The letter axis sugar reaches the op as a vector.
    const sugar = await request(server, 25, 'tools/call', {
      name: 'select',
      arguments: { doc: {}, selector: { kind: 'face', where: { extreme: { axis: 'y', side: 'max' } } } },
    })
    expect(sugar).toMatchObject({ id: 25 })
    expect(calls.at(-1)).toEqual({
      tool: 'select',
      args: expect.objectContaining({
        selector: { kind: 'face', where: { extreme: { axis: [0, 1, 0], side: 'max' } } },
      }),
    })
  })

  it('validates a compare reference through the corpus parser and passes it to the op', async () => {
    const { ops, calls } = fakeOps()
    const server = createMcpServer(ops)
    const reference = {
      source: { tool: 'test', version: '1', file: 'source.md' },
      tolerance: { rel: 1e-5, abs: 1e-6 },
      bodies: 1,
      volume: 10,
      area: 20,
      centroid: [0, 0, 0],
      bbox: [0, 0, 0, 1, 1, 1],
    }

    const ok = await request(server, 24, 'tools/call', {
      name: 'compare',
      arguments: { doc: { features: [] }, reference },
    })
    expect(ok).toMatchObject({ id: 24 })
    expect(calls[0]).toEqual({
      tool: 'compare',
      args: expect.objectContaining({
        reference: expect.objectContaining({ tolerance: { rel: 1e-5, abs: 1e-6 }, topology: 'report' }),
      }),
    })
  })

  it('describes the flat reference shape and the select frame from one generator', () => {
    const compare = MCP_TOOLS.find(t => t.name === 'compare')
    const reference = (compare!.inputSchema.properties as Record<string, { description: string }>).reference
    expect(reference.description).toContain('"bodies":1')
    expect(reference.description).toContain('not nested under "measures"')
    expect(reference.description).toContain('area, centroid and bbox are required')
    expect(reference.description).toContain('cadqueryReference.py')
    expect(compare!.description).toContain(REFERENCE_FRAME_SENTENCE)

    const select = MCP_TOOLS.find(t => t.name === 'select')
    expect(select!.description).toContain(worldFrameSentence())
  })

  it('names the nested-measures mistake when a compare reference carries one', async () => {
    const server = createMcpServer(fakeOps().ops)
    const response = await request(server, 29, 'tools/call', {
      name: 'compare',
      arguments: {
        doc: {},
        reference: {
          source: { tool: 'test', version: '1', file: 'source.md' },
          tolerance: { rel: 1e-5, abs: 1e-6 },
          measures: { bodies: 1, volume: 10, area: 20, centroid: [0, 0, 0], bbox: [0, 0, 0, 1, 1, 1] },
        },
      },
    })
    expect(response).toMatchObject({ error: { code: -32602 } })
    expect((response as { error: { message: string } }).error.message).toMatch(/top level/)
  })

  it('rejects a malformed compare reference as invalid params', async () => {
    const server = createMcpServer(fakeOps().ops)
    const base = {
      source: { tool: 'test', version: '1', file: 'source.md' },
      tolerance: { rel: 1e-5, abs: 1e-6 },
      bodies: 1,
      volume: 10,
      area: 20,
      centroid: [0, 0, 0],
      bbox: [0, 0, 0, 1, 1, 1],
    }
    const noTolerance = { ...base } as Record<string, unknown>
    delete noTolerance.tolerance
    expectError(await request(server, 25, 'tools/call', {
      name: 'compare',
      arguments: { doc: {}, reference: noTolerance },
    }), -32602)
    expectError(await request(server, 26, 'tools/call', {
      name: 'compare',
      arguments: { doc: {}, reference: { ...base, bbox: [0, 0, 0, 1, 1] } },
    }), -32602)
    expectError(await request(server, 27, 'tools/call', { name: 'compare', arguments: { doc: {} } }), -32602)
  })

  it('requires exactly one of doc or docHash, except run which may start fresh', async () => {
    const { ops, calls } = fakeOps()
    const server = createMcpServer(ops)
    const reference = {
      source: { tool: 'test', version: '1', file: 'source.md' },
      tolerance: { rel: 1e-5, abs: 1e-6 },
      bodies: 1,
      volume: 10,
      area: 20,
      centroid: [0, 0, 0],
      bbox: [0, 0, 0, 1, 1, 1],
    }
    const docTools: Array<[string, Record<string, unknown>]> = [
      ['measure', {}],
      ['compare', { reference }],
      ['export', { format: 'step', out: 'x.step' }],
      ['select', { selector: { kind: 'edge' } }],
    ]
    let id = 50
    for (const [name, extra] of docTools) {
      // Neither: the tool has no document to act on.
      expectError(await request(server, id++, 'tools/call', { name, arguments: { ...extra } }), -32602)
      // Both: ambiguous, even when the two would name the same document.
      expectError(await request(server, id++, 'tools/call', {
        name,
        arguments: { ...extra, doc: {}, docHash: 'abc' },
      }), -32602)
    }

    // A single docHash reaches the op, so a caller can chain without the doc.
    const measure = await request(server, 60, 'tools/call', {
      name: 'measure',
      arguments: { docHash: 'abc' },
    })
    expect(measure).toMatchObject({ id: 60 })
    expect(calls.at(-1)).toEqual({ tool: 'measure', args: { docHash: 'abc', files: [] } })

    // run starts a fresh seeded document with neither, but both is ambiguous.
    expectError(await request(server, 61, 'tools/call', {
      name: 'run',
      arguments: { steps: [], doc: {}, docHash: 'abc' },
    }), -32602)
    const fresh = await request(server, 62, 'tools/call', { name: 'run', arguments: { steps: [] } })
    expect(fresh).toMatchObject({ id: 62 })
    expect(calls.at(-1)).toEqual({ tool: 'run', args: { steps: [], files: [] } })
    const chained = await request(server, 63, 'tools/call', {
      name: 'run',
      arguments: { steps: [], docHash: 'abc' },
    })
    expect(chained).toMatchObject({ id: 63 })
    expect(calls.at(-1)).toEqual({ tool: 'run', args: { docHash: 'abc', steps: [], files: [] } })

    expectError(await request(server, 64, 'tools/call', {
      name: 'run',
      arguments: { steps: [], returnDoc: 'yes' },
    }), -32602)
    expectError(await request(server, 65, 'tools/call', {
      name: 'run',
      arguments: { steps: [], docHash: '' },
    }), -32602)
  })

  it('returns a failing compare as data, not an error result', async () => {
    const { ops } = fakeOps(() => ({ ok: true, pass: false, rows: [{ measure: 'volume', within: false }] }))
    const server = createMcpServer(ops)
    const response = await request(server, 28, 'tools/call', {
      name: 'compare',
      arguments: {
        doc: {},
        reference: {
          source: { tool: 'test', version: '1', file: 'source.md' },
          tolerance: { rel: 1e-5, abs: 1e-6 },
          bodies: 1,
          volume: 10,
          area: 20,
          centroid: [0, 0, 0],
          bbox: [0, 0, 0, 1, 1, 1],
        },
      },
    })
    const result = (response as { result: { isError?: boolean; content: Array<{ text: string }> } }).result
    expect(result.isError).toBeUndefined()
    expect(JSON.parse(result.content[0].text)).toMatchObject({ ok: true, pass: false })
  })
})
