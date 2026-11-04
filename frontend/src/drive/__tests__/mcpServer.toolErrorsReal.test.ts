// @vitest-environment node
//
// E-3: a user error is a tool error. An unknown export body and an unreadable
// `files` path used to escape the op as a plain Error and come back as a
// JSON-RPC -32603 internal error, while `select` already answered the same
// class of failure with isError. The protocol channel stays reserved for
// malformed requests and invalid arguments.
//
// The real suite spawns the server: the body ids only exist after a solve.

import { createRequire } from 'node:module'
import { describe, it, expect } from 'vitest'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { createMcpServer, type McpCadOps } from '../mcpServer'
import { spawnMcp, errorPayload } from './mcpStdioClient'

function occInstalled(): boolean {
  try {
    createRequire(import.meta.url).resolve('opencascade.js/dist/opencascade.wasm.js')
    return true
  } catch {
    return false
  }
}

const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number)
const stripTypes = nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 6)
// The run that mints the body ids needs the Rust sketch solver as well as OCC;
// without it this suite would exercise a failed build instead of a body id.
const ready = occInstalled() && loadSolver() !== null && stripTypes

const BOX_SCRIPT = {
  steps: [
    { mutation: { type: 'add_sketch', featureId: 'sk1', label: 'Rectangle', plane: '@builtin_plane_front' } },
    { mutation: { type: 'add_rect', featureId: 'sk1', p0: [0, 0], p1: [10, 10] } },
    { mutation: { type: 'add_extrude', featureId: 'ex1', label: 'Extrude', sketchQuery: '$sk1', distance: 5, operation: 'new' } },
  ],
}

describe('tool error framing', () => {
  const ops = { export: async () => ({ ok: true }) } as unknown as McpCadOps
  const server = createMcpServer(ops)

  it('keeps malformed requests and invalid arguments in the protocol channel', async () => {
    expect(await server.handle({ jsonrpc: '2.0', id: 1 })).toMatchObject({ error: { code: -32600 } })
    expect(await server.handle(7)).toMatchObject({ error: { code: -32600 } })
    expect(await server.handle({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'export',
        arguments: { doc: { features: [] }, format: 'step', out: 'tmp/x.step', bogus: 1 },
      },
    })).toMatchObject({ error: { code: -32602 } })
  })
})

describe.skipIf(!ready)('MCP user errors (real OCC + Rust solver)', () => {
  it('answers an unknown export body and an unreadable files path as tool errors', async () => {
    const client = spawnMcp()
    try {
      await client.request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'toolErrors', version: '0' },
      })
      const built = (await client.request('tools/call', {
        name: 'run',
        arguments: { steps: BOX_SCRIPT.steps },
      })).result as { content: Array<{ text: string }>; isError?: boolean }
      const docHash = (JSON.parse(built.content[0].text) as { docHash: string }).docHash

      // A body id typo names the live ids the caller can pick from, and is not
      // a protocol error.
      const unknownBody = errorPayload(await client.request('tools/call', {
        name: 'export',
        arguments: { docHash, format: 'step', out: 'tmp/tool-errors/unknown.step', body: 'nope' },
      }))
      expect(unknownBody.ok).toBe(false)
      expect(String(unknownBody.error)).toContain("body 'nope' not found")
      expect(String(unknownBody.error)).toContain('body_ex1')

      // A `files` path outside the read roots is refused by the project rule.
      const outside = errorPayload(await client.request('tools/call', {
        name: 'export',
        arguments: {
          docHash,
          format: 'step',
          out: 'tmp/tool-errors/outside.step',
          files: [{ id: 'f1', path: '/etc/passwd' }],
        },
      }))
      expect(String(outside.error)).toContain('must resolve inside tmp/, bugreports/, scratch/')

      // A missing file inside the roots is a user error naming the entry.
      const missing = errorPayload(await client.request('tools/call', {
        name: 'export',
        arguments: {
          docHash,
          format: 'step',
          out: 'tmp/tool-errors/missing.step',
          files: [{ id: 'f1', path: 'tmp/tool-errors/definitely-missing.step' }],
        },
      }))
      expect(String(missing.error)).toMatch(/files\[0\]\.path/)
      expect(String(missing.error)).toContain('definitely-missing.step')
    } finally {
      await client.close()
    }
  }, 240_000)
})
