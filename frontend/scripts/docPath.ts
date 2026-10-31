// The file-path contract shared by the drive CLI and the MCP server. Both run
// with `frontend/` as their cwd, but a path like `tmp/x.json` must name the
// project-internal tmp, not `frontend/tmp`; every path therefore resolves
// against the repo root. Writes may only land in the project's scratch areas
// (tmp/ and bugreports/), while a read-only reference or an input file may also
// come from scratch/. This module does the resolution and the format choice in
// one place so the two surfaces cannot drift.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { stringify as stringifyYaml } from 'yaml'
import { McpToolError } from '@/drive/toolError'
import type { McpFileRef } from '@/drive/mcpServer'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))

/** The repository root, derived from this module's own location. */
export const REPO_ROOT = path.resolve(SCRIPT_DIR, '../..')

/** Why a path is being resolved: a written document, a read-only reference, or
 *  a read-only input file (the MCP `files` map). */
export type ProjectPathPurpose = 'doc' | 'reference' | 'input'

const ALLOWED_DIRS: Record<ProjectPathPurpose, readonly string[]> = {
  doc: ['tmp', 'bugreports'],
  reference: ['tmp', 'bugreports', 'scratch'],
  input: ['tmp', 'bugreports', 'scratch'],
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative !== ''
    && relative !== '..'
    && !relative.startsWith('..' + path.sep)
    && !path.isAbsolute(relative)
}

/**
 * Resolve a caller-supplied path against the repo root and refuse anything
 * outside the purpose's allowed directories. The error names the directories so
 * a caller can correct the path instead of guessing.
 */
export function resolveProjectPath(input: string, purpose: ProjectPathPurpose): string {
  if (input.trim() === '') throw new Error('path must not be empty')
  const target = path.resolve(REPO_ROOT, input)
  for (const name of ALLOWED_DIRS[purpose]) {
    if (isInside(path.resolve(REPO_ROOT, name), target)) return target
  }
  const allowed = ALLOWED_DIRS[purpose].map(name => `${name}/`).join(', ')
  throw new Error(`path "${input}" must resolve inside ${allowed} (relative paths resolve against the repo root)`)
}

/** Read a reference file after applying the same directory rule. */
export function readProjectReference(input: string): { file: string; text: string } {
  const file = resolveProjectPath(input, 'reference')
  return { file, text: readFileSync(file, 'utf8') }
}

/**
 * Read the MCP `files` map through the same rule as every other project path.
 * A missing file or a path outside the read roots is a user error: the caller
 * named it, so it comes back as a tool failure naming the entry, not as an
 * internal server error.
 */
export function readProjectFiles(files: readonly McpFileRef[]): ReadonlyMap<string, Uint8Array> | undefined {
  if (files.length === 0) return undefined
  const map = new Map<string, Uint8Array>()
  for (const [index, file] of files.entries()) {
    let resolved: string
    try {
      resolved = resolveProjectPath(file.path, 'input')
    } catch (e) {
      throw new McpToolError(`field "files[${index}].path": ${e instanceof Error ? e.message : String(e)}`)
    }
    try {
      map.set(file.id, new Uint8Array(readFileSync(resolved)))
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e)
      throw new McpToolError(`field "files[${index}].path" could not be read: ${file.path} (${reason})`)
    }
  }
  return map
}

export type DocFileFormat = 'json' | 'yaml'

/**
 * The document format a path asks for. JSON is explicit by its extension;
 * YAML is the default for .yaml, .yml and anything else, which keeps the CLI's
 * historical extensionless behaviour.
 */
export function docFormatForPath(file: string): DocFileFormat {
  const extension = path.extname(file).toLowerCase()
  return extension === '.json' ? 'json' : 'yaml'
}

export function serializeDocFile(doc: unknown, format: DocFileFormat): string {
  return format === 'json' ? JSON.stringify(doc, null, 1) + '\n' : stringifyYaml(doc)
}

/**
 * Write a document by the format its extension names. The caller resolves and
 * checks the path first (resolveProjectPath) so a refused path never writes.
 */
export function writeDocFile(file: string, doc: unknown): { file: string; format: DocFileFormat } {
  const format = docFormatForPath(file)
  // A fresh run directory (bugreports/<slug>/) may not exist yet.
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, serializeDocFile(doc, format))
  return { file, format }
}
