// @vitest-environment node
//
// The shared document-path contract of the drive CLI and the MCP server. The
// two entry scripts run with `frontend/` as their cwd, so a relative `tmp/...`
// must resolve against the repo root, and nothing may be written outside the
// project's scratch areas.

import { describe, it, expect, afterAll } from 'vitest'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { parse as parseYaml } from 'yaml'
import {
  REPO_ROOT,
  docFormatForPath,
  readProjectReference,
  resolveProjectPath,
  serializeDocFile,
  writeDocFile,
} from '../../../scripts/docPath'

const TMP_CASE = path.join(REPO_ROOT, 'tmp', 'doc-path-test')
const DOC = { version: 1, kind: 'part', features: [{ id: 'sk1', kind: 'sketch' }] }

describe('resolveProjectPath', () => {
  it('resolves a relative path against the repo root, not the caller cwd', () => {
    expect(resolveProjectPath('tmp/x.json', 'doc')).toBe(path.join(REPO_ROOT, 'tmp/x.json'))
    expect(resolveProjectPath('tmp/x.json', 'doc')).not.toContain(`${path.sep}frontend${path.sep}tmp`)
  })

  it('allows tmp/ and bugreports/ for a written document', () => {
    expect(resolveProjectPath('bugreports/x.yaml', 'doc')).toBe(path.join(REPO_ROOT, 'bugreports/x.yaml'))
  })

  it('allows scratch/ for a read-only reference but not for a document', () => {
    expect(resolveProjectPath('scratch/x.json', 'reference')).toBe(path.join(REPO_ROOT, 'scratch/x.json'))
    expect(() => resolveProjectPath('scratch/x.json', 'doc')).toThrow(/must resolve inside/)
  })

  it('refuses an absolute path outside the project and a traversal', () => {
    expect(() => resolveProjectPath('/etc/x', 'doc')).toThrow(/must resolve inside/)
    expect(() => resolveProjectPath('../x', 'doc')).toThrow(/must resolve inside/)
    expect(() => resolveProjectPath('tmp/../../x', 'doc')).toThrow(/must resolve inside/)
  })
})

describe('document file format', () => {
  it('chooses JSON only by a .json extension and YAML otherwise', () => {
    expect(docFormatForPath('x.json')).toBe('json')
    expect(docFormatForPath('x.JSON')).toBe('json')
    expect(docFormatForPath('x.yaml')).toBe('yaml')
    expect(docFormatForPath('x.yml')).toBe('yaml')
    expect(docFormatForPath('x')).toBe('yaml')
  })

  it('writes JSON that parses back to the same document', () => {
    expect(JSON.parse(serializeDocFile(DOC, 'json'))).toEqual(DOC)
  })

  it('writes YAML that parses back to the same document', () => {
    expect(parseYaml(serializeDocFile(DOC, 'yaml'))).toEqual(DOC)
  })

  it('writes a .json path as JSON and a .yaml path as YAML', () => {
    mkdirSync(TMP_CASE, { recursive: true })
    try {
      const json = writeDocFile(path.join(TMP_CASE, 'doc.json'), DOC)
      const yaml = writeDocFile(path.join(TMP_CASE, 'doc.yaml'), DOC)
      expect(json.format).toBe('json')
      expect(yaml.format).toBe('yaml')
      expect(JSON.parse(readFileSync(json.file, 'utf8'))).toEqual(DOC)
      expect(parseYaml(readFileSync(yaml.file, 'utf8'))).toEqual(DOC)
    } finally {
      rmSync(TMP_CASE, { recursive: true, force: true })
    }
  })

  it('reads a reference through the same directory rule', () => {
    mkdirSync(TMP_CASE, { recursive: true })
    try {
      writeDocFile(path.join(TMP_CASE, 'reference.json'), DOC)
      expect(readProjectReference(path.join('tmp', 'doc-path-test', 'reference.json')).text).toContain('"version"')
    } finally {
      rmSync(TMP_CASE, { recursive: true, force: true })
    }
  })
})

afterAll(() => {
  rmSync(TMP_CASE, { recursive: true, force: true })
})
