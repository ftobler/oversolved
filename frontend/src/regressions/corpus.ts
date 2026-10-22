/**
 * The regression corpus: bug reports and real documents kept as folders under
 * `frontend/regressions/<kebab-name>/`, each holding the document exactly as it
 * was exported (`recipe.yaml`) plus a small, hand-readable `checks.json` and an
 * optional generated `snapshot.json`.
 *
 * This module is a leaf: node fs and JSON parsing only, no OCC. The runner is
 * `src/regressions/run.ts` and the suite that builds every case is
 * `__tests__/regressionsReal.test.ts`; the no-kernel contract test is
 * `__tests__/regressionsMeta.test.ts`. It is the third sibling corpus beside the
 * oracle (`src/oracle/corpus.ts`) and translations
 * (`src/translations/corpus.ts`), and reuses the oracle's `require*`
 * validators. The truth class differs from both: a regression case is the
 * kernel's own earlier output for a real document, not a closed form or another
 * tool's report.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { requireFiniteNumber, requireVector } from '@/oracle/corpus'

const CORPUS_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** `frontend/regressions` - the corpus directory, one subdirectory per case. */
export const REGRESSIONS_DIR = join(CORPUS_ROOT, 'regressions')

export const REGRESSION_CASE_FILES = ['recipe.yaml', 'checks.json', 'snapshot.json'] as const

export const ORIGIN_KINDS = ['bug_report', 'real_doc', 'exploration', 'fuzz', 'curated'] as const
export type OriginKind = (typeof ORIGIN_KINDS)[number]

export const SEVERITIES = ['hard', 'soft'] as const
export type Severity = (typeof SEVERITIES)[number]

/** The licences a case may be checked in under. `own` means authored here. */
export const OWN_LICENSE = 'own'
export const THIRD_PARTY_LICENSES = ['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'CC0-1.0'] as const
export const LICENSE_ALLOW_LIST = [OWN_LICENSE, ...THIRD_PARTY_LICENSES] as const

export interface RegressionOrigin {
  kind: OriginKind
  // The bug report, plan or commit the case came from.
  ref: string
  date: string
}

export interface ThirdPartyLicense {
  spdx: (typeof THIRD_PARTY_LICENSES)[number]
  source: string
  commit: string
}

export type RegressionLicense = typeof OWN_LICENSE | ThirdPartyLicense

export interface RegressionFeatures {
  // The solve status every recipe feature must report unless `except` says
  // otherwise. A sketch's status is its constraint verdict, so a sketch that is
  // fully or under constrained pins that verdict here.
  default: string
  except?: Record<string, string>
}

/**
 * The oracle's measure names, all optional so a case checks what it can state:
 * a body-less document has no centroid or bbox to locate, and a case may omit a
 * measure it does not want to freeze. `bodies` is always required.
 */
export interface RegressionMeasures {
  bodies: number
  volume?: number
  area?: number
  centroid?: [number, number, number] | null
  bbox?: [number, number, number, number, number, number] | null
  faces?: number
  edges?: number
}

export interface RegressionChecks {
  origin: RegressionOrigin
  license: RegressionLicense
  severity: Severity
  what: string
  features: RegressionFeatures
  tolerance: { rel: number; abs: number }
  topology: 'report' | 'strict'
  measures: RegressionMeasures
  snapshot: boolean
}

/** One body's frozen identity and geometry fingerprints, in sorted order. */
export interface RegressionSnapshotBody {
  created_by: string
  modified_by: string[]
  face_hashes: string[]
  edge_hashes: string[]
}

export interface RegressionSnapshot {
  bodies: Record<string, RegressionSnapshotBody>
}

export interface RegressionCase {
  name: string
  recipe: string
  checks: RegressionChecks
  snapshot: RegressionSnapshot | null
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** Every case directory name, sorted; the README and stray files are ignored. */
export function listRegressionDirs(dir = REGRESSIONS_DIR): string[] {
  return readdirSync(dir)
    .filter((name) => isDirectory(join(dir, name)))
    .sort()
}

/** A case name is kebab-case; bug cases have no natural order, so no `NN-`. */
export function isKebabCase(name: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireRecord(where: string, value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${where}: expected an object`)
  return value
}

function requireString(where: string, value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${where}: must be a non-empty string`)
  }
  return value
}

function requirePlainString(where: string, value: unknown): string {
  if (typeof value !== 'string') throw new Error(`${where}: must be a string`)
  return value
}

function requireBoolean(where: string, value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error(`${where}: must be a boolean`)
  return value
}

function requireStringArray(where: string, value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error(`${where}: expected an array of strings`)
  return value.map((item, i) => requirePlainString(`${where}[${i}]`, item))
}

function requireInteger(where: string, value: unknown): number {
  const n = requireFiniteNumber(where, value)
  if (!Number.isInteger(n) || n < 0) throw new Error(`${where}: must be a non-negative integer`)
  return n
}

function rejectUnknownKeys(where: string, record: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) throw new Error(`${where}.${key}: unknown field (allowed: ${allowed.join(', ')})`)
  }
}

