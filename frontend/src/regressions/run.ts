/**
 * The regression runner: build one case through the real kernel once and turn
 * the live result into readable failing rows.
 *
 * The build is `buildAndMeasureLocally` (one pass for both the per-feature
 * solve statuses and the final body measures), so a case never pays two
 * builds. A failure is data: the runner returns `issues`, each shaped
 * `<check>: ours=<live> expected=<checks.json>`; the suite formats them as
 * `<case>/<check>: ours=... expected=...`. The checks are the readable part;
 * `snapshot.json`, when present, keeps the older per-body face/edge fingerprint
 * diff that measures alone would miss.
 */

import { buildAndMeasureLocally } from '@/kernel/solveLocally'
import { compareMeasures } from '@/kernel/occ/measureTolerance'
import { partSpecFromText } from '@/utils/partExport'
import { buildBaselineBody } from '@/wasm-kernel/baselineBody'
import type { MeasureRecord } from '@/kernel/occ/measure'
import type {
  RegressionCase,
  RegressionChecks,
  RegressionSnapshot,
  RegressionSnapshotBody,
} from './corpus'

export interface RegressionIssue {
  // The check within the case, e.g. `volume`, `features/<id>`,
  // `snapshot/<body>/face_hashes`.
  check: string
  ours: string
  expected: string
}

export interface RegressionBuild {
  measures: MeasureRecord
  statuses: Record<string, string>
  details: Record<string, string>
  snapshot: RegressionSnapshot
}

export interface RegressionRun extends RegressionBuild {
  issues: RegressionIssue[]
  pass: boolean
}

function formatValue(value: unknown): string {
  return Array.isArray(value) ? `[${value.join(', ')}]` : String(value)
}

/** The recipe's feature ids, the keys `features.except` may name. */
export function recipeFeatureIds(doc: Record<string, unknown>): string[] {
  const features = (doc.features as Array<Record<string, unknown>> | undefined) ?? []
  return features
    .map((feature) => feature.id)
    .filter((id): id is string => typeof id === 'string' && id !== '')
}

/** Build one case from its recipe and reduce the bodies to the snapshot shape. */
export async function buildRegression(name: string, recipe: string): Promise<RegressionBuild> {
  const doc = partSpecFromText(recipe)
  // The case name is the doc id: a document switch resets solveLocally's
  // cross-solve cache, so cases never build on each other's checkpoints.
  doc.id = name
  const built = await buildAndMeasureLocally(doc)
  if (built === null) {
    throw new Error(`regressions/${name}: buildAndMeasureLocally returned null (OCC.js unavailable?)`)
  }

  const statuses: Record<string, string> = {}
  const details: Record<string, string> = {}
  for (const [fid, result] of Object.entries(built.response.result)) {
    const row = result as Record<string, unknown> | null
    if (row === null || typeof row !== 'object') continue
    if (typeof row.status === 'string') statuses[fid] = row.status
    if (typeof row.exception === 'string' && row.exception !== '') details[fid] = row.exception
    else if (typeof row.solver_warning === 'string' && row.solver_warning !== '') details[fid] = row.solver_warning
  }

  const bodies: Record<string, RegressionSnapshotBody> = {}
  for (const [bid, body] of Object.entries(built.response.bodies)) {
    const golden = buildBaselineBody(bid, body as Record<string, unknown>)
    bodies[bid] = {
      created_by: golden.created_by,
      modified_by: golden.modified_by,
      face_hashes: golden.face_hashes,
      edge_hashes: golden.edge_hashes,
    }
  }
  return { measures: built.measures, statuses, details, snapshot: { bodies } }
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort()
}

function sameSorted(a: readonly string[], b: readonly string[]): boolean {
  const left = sorted(a)
  const right = sorted(b)
  return left.length === right.length && left.every((value, i) => value === right[i])
}

function hashSetIssue(check: string, ours: readonly string[], expected: readonly string[]): RegressionIssue | null {
  if (sameSorted(ours, expected)) return null
  const oursSet = new Set(ours)
  const expectedSet = new Set(expected)
  const extra = [...oursSet].filter((hash) => !expectedSet.has(hash)).length
  const missing = [...expectedSet].filter((hash) => !oursSet.has(hash)).length
  return {
    check,
    ours: `${ours.length} hashes (${extra} extra)`,
    expected: `${expected.length} hashes (${missing} missing)`,
  }
}

