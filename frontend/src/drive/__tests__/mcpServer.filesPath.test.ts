// @vitest-environment node
//
// E-11: the MCP `files` map resolves through the same project rule as `out`.
// A relative `tmp/x.step` names the project tmp even though the server runs
// with cwd `frontend/`, the bytes come back from that file, and a path outside
// the read roots or one that does not exist is a tool error naming the entry.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { REPO_ROOT, readProjectFiles, resolveProjectPath } from '../../../scripts/docPath'
import { McpToolError } from '../toolError'
import { createMcpServer, type McpCadOps } from '../mcpServer'

const CASE_DIR = path.join(REPO_ROOT, 'tmp', 'mcp-files-path')
const RELATIVE = path.join('tmp', 'mcp-files-path', 'part.step')
const BYTES = new Uint8Array([1, 2, 3, 4])

beforeAll(() => {
  mkdirSync(CASE_DIR, { recursive: true })
  writeFileSync(path.join(CASE_DIR, 'part.step'), BYTES)
})

afterAll(() => {
  rmSync(CASE_DIR, { recursive: true, force: true })
})

describe('MCP files paths', () => {
  it('resolves a relative files path against the repo root, like out', () => {
    const files = readProjectFiles([{ id: 'f1', path: RELATIVE }])
    expect(files).toBeDefined()
    expect([...files!.get('f1')!]).toEqual([...BYTES])
    // The same spelling names the same absolute file in both fields.
    expect(resolveProjectPath(RELATIVE, 'input')).toBe(resolveProjectPath(RELATIVE, 'doc'))
    expect(resolveProjectPath(RELATIVE, 'input')).toBe(path.join(REPO_ROOT, RELATIVE))
    expect(resolveProjectPath(RELATIVE, 'input')).not.toContain(`${path.sep}frontend${path.sep}tmp`)
  })

  it('accepts the absolute form of a project file', () => {
    const absolute = path.join(CASE_DIR, 'part.step')
    const files = readProjectFiles([{ id: 'f1', path: absolute }])
    expect([...files!.get('f1')!]).toEqual([...BYTES])
    expect(resolveProjectPath(absolute, 'input')).toBe(absolute)
  })

  it('refuses a path outside the read roots with the allowed directories named', () => {
    expect(() => readProjectFiles([{ id: 'f1', path: '/etc/passwd' }]))
      .toThrow(McpToolError)
    expect(() => readProjectFiles([{ id: 'f1', path: '/etc/passwd' }]))
      .toThrow(/must resolve inside tmp\/, bugreports\/, scratch\//)
  })

  it('refuses a traversal that leaves the roots', () => {
    expect(() => resolveProjectPath(path.join('tmp', '..', 'frontend', 'package.json'), 'input'))
      .toThrow(/must resolve inside/)
    expect(() => readProjectFiles([{ id: 'f1', path: path.join('tmp', '..', 'frontend', 'package.json') }]))
      .toThrow(McpToolError)
  })

  it('refuses a symlink inside a root that points outside it', () => {
    const link = path.join(CASE_DIR, 'escape')
    symlinkSync(path.join(REPO_ROOT, 'frontend'), link, 'dir')
    const throughLink = path.join('tmp', 'mcp-files-path', 'escape', 'package.json')
    // The written path is inside tmp, so the string check alone would pass; the
    // real path is frontend/package.json, which the real check refuses.
    expect(() => resolveProjectPath(throughLink, 'input'))
      .toThrow(/must resolve inside/)
  })

  it('refuses a missing file as a tool error naming the files entry', () => {
    const missing = path.join('tmp', 'mcp-files-path', 'nope.step')
    expect(() => readProjectFiles([{ id: 'f1', path: missing }]))
      .toThrow(McpToolError)
    expect(() => readProjectFiles([{ id: 'f1', path: missing }]))
      .toThrow(/files\[0\]\.path.*nope\.step/)
  })

  it('answers an op-raised McpToolError with an isError payload, not JSON-RPC -32603', async () => {
    const ops = {
      export: async () => { throw new McpToolError('field "files[0].path": outside the roots') },
    } as unknown as McpCadOps
    const server = createMcpServer(ops)
    const response = await server.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'export',
        arguments: { doc: { features: [] }, format: 'step', out: 'tmp/out.step' },
      },
    })
    expect(response).toMatchObject({ jsonrpc: '2.0', id: 1 })
    expect((response as { error?: unknown }).error).toBeUndefined()
    const result = (response as { result: { isError?: boolean; content: Array<{ text: string }> } }).result
    expect(result.isError).toBe(true)
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      ok: false,
      error: 'field "files[0].path": outside the roots',
    })
  })
})
