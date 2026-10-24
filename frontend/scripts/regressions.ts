/**
 * Add and regenerate regression-corpus cases.
 *
 *   npm run regressions:add -- <path/to/doc.yaml> <name> [--snapshot]
 *   npm run regressions:regen [name...]
 *
 * `add` copies the document as the case's `recipe.yaml`, solves it through the
 * live kernel once, and writes a `checks.json` whose live-derived parts
 * (features, measures, optional snapshot) already pass; the provenance fields
 * are defaults to edit by hand. It refuses to overwrite an existing case.
 *
 * `regen` rewrites only the live-derived parts (`features`, `measures`, and
 * `snapshot.json` when the case asks for one) for the named cases, or all of
 * them. Provenance, severity, the human description and the tolerance are left
 * untouched, and a second run is byte-identical, so the reviewable output is the
 * small per-case git diff.
 *
 * Both need OCC.js and the pkg-node solver build, exactly like the real suite:
 * `just install-occ` and `just wasm`.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadOcc, resetOcc } from '@/kernel/occ/loadOcc'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { loadTopology } from '@/wasm-kernel/loadTopology'
import { setOccLoader } from '@/kernel/solveLocally'
import { resetSketchSolver, setSketchSolver, setSketchTopology } from '@/kernel/features/sketch'
import { partSpecFromText } from '@/utils/partExport'
import {
  isKebabCase,
  listRegressionDirs,
  loadRegressionCase,
  parseChecks,
  REGRESSIONS_DIR,
  type RegressionCase,
  type RegressionChecks,
  type RegressionFeatures,
  type RegressionLicense,
  type RegressionMeasures,
  type RegressionOrigin,
  type RegressionSnapshot,
  type Severity,
} from '../src/regressions/corpus'
import { buildRegression, issueLines, recipeFeatureIds, regressionIssues, type RegressionBuild } from '../src/regressions/run'

const DEFAULT_TOLERANCE = { rel: 1e-6, abs: 1e-6 }

let kernelReady = false

/** Load OCC.js and the Node solver builds once for this process. */
export async function initKernel(): Promise<void> {
  if (kernelReady) return
  const oc = await loadOcc()
  if (oc === null) {
    throw new Error('OCC.js unavailable: run `npm run occ:install` (or `just install-occ`)')
  }
  const solver = loadSolver()
  if (solver === null) {
    throw new Error('the pkg-node sketch solver is unavailable: run `just wasm`')
  }
  // The default OCC loader is the browser one; a Node entry has to install the
  // MEMFS-backed loader before the first build.
  setOccLoader(loadOcc, resetOcc)
  resetSketchSolver()
  setSketchSolver(solver)
  setSketchTopology(loadTopology())
  kernelReady = true
}

/** The live build reduced to the measure fields a checks.json states. */
export function liveMeasures(build: RegressionBuild, keep?: readonly string[]): RegressionMeasures {
  const all: RegressionMeasures = {
    bodies: build.measures.bodies,
    volume: build.measures.volume,
    area: build.measures.area,
    centroid: build.measures.centroid,
    bbox: build.measures.bbox,
    faces: build.measures.faces,
    edges: build.measures.edges,
  }
  // `bodies` is the one required measure; a regen keeps exactly the optional
  // names the case already states, so a deliberately omitted measure stays
  // omitted instead of silently being re-frozen.
  if (keep === undefined) return all
  const out: RegressionMeasures = { bodies: all.bodies }
  if (keep.includes('volume')) out.volume = all.volume
  if (keep.includes('area')) out.area = all.area
  if (keep.includes('centroid')) out.centroid = all.centroid
  if (keep.includes('bbox')) out.bbox = all.bbox
  if (keep.includes('faces')) out.faces = all.faces
  if (keep.includes('edges')) out.edges = all.edges
  return out
}

/**
 * Every recipe feature pinned to the status the live kernel reports. `ok` stays
 * the default; a sketch's constraint verdict or an unported legacy feature is
 * named explicitly, so no expected status is implicit.
 */
