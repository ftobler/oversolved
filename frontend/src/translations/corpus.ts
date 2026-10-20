/**
 * The translation corpus: cases transcribed from another CAD tool, stored as
 * `frontend/translations/<NN-name>/` with a `recipe.yaml` (the same part loader
 * the app uses), a `source.*` file and a `reference.json` holding that tool's
 * measures. This module is a leaf: node fs and parsing only, no OCC.
 *
 * A translation's truth is "another tool says so", a weaker class than the
 * oracle's closed form, which is why the cases live in their own tier instead
 * of diluting `frontend/oracle/`. `reference.json` reuses the oracle's measure
 * names (and its `require*` validators) so one comparison reads both.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { requireFiniteNumber, requireMeasures, type OracleMeasures } from '@/oracle/corpus'
import type { MeasureTolerance } from '@/kernel/occ/measureTolerance'

// `import.meta.url` rather than `__dirname`: the drive CLI and MCP server
// import this module from plain Node ESM, which has no `__dirname`.
const CORPUS_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** `frontend/translations` - the corpus directory, one subdirectory per case. */
export const TRANSLATIONS_DIR = join(CORPUS_ROOT, 'translations')

export interface ReferenceSource {
  tool: string
  version: string
  // A file in the case directory: where the source model lives.
  file: string
}

export interface TranslationReference extends OracleMeasures {
  source: ReferenceSource
  tolerance: MeasureTolerance
  // Structural counts are report-only by default: another kernel may split
  // faces differently while being geometrically equal.
  topology: 'report' | 'strict'
}

export interface TranslationCase {
  name: string
  recipe: string
  reference: TranslationReference
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** Every case directory name, sorted; the README and stray files are ignored. */
export function listTranslationDirs(dir = TRANSLATIONS_DIR): string[] {
  return readdirSync(dir)
    .filter((name) => isDirectory(join(dir, name)))
    .sort()
}

/** Parse and validate a reference.json; throws naming the field. */
export function parseReference(name: string, text: string): TranslationReference {
  const where = `${name}/reference.json`
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (e) {
    throw new Error(`${where}: invalid JSON: ${String(e)}`)
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${where}: expected an object`)
  }
  const record = raw as { [key: string]: unknown }
  const measures = requireMeasures(where, record, false)
  // The oracle's parser leaves the counts optional and untyped beyond finite,
  // because its cases are hand-checked. A reference is machine-produced, so a
  // fractional or negative structural count is a malformed reference.
  for (const field of ['faces', 'edges'] as const) {
    const value = measures[field]
    if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
      throw new Error(`${where}.${field}: must be a non-negative integer, got ${JSON.stringify(value)}`)
    }
  }

  const sourceRaw = record.source
  if (typeof sourceRaw !== 'object' || sourceRaw === null || Array.isArray(sourceRaw)) {
    throw new Error(`${where}.source: expected an object`)
  }
  const source = sourceRaw as { [key: string]: unknown }
  for (const field of ['tool', 'version', 'file'] as const) {
    if (typeof source[field] !== 'string' || source[field] === '') {
      throw new Error(`${where}.source.${field}: must be a non-empty string`)
    }
  }

  const toleranceRaw = record.tolerance
  if (typeof toleranceRaw !== 'object' || toleranceRaw === null || Array.isArray(toleranceRaw)) {
    throw new Error(`${where}.tolerance: expected an object with rel and abs`)
  }
  const toleranceRecord = toleranceRaw as { [key: string]: unknown }
  const rel = requireFiniteNumber(`${where}.tolerance.rel`, toleranceRecord.rel)
  const abs = requireFiniteNumber(`${where}.tolerance.abs`, toleranceRecord.abs)
  if (rel < 0 || abs < 0) throw new Error(`${where}.tolerance: rel and abs must be non-negative`)

  const topology = record.topology === undefined ? 'report' : record.topology
  if (topology !== 'report' && topology !== 'strict') {
    throw new Error(`${where}.topology: must be "report" or "strict", got ${JSON.stringify(topology)}`)
  }

  return {
    ...measures,
    source: { tool: source.tool as string, version: source.version as string, file: source.file as string },
    tolerance: { rel, abs },
    topology,
  }
}

function requireFile(path: string, what: string): void {
  if (!existsSync(path)) throw new Error(`${what}: file does not exist`)
}

/**
 * A reference names its source relative to the case directory. Refuse an
 * absolute path or a `..` segment rather than letting a reference read outside
 * the corpus.
 */
function requireConfinedSource(name: string, file: string): void {
  const segments = file.split(/[\\/]/)
  if (isAbsolute(file) || segments.includes('..')) {
    throw new Error(`${name}/reference.json.source.file "${file}": must stay inside the case directory`)
  }
}

/** One case: its recipe text and its parsed, validated reference. */
export function loadTranslationCase(name: string, dir = TRANSLATIONS_DIR): TranslationCase {
  const caseDir = join(dir, name)
  const recipePath = join(caseDir, 'recipe.yaml')
  if (!existsSync(recipePath)) throw new Error(`${name}/recipe.yaml: missing`)
  const referencePath = join(caseDir, 'reference.json')
  if (!existsSync(referencePath)) throw new Error(`${name}/reference.json: missing`)

  const reference = parseReference(name, readFileSync(referencePath, 'utf8'))
  requireConfinedSource(name, reference.source.file)
  requireFile(join(caseDir, reference.source.file), `${name}/reference.json.source.file "${reference.source.file}"`)

  return { name, recipe: readFileSync(recipePath, 'utf8'), reference }
}

/** Every case in the corpus, sorted by directory name. */
export function listTranslationCases(dir = TRANSLATIONS_DIR): TranslationCase[] {
  return listTranslationDirs(dir).map((name) => loadTranslationCase(name, dir))
}