function parseOrigin(where: string, value: unknown): RegressionOrigin {
  const record = requireRecord(where, value)
  rejectUnknownKeys(where, record, ['kind', 'ref', 'date'])
  const kind = record.kind
  if (typeof kind !== 'string' || !ORIGIN_KINDS.includes(kind as OriginKind)) {
    throw new Error(`${where}.kind: must be one of ${ORIGIN_KINDS.join(', ')}, got ${JSON.stringify(kind)}`)
  }
  const date = requireString(`${where}.date`, record.date)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`${where}.date: must be YYYY-MM-DD, got ${JSON.stringify(date)}`)
  }
  return { kind: kind as OriginKind, ref: requireString(`${where}.ref`, record.ref), date }
}

function parseLicense(where: string, value: unknown): RegressionLicense {
  if (value === OWN_LICENSE) return OWN_LICENSE
  const allowed = LICENSE_ALLOW_LIST.join(', ')
  if (!isRecord(value)) {
    throw new Error(
      `${where}: ${JSON.stringify(value)} is not allowed; use "own" or one of ${allowed} with source and commit`,
    )
  }
  rejectUnknownKeys(where, value, ['spdx', 'source', 'commit'])
  const spdx = value.spdx
  if (typeof spdx !== 'string' || !(THIRD_PARTY_LICENSES as readonly string[]).includes(spdx)) {
    throw new Error(
      `${where}.spdx: ${JSON.stringify(spdx)} is not allowed; use one of ${THIRD_PARTY_LICENSES.join(', ')}`,
    )
  }
  return {
    spdx: spdx as (typeof THIRD_PARTY_LICENSES)[number],
    source: requireString(`${where}.source`, value.source),
    commit: requireString(`${where}.commit`, value.commit),
  }
}

function parseFeatures(where: string, value: unknown, recipeFeatureIds?: readonly string[]): RegressionFeatures {
  const record = requireRecord(where, value)
  rejectUnknownKeys(where, record, ['default', 'except'])
  const fallback = requireString(`${where}.default`, record.default)
  const exceptRaw = record.except
  if (exceptRaw === undefined) return { default: fallback }
  const exceptRecord = requireRecord(`${where}.except`, exceptRaw)
  const except: Record<string, string> = {}
  for (const [id, statusRaw] of Object.entries(exceptRecord)) {
    const status = requireString(`${where}.except.${id}`, statusRaw)
    if (recipeFeatureIds !== undefined && !recipeFeatureIds.includes(id)) {
      throw new Error(
        `${where}.except.${id}: unknown feature id; the recipe has ${recipeFeatureIds.length} feature(s): ${recipeFeatureIds.join(', ')}`,
      )
    }
    except[id] = status
  }
  return { default: fallback, except }
}

function parseTolerance(where: string, value: unknown): { rel: number; abs: number } {
  const record = requireRecord(where, value)
  rejectUnknownKeys(where, record, ['rel', 'abs'])
  const rel = requireFiniteNumber(`${where}.rel`, record.rel)
  const abs = requireFiniteNumber(`${where}.abs`, record.abs)
  if (rel < 0 || abs < 0) throw new Error(`${where}: rel and abs must be non-negative`)
  return { rel, abs }
}

function parseMeasures(where: string, value: unknown): RegressionMeasures {
  const record = requireRecord(where, value)
  rejectUnknownKeys(where, record, ['bodies', 'volume', 'area', 'centroid', 'bbox', 'faces', 'edges'])
  const measures: RegressionMeasures = {
    bodies: requireInteger(`${where}.bodies`, record.bodies),
  }
  if (record.volume !== undefined) measures.volume = requireFiniteNumber(`${where}.volume`, record.volume)
  if (record.area !== undefined) measures.area = requireFiniteNumber(`${where}.area`, record.area)
  if (record.centroid !== undefined) {
    measures.centroid = record.centroid === null
      ? null
      : requireVector(`${where}.centroid`, record.centroid, 3) as [number, number, number]
  }
  if (record.bbox !== undefined) {
    measures.bbox = record.bbox === null
      ? null
      : requireVector(`${where}.bbox`, record.bbox, 6) as [number, number, number, number, number, number]
  }
  if (record.faces !== undefined) measures.faces = requireInteger(`${where}.faces`, record.faces)
  if (record.edges !== undefined) measures.edges = requireInteger(`${where}.edges`, record.edges)
  return measures
}

