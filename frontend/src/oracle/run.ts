/**
 * The reference-oracle runner: builds one recipe through the real solve path
 * (`solveLocally`, the persistent kernel pipeline the app uses), measures the
 * final body set with the shared `measureBodies` record (`occ/measure.ts`),
 * round-trips the whole part through STEP and re-measures, and applies an
 * optional upstream edit to assert persistent naming. Comparison goes through
 * the same `compareMeasures` rows as the translations tier and the CLI/MCP
 * `compare` verb; the oracle enforces topology strictly.
 *
 * The measurement reads the final checkpoint's bodies from the live handle
 * table, so what is measured is exactly what an export would contain. The STEP
 * path mirrors the app's whole-part export: one body serialises alone, several
 * serialise as one compound. The recipe is parsed through `partSpecFromText`,
 * the same loader seam the app's own part load uses.
 */

import type { OccModule, OccShape } from '../kernel/occ/occTypes'
import { DisposeScope } from '../kernel/occ/disposeScope'
import { stepBytesToShape, stepShapeToBytes } from '../kernel/occ/stepIo'
import { measureBodies, type MeasureRecord } from '../kernel/occ/measure'
import { compareMeasures, type MeasureRow } from '../kernel/occ/measureTolerance'
import { persistentTableForTest, solveLocally } from '../kernel/solveLocally'
import { partSpecFromText } from '@/utils/partExport'
import { yieldToEventLoop } from '@/testing/yieldToEventLoop'
import type { BuildState } from '../kernel/types3d'
import { applyOracleEdit, type OracleCase, type OracleMeasures } from './corpus'

/** A compound of `shapes`, or the lone shape when there is only one. */
function compoundOf(oc: OccModule, scope: DisposeScope, shapes: OccShape[]): OccShape {
  if (shapes.length === 1) return shapes[0]
  const builder = scope.track(new oc.BRep_Builder())
  const compound = scope.track(new oc.TopoDS_Compound())
  builder.MakeCompound(compound)
  for (const shape of shapes) builder.Add(compound, shape)
  return compound
}

/** What one build produced: the shared measure records and the solve statuses. */
export interface BuildOutcome {
  measures: MeasureRecord
  stepMeasures: MeasureRecord
  statuses: Record<string, string>
  details: Record<string, string>
}

/** Build a spec and measure the live bodies plus their STEP round trip. */
export async function buildAndMeasure(oc: OccModule, spec: Record<string, unknown>): Promise<BuildOutcome> {
  // Callers loop over whole corpora; one macrotask per build keeps a sweep
  // from holding the event loop for its entire length.
  await yieldToEventLoop()
  const response = await solveLocally(spec)
  if (response === null) {
    // A provisioned environment never returns null; the suite's provisioning
    // guard fails before this can be reached, so a null here is a broken kernel
    // and must not pass as a skip.
    throw new Error('oracle: solveLocally returned null (OCC.js unavailable?)')
  }

  const statuses: Record<string, string> = {}
  const details: Record<string, string> = {}
  for (const [fid, result] of Object.entries(response.result)) {
    const r = result as Record<string, unknown> | null
    if (r !== null && typeof r === 'object' && typeof r.status === 'string') {
      statuses[fid] = r.status
      if (typeof r.exception === 'string' && r.exception !== '') details[fid] = r.exception
      else if (typeof r.solver_warning === 'string' && r.solver_warning !== '') details[fid] = r.solver_warning
    }
  }

  const state = response._build_state as BuildState
  const last = state.feature_order[state.feature_order.length - 1]
  const snapshot = last !== undefined ? state.checkpoints[last]?.body_store_snapshot : undefined
  const table = persistentTableForTest()
  const scope = new DisposeScope()
  try {
    const shapes: OccShape[] = []
    for (const body of Object.values(snapshot ?? {})) {
      if (body.shape == null) continue
      shapes.push(table!.get<OccShape>(body.shape))
    }
    const measures = measureBodies(oc, scope, shapes)

    // The STEP round trip mirrors the app's whole-part export: one body alone,
    // several as one compound. A document with no solid has nothing to
    // serially measure; the (failing) bodies count already names that case.
    let stepMeasures = measureBodies(oc, scope, [])
    if (shapes.length > 0) {
      const bytes = stepShapeToBytes(oc, scope, compoundOf(oc, scope, shapes))
      const imported = scope.track(stepBytesToShape(oc, scope, bytes))
      stepMeasures = measureBodies(oc, scope, [imported])
    }
    return { measures, stepMeasures, statuses, details }
  } finally {
    scope.dispose()
  }
}

