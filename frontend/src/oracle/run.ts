/**
 * The reference-oracle runner: builds one recipe through the real solve path
 * (`solveLocally`, the persistent kernel pipeline the app uses), measures the
 * final body set with OCC GProp (volume, surface area, centroid) and Bnd_Box
 * (exact bbox), round-trips the whole part through STEP and re-measures, and
 * applies an optional upstream edit to assert persistent naming.
 *
 * The measurement reads the final checkpoint's bodies from the live handle
 * table, so what is measured is exactly what an export would contain. The STEP
 * path mirrors the app's whole-part export: one body serialises alone, several
 * serialise as one compound. The recipe is parsed through `partSpecFromText`,
 * the same loader seam the app's own part load uses.
 */

import type { OccModule, OccShape } from '../kernel/occ/occTypes'
import { DisposeScope } from '../kernel/occ/disposeScope'
import { canonicalEdges, canonicalFaces } from '../kernel/occ/bodyNames'
import { stepBytesToShape, stepShapeToBytes } from '../kernel/occ/stepIo'
import {
  DEFAULT_MEASURE_TOLERANCE,
  valueWithinTolerance,
  vectorWithinTolerance,
} from '../kernel/occ/measureTolerance'
import { persistentTableForTest, solveLocally } from '../kernel/solveLocally'
import { partSpecFromText } from '@/utils/partExport'
import { yieldToEventLoop } from '@/testing/yieldToEventLoop'
import type { BuildState } from '../kernel/types3d'
import { applyOracleEdit, type OracleCase, type OracleMeasures } from './corpus'

/** How one body's measures aggregate: sum, volume-weighted, union. */
function emptyMeasures(): OracleMeasures {
  return {
    bodies: 0,
    volume: 0,
    area: 0,
    centroid: [0, 0, 0],
    bbox: [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity],
    faces: 0,
    edges: 0,
  }
}

function addBody(acc: OracleMeasures, body: Omit<OracleMeasures, 'bodies'>): void {
  acc.bodies += 1
  acc.volume += body.volume
  acc.area += body.area
  for (let i = 0; i < 3; i++) acc.centroid[i] += body.volume * body.centroid[i]
  for (let i = 0; i < 3; i++) {
    acc.bbox[i] = Math.min(acc.bbox[i], body.bbox[i])
    acc.bbox[i + 3] = Math.max(acc.bbox[i + 3], body.bbox[i + 3])
  }
  acc.faces = (acc.faces ?? 0) + (body.faces ?? 0)
  acc.edges = (acc.edges ?? 0) + (body.edges ?? 0)
}

function finalize(acc: OracleMeasures): OracleMeasures {
  if (acc.volume !== 0) {
    for (let i = 0; i < 3; i++) acc.centroid[i] /= acc.volume
  }
  return acc
}

/** Measure one shape in full: volume, area, centroid, exact bbox, counts. */
export function measureShape(oc: OccModule, scope: DisposeScope, shape: OccShape): Omit<OracleMeasures, 'bodies'> {
  const vprops = scope.track(new oc.GProp_GProps_1())
  oc.BRepGProp.VolumeProperties_1(shape, vprops, true, false, false)
  const volume = vprops.Mass()
  const c = vprops.CentreOfMass()
  const centroid: [number, number, number] = [c.X(), c.Y(), c.Z()]
  c.delete()

  const sprops = scope.track(new oc.GProp_GProps_1())
  oc.BRepGProp.SurfaceProperties_1(shape, sprops, false, false)
  const area = sprops.Mass()

  const box = scope.track(new oc.Bnd_Box_1())
  oc.BRepBndLib.Add(shape, box, false)
  const bbox: [number, number, number, number, number, number] = [
    box.GetXmin(), box.GetYmin(), box.GetZmin(),
    box.GetXmax(), box.GetYmax(), box.GetZmax(),
  ]

  return {
    volume,
    area,
    centroid,
    bbox,
    faces: canonicalFaces(oc, scope, shape).length,
    edges: canonicalEdges(oc, scope, shape).length,
  }
}