/**
 * Parse and validate a checks.json; throws naming the case and the field.
 * `recipeFeatureIds` arms the `features.except` cross-check against the recipe.
 */
export function parseChecks(
  name: string,
  text: string,
  recipeFeatureIds?: readonly string[],
): RegressionChecks {
  const where = `${name}/checks.json`
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (e) {
    throw new Error(`${where}: invalid JSON: ${String(e)}`)
  }
  const record = requireRecord(where, raw)
  rejectUnknownKeys(where, record, [
    'origin', 'license', 'severity', 'what', 'features', 'tolerance', 'topology', 'measures', 'snapshot',
  ])
  const severity = record.severity
  if (typeof severity !== 'string' || !SEVERITIES.includes(severity as Severity)) {
    throw new Error(`${where}.severity: must be "hard" or "soft", got ${JSON.stringify(severity)}`)
  }
  const topology = record.topology
  if (topology !== 'report' && topology !== 'strict') {
    throw new Error(`${where}.topology: must be "report" or "strict", got ${JSON.stringify(topology)}`)
  }
  const snapshot = record.snapshot === undefined ? false : requireBoolean(`${where}.snapshot`, record.snapshot)
  return {
    origin: parseOrigin(`${where}.origin`, record.origin),
    license: parseLicense(`${where}.license`, record.license),
    severity: severity as Severity,
    what: requireString(`${where}.what`, record.what),
    features: parseFeatures(`${where}.features`, record.features, recipeFeatureIds),
    tolerance: parseTolerance(`${where}.tolerance`, record.tolerance),
    topology,
    measures: parseMeasures(`${where}.measures`, record.measures),
    snapshot,
  }
}

/** Parse and validate a snapshot.json: per-body lineage and sorted fingerprints. */
export function parseSnapshot(name: string, text: string): RegressionSnapshot {
  const where = `${name}/snapshot.json`
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (e) {
    throw new Error(`${where}: invalid JSON: ${String(e)}`)
  }
  const record = requireRecord(where, raw)
  rejectUnknownKeys(where, record, ['bodies'])
  const bodiesRecord = requireRecord(`${where}.bodies`, record.bodies)
  const bodies: Record<string, RegressionSnapshotBody> = {}
  for (const [id, bodyRaw] of Object.entries(bodiesRecord)) {
    const bodyWhere = `${where}.bodies.${id}`
    const body = requireRecord(bodyWhere, bodyRaw)
    rejectUnknownKeys(bodyWhere, body, ['created_by', 'modified_by', 'face_hashes', 'edge_hashes'])
    bodies[id] = {
      created_by: requirePlainString(`${bodyWhere}.created_by`, body.created_by),
      modified_by: requireStringArray(`${bodyWhere}.modified_by`, body.modified_by),
      face_hashes: requireStringArray(`${bodyWhere}.face_hashes`, body.face_hashes),
      edge_hashes: requireStringArray(`${bodyWhere}.edge_hashes`, body.edge_hashes),
    }
  }
  return { bodies }
}

/** One case: its recipe text, parsed checks and optional frozen snapshot. */
export function loadRegressionCase(name: string, dir = REGRESSIONS_DIR): RegressionCase {
  if (!isKebabCase(name)) {
    throw new Error(`regressions: case name ${JSON.stringify(name)} is not kebab-case`)
  }
  const caseDir = join(dir, name)
  const recipePath = join(caseDir, 'recipe.yaml')
  if (!existsSync(recipePath)) throw new Error(`${name}/recipe.yaml: missing`)
  const checksPath = join(caseDir, 'checks.json')
  if (!existsSync(checksPath)) throw new Error(`${name}/checks.json: missing`)

  const checks = parseChecks(name, readFileSync(checksPath, 'utf8'))
  const snapshotPath = join(caseDir, 'snapshot.json')
  const hasSnapshot = existsSync(snapshotPath)
  if (checks.snapshot && !hasSnapshot) throw new Error(`${name}/snapshot.json: missing (checks.json says snapshot: true)`)
  if (!checks.snapshot && hasSnapshot) {
    throw new Error(`${name}/snapshot.json: present but checks.json does not say snapshot: true`)
  }
  return {
    name,
    recipe: readFileSync(recipePath, 'utf8'),
    checks,
    snapshot: hasSnapshot ? parseSnapshot(name, readFileSync(snapshotPath, 'utf8')) : null,
  }
}

/** Every case in the corpus, sorted by directory name. */
export function listRegressionCases(dir = REGRESSIONS_DIR): RegressionCase[] {
  return listRegressionDirs(dir).map((name) => loadRegressionCase(name, dir))
}
