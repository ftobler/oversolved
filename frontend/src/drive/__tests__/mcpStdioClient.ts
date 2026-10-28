// The MCP stdio test client: one interactive server child process, its stdout
// demuxed by response id. Extracted from cliSmoke.test.ts unchanged so the
// assembly protocol suite speaks to the server the same way.

import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect } from 'vitest'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const FRONTEND_DIR = path.resolve(__dirname, '../../..')
// The project-internal tmp at the worktree root; never the system /tmp.
export const TMP_DIR = path.resolve(FRONTEND_DIR, '../tmp')

export interface McpResponse {
  jsonrpc: string
  id?: number
  result?: unknown
  error?: { code: number; message: string }
}

export interface McpClient {
  request(method: string, params?: unknown): Promise<McpResponse>
  close(): Promise<void>
}

// One interactive child process: line-buffered stdout demuxed by response id.
export function spawnMcp(env: Record<string, string> = {}): McpClient {
  const child = spawn('node', [
    '--experimental-strip-types',
    '--loader=./scripts/driveCli.loader.mjs',
    'scripts/mcpServer.ts',
  ], { cwd: FRONTEND_DIR, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } })

  const pending = new Map<number, (response: McpResponse) => void>()
  let buffer = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk
    let newline = buffer.indexOf('\n')
    while (newline >= 0) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      newline = buffer.indexOf('\n')
      if (!line.trim()) continue
      const message = JSON.parse(line) as McpResponse
      if (typeof message.id === 'number') {
        const resolve = pending.get(message.id)
        if (resolve) {
          pending.delete(message.id)
          resolve(message)
        }
      }
    }
  })

  let nextId = 1
  return {
    request: (method, params) => new Promise((resolve, reject) => {
      const id = nextId++
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`MCP ${method} timed out`))
      }, 120_000)
      pending.set(id, response => { clearTimeout(timer); resolve(response) })
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params !== undefined && { params }) }) + '\n')
    }),
    close: () => new Promise(resolve => {
      child.once('exit', () => resolve())
      child.stdin.end()
    }),
  }
}

/** The JSON payload a tools/call result carries as its single text content. */
export function toolPayload(response: McpResponse): Record<string, unknown> {
  expect(response.error).toBeUndefined()
  const result = response.result as { content: Array<{ type: string; text: string }>; isError?: boolean }
  expect(result.isError).toBeUndefined()
  return JSON.parse(result.content[0].text) as Record<string, unknown>
}

/** A tools/call that is expected to fail, returning its payload. */
export function errorPayload(response: McpResponse): Record<string, unknown> {
  expect(response.error).toBeUndefined()
  const result = response.result as { content: Array<{ type: string; text: string }>; isError?: boolean }
  expect(result.isError).toBe(true)
  return JSON.parse(result.content[0].text) as Record<string, unknown>
}