/** The long-standing issue wording, rendered from one comparator row. */
function rowIssue(row: MeasureRow, label: string): string {
  const ours = Array.isArray(row.ours) ? `[${row.ours}]` : `${row.ours}`
  const theirs = Array.isArray(row.theirs) ? `[${row.theirs}]` : `${row.theirs}`
  return `${label}${row.measure}: measured ${ours} expected ${theirs}`
}

function measuresIssues(
  actual: MeasureRecord,
  expected: OracleMeasures,
  label: string,
  issues: string[],
): void {
  // The oracle's counts are the persistent-naming assertion, so structural
  // rows are enforced here while translations report them by default.
  const { rows } = compareMeasures(actual, expected, { topology: 'strict' })
  for (const row of rows) {
    if (row.enforced && !row.within) issues.push(rowIssue(row, label))
  }
}

/** STEP re-measures the core integrals only: faces/edges may re-seam on read. */
function stepIssues(actual: MeasureRecord, expected: OracleMeasures, label: string, issues: string[]): void {
  const { rows } = compareMeasures(actual, expected)
  for (const row of rows) {
    if (row.measure === 'bodies' || row.measure === 'faces' || row.measure === 'edges') continue
    if (!row.within) issues.push(rowIssue(row, label))
  }
}

/** The whole run for one case: live build, STEP round trip, optional edit. */
export interface CaseRun {
  live: MeasureRecord
  step: MeasureRecord
  statuses: Record<string, string>
  edited: BuildOutcome | null
  issues: string[]
}

/**
 * The parsed recipe plus the doc id. The id is the case name: a document
 * switch resets solveLocally's cross-solve cache, so cases never build on each
 * other's checkpoints, and the edited run gets its own id to force a full
 * rebuild (persistent naming is about stored picks resolving after a rebuild).
 */
function parseRecipe(oracleCase: OracleCase, id: string): Record<string, unknown> {
  const doc = partSpecFromText(oracleCase.recipe)
  doc.id = id
  return doc
}

export async function runOracleCase(oc: OccModule, oracleCase: OracleCase): Promise<CaseRun> {
  const doc = parseRecipe(oracleCase, oracleCase.name)
  const outcome = await buildAndMeasure(oc, doc)
  const issues: string[] = []
  checkFeatureStatuses(doc, outcome.statuses, outcome.details, issues)
  measuresIssues(outcome.measures, oracleCase.expected, '', issues)
  stepIssues(outcome.stepMeasures, oracleCase.expected, 'step ', issues)

  let edited: BuildOutcome | null = null
  const edit = oracleCase.expected.edit
  if (edit !== undefined) {
    const editedDoc = parseRecipe(oracleCase, `${oracleCase.name}~edit`)
    applyOracleEdit(editedDoc, edit)
    edited = await buildAndMeasure(oc, editedDoc)
    checkFeatureStatuses(editedDoc, edited.statuses, edited.details, issues)
    measuresIssues(edited.measures, edit.expect, 'edit ', issues)
    stepIssues(edited.stepMeasures, edit.expect, 'edit step ', issues)
  }
  return { live: outcome.measures, step: outcome.stepMeasures, statuses: outcome.statuses, edited, issues }
}

/**
 * Every non-sketch feature must solve `ok` with no detail attached (an
 * exception, or an ok-with-warning whose operation did not apply as asked). A
 * sketch's status is its constraint verdict (underconstrained is normal for a
 * minimally dimensioned corpus sketch), but a body feature reporting `partial`
 * or `exception` means the geometry under test is not the geometry the
 * formulas describe.
 */
function checkFeatureStatuses(
  doc: Record<string, unknown>,
  statuses: Record<string, string>,
  details: Record<string, string>,
  issues: string[],
): void {
  const features = (doc.features as Array<Record<string, unknown>>) ?? []
  for (const feature of features) {
    if (feature.kind === 'sketch') continue
    const status = statuses[feature.id as string]
    const detail = details[feature.id as string] ?? ''
    if (status === undefined) issues.push(`feature ${feature.id}: no solve result`)
    else if (status !== 'ok') issues.push(`feature ${feature.id}: status ${status}${detail ? ` (${detail})` : ''}`)
    else if (detail !== '') issues.push(`feature ${feature.id}: ${detail}`)
  }
}