function snapshotIssues(ours: RegressionSnapshot, expected: RegressionSnapshot): RegressionIssue[] {
  const issues: RegressionIssue[] = []
  const ids = [...new Set([...Object.keys(ours.bodies), ...Object.keys(expected.bodies)])].sort()
  for (const id of ids) {
    const live = ours.bodies[id]
    const want = expected.bodies[id]
    if (live === undefined) {
      issues.push({ check: `snapshot/${id}`, ours: 'missing', expected: 'present' })
      continue
    }
    if (want === undefined) {
      issues.push({ check: `snapshot/${id}`, ours: 'present', expected: 'missing' })
      continue
    }
    if (live.created_by !== want.created_by) {
      issues.push({ check: `snapshot/${id}/created_by`, ours: live.created_by, expected: want.created_by })
    }
    if (!sameSorted(live.modified_by, want.modified_by)) {
      issues.push({
        check: `snapshot/${id}/modified_by`,
        ours: formatValue(sorted(live.modified_by)),
        expected: formatValue(sorted(want.modified_by)),
      })
    }
    for (const field of ['face_hashes', 'edge_hashes'] as const) {
      const issue = hashSetIssue(`snapshot/${id}/${field}`, live[field], want[field])
      if (issue !== null) issues.push(issue)
    }
  }
  return issues
}

/** Compare one live build against a case's checks; pure, no kernel. */
export function regressionIssues(
  checks: RegressionChecks,
  recipeFeatureIdsInRecipe: readonly string[],
  build: RegressionBuild,
): RegressionIssue[] {
  const issues: RegressionIssue[] = []

  for (const id of recipeFeatureIdsInRecipe) {
    const expected = checks.features.except?.[id] ?? checks.features.default
    const live = build.statuses[id]
    if (live === undefined) {
      const detail = build.details[id]
      issues.push({
        check: `features/${id}`,
        ours: detail === undefined ? 'missing' : `missing (${detail})`,
        expected,
      })
    } else if (live !== expected) {
      const detail = build.details[id]
      issues.push({
        check: `features/${id}`,
        ours: detail === undefined ? live : `${live} (${detail})`,
        expected,
      })
    }
  }

  const measured = compareMeasures(build.measures, checks.measures, {
    tolerance: checks.tolerance,
    topology: checks.topology,
  })
  for (const row of measured.rows) {
    if (!row.enforced || row.within) continue
    issues.push({ check: row.measure, ours: formatValue(row.ours), expected: formatValue(row.theirs) })
  }

  return issues
}

/** Build and compare one case. */
export async function runRegressionCase(regressionCase: RegressionCase): Promise<RegressionRun> {
  const doc = partSpecFromText(regressionCase.recipe)
  const featureIds = recipeFeatureIds(doc)
  // Arm the same cross-check the meta-test applies to the real corpus.
  const except = regressionCase.checks.features.except
  if (except !== undefined) {
    for (const id of Object.keys(except)) {
      if (!featureIds.includes(id)) {
        throw new Error(
          `regressions/${regressionCase.name}/checks.json.features.except.${id}: unknown feature id; ` +
          `the recipe has ${featureIds.length} feature(s): ${featureIds.join(', ')}`,
        )
      }
    }
  }

  const build = await buildRegression(regressionCase.name, regressionCase.recipe)
  const issues = regressionIssues(regressionCase.checks, featureIds, build)
  // The snapshot is diffed only when the case carries one; `loadRegressionCase`
  // already enforces `snapshot: true` <=> `snapshot.json`.
  if (regressionCase.snapshot !== null) {
    issues.push(...snapshotIssues(build.snapshot, regressionCase.snapshot))
  }
  return { ...build, issues, pass: issues.length === 0 }
}

/** Render failing rows as `<case>/<check>: ours=... expected=...`. */
export function issueLines(name: string, issues: readonly RegressionIssue[]): string[] {
  return issues.map((issue) => `${name}/${issue.check}: ours=${issue.ours} expected=${issue.expected}`)
}

/** `soft` warns, `hard` fails; `REGRESSION_SOFT=1` downgrades every case. */
export function regressionFailureIsSoft(severity: 'hard' | 'soft', softAll: boolean): boolean {
  return softAll || severity === 'soft'
}
