/**
 * The reference-oracle corpus: an independent analytic truth set for the
 * kernel. Each case is a directory under `frontend/oracle/<NN-name>/` holding a
 * `recipe.yaml` (a normal Oversolved part document, loaded through the same
 * `partSpecFromText` seam the app uses) and an `expected.json` with the
 * closed-form measures and the formula that derives them.
 *
 * This module is a leaf: node fs and parsing only, no OCC. The suite that
 * builds and measures the cases is `src/oracle/__tests__/oracleReal.test.ts`;
 * `corpusMeta.test.ts` guards the corpus and the generated report without a
 * kernel. A sibling feature (minimised fuzz recipes) can drop new case
 * directories in beside these; every directory is a case and must carry both
 * files, so the layout is the whole contract.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** `frontend/oracle` - the corpus directory, one subdirectory per case. */
export const ORACLE_DIR = join(__dirname, '..', '..', 'oracle')

/** `docs/oracle.md`, the generated report the drift check compares. */
export const ORACLE_DOC_PATH = join(__dirname, '..', '..', '..', 'docs', 'oracle.md')

export interface OracleMeasures {
  bodies: number
  volume: number
  area: number
  centroid: [number, number, number]
  bbox: [number, number, number, number, number, number]
  // Structural counts. Topological, not analytic: stated where the reasoning is
  // simple (a box has 6 faces), omitted where a boolean's face split is not
  // worth freezing.
  faces?: number
  edges?: number
}

/** An upstream dimension edit re-run against a rebuilt document. */
export interface OracleEdit {
  // What changed, as a sentence: "edit ex1.distance 6 -> 10".
  what: string
  // The formula for the edited state.
  method: string
  feature: string
  field: string
  value: number
  // The edited state's full expectation. `faces`/`edges` here are the
  // persistent-naming assertion: a downstream modifier that lost its target
  // faces changes them.
  expect: OracleMeasures
}

export interface OracleExpected extends OracleMeasures {
  method: string
  edit?: OracleEdit
}

export interface OracleCase {
  name: string
  recipe: string
  expected: OracleExpected
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** Every case directory name, sorted; the README and stray files are ignored. */
export function listOracleDirs(): string[] {
  return readdirSync(ORACLE_DIR)
    .filter((name) => isDirectory(join(ORACLE_DIR, name)))
    .sort()
}

function requireFiniteNumber(where: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${where}: expected a finite number, got ${JSON.stringify(value)}`)
  }
  return value
}

function requireVector(where: string, value: unknown, length: number): number[] {
  if (!Array.isArray(value) || value.length !== length) {
    throw new Error(`${where}: expected an array of ${length} numbers, got ${JSON.stringify(value)}`)
  }
  return value.map((v, i) => requireFiniteNumber(`${where}[${i}]`, v))
}

function requireMeasures(where: string, value: unknown, withMethod: boolean): OracleMeasures & { method?: string } {
  if (typeof value !== 'object' || value === null) throw new Error(`${where}: expected an object`)
  const m = value as Record<string, unknown>
  if (withMethod && (typeof m.method !== 'string' || m.method.trim() === '')) {
    throw new Error(`${where}.method: must be a non-empty string`)
  }
  const bodies = requireFiniteNumber(`${where}.bodies`, m.bodies)
  if (!Number.isInteger(bodies) || bodies < 0) throw new Error(`${where}.bodies: must be a non-negative integer`)
  const out: OracleMeasures & { method?: string } = {
    bodies,
    volume: requireFiniteNumber(`${where}.volume`, m.volume),
    area: requireFiniteNumber(`${where}.area`, m.area),
    centroid: requireVector(`${where}.centroid`, m.centroid, 3) as [number, number, number],
    bbox: requireVector(`${where}.bbox`, m.bbox, 6) as [number, number, number, number, number, number],
  }
  if (m.faces !== undefined) out.faces = requireFiniteNumber(`${where}.faces`, m.faces)
  if (m.edges !== undefined) out.edges = requireFiniteNumber(`${where}.edges`, m.edges)
  if (withMethod) out.method = m.method as string
  return out
}

/** Parse and structurally validate an expected.json; throws naming the field. */
export function parseOracleExpected(name: string, text: string): OracleExpected {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (e) {
    throw new Error(`${name}/expected.json: invalid JSON: ${String(e)}`)
  }
  const base = requireMeasures(`${name}/expected.json`, raw, true)
  const expected: OracleExpected = { ...base, method: base.method as string }
  const editRaw = (raw as Record<string, unknown>).edit
  if (editRaw !== undefined) {
    const e = editRaw as Record<string, unknown>
    if (typeof e.what !== 'string' || e.what.trim() === '') throw new Error(`${name}/expected.json.edit.what: must be non-empty`)
    if (typeof e.method !== 'string' || e.method.trim() === '') throw new Error(`${name}/expected.json.edit.method: must be non-empty`)
    if (typeof e.feature !== 'string' || e.feature === '') throw new Error(`${name}/expected.json.edit.feature: must be non-empty`)
    if (typeof e.field !== 'string' || e.field === '') throw new Error(`${name}/expected.json.edit.field: must be non-empty`)
    const expect = requireMeasures(`${name}/expected.json.edit.expect`, e.expect, false)
    expected.edit = {
      what: e.what,
      method: e.method,
      feature: e.feature,
      field: e.field,
      value: requireFiniteNumber(`${name}/expected.json.edit.value`, e.value),
      expect: expect as OracleMeasures,
    }
  }
  return expected
}

/** One case: its recipe text and its parsed, validated expectation. */
export function readOracleCase(name: string): OracleCase {
  const recipe = readFileSync(join(ORACLE_DIR, name, 'recipe.yaml'), 'utf8')
  const expected = parseOracleExpected(name, readFileSync(join(ORACLE_DIR, name, 'expected.json'), 'utf8'))
  return { name, recipe, expected }
}

/** Every case in the corpus, sorted by directory name. */
export function listOracleCases(): OracleCase[] {
  return listOracleDirs().map(readOracleCase)
}

/** Apply an edit to a parsed document in place: the named feature's field.
 *  Params live nested under the kind key (the one canonical spelling), so the
 *  edit always lands in the sub-dict; a feature without one names a base field
 *  the oracle corpus never edits. */
export function applyOracleEdit(doc: Record<string, unknown>, edit: OracleEdit): void {
  const features = (doc.features as Array<Record<string, unknown>>) ?? []
  const feature = features.find((f) => f.id === edit.feature)
  if (feature === undefined) throw new Error(`oracle edit: no feature '${edit.feature}'`)
  const sub = feature[feature.kind as string] as Record<string, unknown> | undefined
  if (sub === undefined) {
    throw new Error(`oracle edit: feature '${edit.feature}' has no '${String(feature.kind)}' sub-dict`)
  }
  sub[edit.field] = edit.value
}