/** A compound of `shapes`, or the lone shape when there is only one. */
function compoundOf(oc: OccModule, scope: DisposeScope, shapes: OccShape[]): OccShape {
  if (shapes.length === 1) return shapes[0]
  const builder = scope.track(new oc.BRep_Builder())
  const compound = scope.track(new oc.TopoDS_Compound())
  builder.MakeCompound(compound)
  for (const shape of shapes) builder.Add(compound, shape)
  return compound
}

/** What one build produced: the measures and the per-feature solve statuses. */
export interface BuildOutcome {
  measures: OracleMeasures
  stepMeasures: OracleMeasures
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
    const acc = emptyMeasures()
    for (const body of Object.values(snapshot ?? {})) {
      if (body.shape == null) continue
      const shape = table!.get<OccShape>(body.shape)
      shapes.push(shape)
      addBody(acc, measureShape(oc, scope, shape))
    }
    const measures = finalize(acc)

    // The STEP round trip mirrors the app's whole-part export: one body alone,
    // several as one compound. A document with no solid has nothing to
    // serially measure; the (failing) bodies count already names that case.
    const stepMeasures = emptyMeasures()
    if (shapes.length > 0) {
      const bytes = stepShapeToBytes(oc, scope, compoundOf(oc, scope, shapes))
      const imported = scope.track(stepBytesToShape(oc, scope, bytes))
      addBody(stepMeasures, measureShape(oc, scope, imported))
    }
    return { measures, stepMeasures: finalize(stepMeasures), statuses, details }
  } finally {
    scope.dispose()
  }
}

function numberIssue(label: string, actual: number, expected: number, issues: string[]): void {
  if (!valueWithinTolerance(actual, expected)) {
    issues.push(`${label}: measured ${actual} expected ${expected}`)
  }
}

function measuresIssues(
  actual: OracleMeasures,
  expected: OracleMeasures,
  label: string,
  issues: string[],
): void {
  if (actual.bodies !== expected.bodies) {
    issues.push(`${label}bodies: measured ${actual.bodies} expected ${expected.bodies}`)
  }
  numberIssue(`${label}volume`, actual.volume, expected.volume, issues)
  numberIssue(`${label}area`, actual.area, expected.area, issues)
  if (!vectorWithinTolerance(actual.centroid, expected.centroid, DEFAULT_MEASURE_TOLERANCE)) {
    issues.push(`${label}centroid: measured [${actual.centroid}] expected [${expected.centroid}]`)
  }
  if (!vectorWithinTolerance(actual.bbox, expected.bbox, DEFAULT_MEASURE_TOLERANCE)) {
    issues.push(`${label}bbox: measured [${actual.bbox}] expected [${expected.bbox}]`)
  }
  if (expected.faces !== undefined && actual.faces !== expected.faces) {
    issues.push(`${label}faces: measured ${actual.faces} expected ${expected.faces}`)
  }
  if (expected.edges !== undefined && actual.edges !== expected.edges) {
    issues.push(`${label}edges: measured ${actual.edges} expected ${expected.edges}`)
  }
}

/** STEP re-measures the core integrals only: faces/edges may re-seam on read. */
function stepIssues(actual: OracleMeasures, expected: OracleMeasures, label: string, issues: string[]): void {
  numberIssue(`${label}volume`, actual.volume, expected.volume, issues)
  numberIssue(`${label}area`, actual.area, expected.area, issues)
  if (!vectorWithinTolerance(actual.centroid, expected.centroid, DEFAULT_MEASURE_TOLERANCE)) {
    issues.push(`${label}centroid: measured [${actual.centroid}] expected [${expected.centroid}]`)
  }
  if (!vectorWithinTolerance(actual.bbox, expected.bbox, DEFAULT_MEASURE_TOLERANCE)) {
    issues.push(`${label}bbox: measured [${actual.bbox}] expected [${expected.bbox}]`)
  }
}

/** The whole run for one case: live build, STEP round trip, optional edit. */
export interface CaseRun {
  live: OracleMeasures
  step: OracleMeasures
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