export function liveFeatures(build: RegressionBuild, featureIds: readonly string[]): RegressionFeatures {
  const except: Record<string, string> = {}
  for (const id of featureIds) {
    const status = build.statuses[id]
    if (status !== undefined && status !== 'ok') except[id] = status
  }
  return Object.keys(except).length === 0 ? { default: 'ok' } : { default: 'ok', except }
}

/** Snapshot bodies in a stable order (ids sorted, hash/modified arrays sorted). */
export function stableSnapshot(snapshot: RegressionSnapshot): RegressionSnapshot {
  const bodies: RegressionSnapshot['bodies'] = {}
  for (const id of Object.keys(snapshot.bodies).sort()) {
    const body = snapshot.bodies[id]
    bodies[id] = {
      created_by: body.created_by,
      modified_by: [...body.modified_by].sort(),
      face_hashes: [...body.face_hashes].sort(),
      edge_hashes: [...body.edge_hashes].sort(),
    }
  }
  return { bodies }
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

/** Write via a sibling temp file and rename, so a crash never leaves a torn JSON. */
function writeJsonAtomic(path: string, value: unknown): void {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  try {
    writeJson(tmp, value)
    renameSync(tmp, path)
  } catch (error) {
    rmSync(tmp, { force: true })
    throw error
  }
}

/** `YYYY-MM-DD` from the machine's local calendar, not the UTC day. */
function localDate(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

export interface AddCaseOptions {
  root?: string
  snapshot?: boolean
  origin?: RegressionOrigin
  license?: RegressionLicense
  severity?: Severity
  what?: string
}

export interface AddedCase {
  dir: string
  checks: RegressionChecks
}

/**
 * Add one case from an exported document. Refuses an existing case directory:
 * a bug case is evidence, so replacing it silently would erase what it proved.
 */
export async function addCase(
  sourcePath: string,
  name: string,
  options: AddCaseOptions = {},
): Promise<AddedCase> {
  if (!isKebabCase(name)) {
    throw new Error(`regressions:add: ${JSON.stringify(name)} is not kebab-case (e.g. "two-rings")`)
  }
  const root = options.root ?? REGRESSIONS_DIR
  const caseDir = join(root, name)
  if (existsSync(caseDir)) {
    throw new Error(`regressions:add: case "${name}" already exists at ${caseDir}; refusing to overwrite`)
  }

  const recipe = readFileSync(sourcePath, 'utf8')
  // Validate before creating anything: a document the app cannot open is not a
  // case, and a half-written directory would fail the corpus meta-test.
  const doc = partSpecFromText(recipe)
  const featureIds = recipeFeatureIds(doc)

  await initKernel()
  const build = await buildRegression(name, recipe)
  const checks: RegressionChecks = {
    origin: options.origin ?? { kind: 'bug_report', ref: relative(process.cwd(), sourcePath), date: localDate() },
    license: options.license ?? 'own',
    severity: options.severity ?? 'hard',
    what: options.what ?? `added from ${relative(process.cwd(), sourcePath)}`,
    features: liveFeatures(build, featureIds),
    tolerance: { ...DEFAULT_TOLERANCE },
    topology: 'strict',
    measures: liveMeasures(build),
    snapshot: options.snapshot ?? false,
  }
  // Re-read the text the writer will produce, so a case that would fail the
  // meta-test cannot be written in the first place.
  parseChecks(name, JSON.stringify(checks), featureIds)
  // The live-derived fields must already pass. The dangerous case is a recipe
  // feature with no solve-result row: `default: ok` would leave it unpinned and
  // the written case would fail at `features/<id>: ours=missing`.
  const issues = regressionIssues(checks, featureIds, build)
  if (issues.length > 0) {
    throw new Error(`regressions:add: "${name}" would not pass:\n${issueLines(name, issues).join('\n')}`)
  }

  // Build the whole case in a temp directory, then rename it into place: a
  // crash mid-write cannot leave a half-written case, and checks can never be
  // newer than the snapshot they describe.
  const tmpDir = join(root, `.${name}.tmp-${process.pid}-${Date.now()}`)
  try {
    mkdirSync(tmpDir, { recursive: true })
    writeFileSync(join(tmpDir, 'recipe.yaml'), recipe)
    if (checks.snapshot) writeJson(join(tmpDir, 'snapshot.json'), stableSnapshot(build.snapshot))
    writeJson(join(tmpDir, 'checks.json'), checks)
    renameSync(tmpDir, caseDir)
  } catch (error) {
    rmSync(tmpDir, { recursive: true, force: true })
    throw error
  }
  return { dir: caseDir, checks }
}

export interface RegenOptions {
  root?: string
}

export interface RegenResult {
  name: string
  changed: boolean
}

function readCase(root: string, name: string): RegressionCase {
  const caseDir = join(root, name)
  if (!existsSync(caseDir)) throw new Error(`regressions:regen: no case "${name}" at ${caseDir}`)
  return loadRegressionCase(name, root)
}

/**
 * Rewrite the live-derived fields of the named cases (all when none are named).
 * `origin`, `license`, `severity`, `what` and `tolerance` are read but never
 * assigned, so they stay byte-identical in the rewritten file.
 */
export async function regenCases(names: readonly string[], options: RegenOptions = {}): Promise<RegenResult[]> {
  const root = options.root ?? REGRESSIONS_DIR
  const targets = names.length > 0 ? [...names] : listRegressionDirs(root)
  await initKernel()
  const results: RegenResult[] = []
  for (const name of targets) {
    const regressionCase = readCase(root, name)
    const build = await buildRegression(name, regressionCase.recipe)
    const doc = partSpecFromText(regressionCase.recipe)
    const checksPath = join(root, name, 'checks.json')
    const before = readFileSync(checksPath, 'utf8')
    const next: RegressionChecks = {
      ...regressionCase.checks,
      features: liveFeatures(build, recipeFeatureIds(doc)),
      // Only the measures the case already states (plus the required `bodies`),
      // so an omitted measure is not silently re-frozen.
      measures: liveMeasures(build, Object.keys(regressionCase.checks.measures)),
    }
    const text = `${JSON.stringify(next, null, 2)}\n`
    let snapshotChanged = false
    // Snapshot first, checks last: a crash between the two leaves the older
    // checks describing a newer snapshot (a loud mismatch) rather than checks
    // claiming a snapshot that was never written.
    if (next.snapshot) {
      const snapshotPath = join(root, name, 'snapshot.json')
      const snapshot = stableSnapshot(build.snapshot)
      const snapshotText = `${JSON.stringify(snapshot, null, 2)}\n`
      if (!existsSync(snapshotPath) || readFileSync(snapshotPath, 'utf8') !== snapshotText) {
        writeJsonAtomic(snapshotPath, snapshot)
        snapshotChanged = true
      }
    }
    writeJsonAtomic(checksPath, next)
    results.push({ name, changed: text !== before || snapshotChanged })
  }
  return results
}

interface CliArgs {
  positional: string[]
  snapshot: boolean
}

function parseArgs(args: readonly string[]): CliArgs {
  const positional: string[] = []
  let snapshot = false
  for (const arg of args) {
    if (arg === '--snapshot') snapshot = true
    else if (arg.startsWith('--')) throw new Error(`unknown flag ${arg}`)
    else positional.push(arg)
  }
  return { positional, snapshot }
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2)
  if (command === 'add') {
    const { positional, snapshot } = parseArgs(rest)
    if (positional.length !== 2) {
      throw new Error('usage: npm run regressions:add -- <path/to/doc.yaml> <name> [--snapshot]')
    }
    const [source, name] = positional
    const added = await addCase(source, name, { snapshot })
    console.log(`added ${name} at ${added.dir}`)
    console.log(`edit ${join(added.dir, 'checks.json')}: origin, license, severity and what are defaults`)
    return
  }
  if (command === 'regen') {
    const { positional } = parseArgs(rest)
    const results = await regenCases(positional)
    const changed = results.filter((result) => result.changed)
    for (const result of results) console.log(`${result.changed ? 'rewrote' : 'unchanged'} ${result.name}`)
    console.log(`${changed.length} of ${results.length} case(s) changed`)
    return
  }
  throw new Error('usage: regressions.ts add <doc> <name> [--snapshot] | regen [name...]')
}

const invokedDirectly = process.argv[1] !== undefined
  && pathToFileURL(process.argv[1]).href === import.meta.url

if (invokedDirectly) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
