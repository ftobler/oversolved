// @vitest-environment node
//
// doc-ref-canon: the migration that collapses the two tolerated document
// spellings must change no geometry. Every oracle recipe and every regression
// baseline document is built twice, once as stored (raw YAML / the frozen spec)
// and once through the loader (which rewrites feature refs `$id` -> `@id` and
// folds flat params into the kind sub-dict), and the two builds must agree on
// the measures (volume, area, centroid, bbox, within the shared tolerance) and
// on the face/edge counts. Skips when OCC.js or the Rust solver is absent, like
// every *Real suite.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { parse as parseYaml } from 'yaml'
import baseline from '@/wasm-kernel/regression-baseline.json'
import { loadOcc } from '@/kernel/occ/loadOcc'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { setSketchSolver, resetSketchSolver } from '@/kernel/features/sketch'
import { setSolveLocalsForTest } from '@/kernel/solveLocally'
import { DEFAULT_MEASURE_TOLERANCE, valueWithinTolerance, vectorWithinTolerance } from '@/kernel/occ/measureTolerance'
import type { MeasureRecord } from '@/kernel/occ/measure'
import { partSpecFromText } from '@/utils/partExport'
import { loadPartDoc } from '@/persistence/docSchema'
import { unportedKinds } from '@/kernel/solverRegistry'
import { listOracleCases } from '@/oracle/corpus'
import { buildAndMeasure, type BuildOutcome } from '@/oracle/run'
import type { OccModule } from '@/kernel/occ/occTypes'

const oc = await loadOcc()
const solveBytes = loadSolver()
const ready = oc !== null && solveBytes !== null

interface BaselineEntry {
  label: string
  ok: boolean
  spec?: Record<string, unknown>
}

const baselineEntries = (baseline as unknown as BaselineEntry[]).filter(e => e.ok && e.spec)

/** Two optional vectors agree, including both being absent (an empty body set). */
function sameVector(a: readonly number[] | null, b: readonly number[] | null): boolean {
  if (a === null || b === null) return a === b
  return vectorWithinTolerance(a, b, DEFAULT_MEASURE_TOLERANCE)
}

function diffMeasures(a: MeasureRecord, b: MeasureRecord, label: string): string[] {
  const issues: string[] = []
  if (a.bodies !== b.bodies) issues.push(`${label} bodies: ${a.bodies} vs ${b.bodies}`)
  // An empty body set has no centroid or bbox (both null); when both sides are
  // empty there is nothing further to compare.
  if (a.bodies === 0 && b.bodies === 0) return issues
  if (!valueWithinTolerance(a.volume, b.volume)) issues.push(`${label} volume: ${a.volume} vs ${b.volume}`)
  if (!valueWithinTolerance(a.area, b.area)) issues.push(`${label} area: ${a.area} vs ${b.area}`)
  if (!sameVector(a.centroid, b.centroid)) {
    issues.push(`${label} centroid: [${a.centroid}] vs [${b.centroid}]`)
  }
  if (!sameVector(a.bbox, b.bbox)) {
    issues.push(`${label} bbox: [${a.bbox}] vs [${b.bbox}]`)
  }
  if (a.faces !== b.faces) issues.push(`${label} faces: ${a.faces} vs ${b.faces}`)
  if (a.edges !== b.edges) issues.push(`${label} edges: ${a.edges} vs ${b.edges}`)
  return issues
}

function diffOutcome(before: BuildOutcome, after: BuildOutcome, label: string): string[] {
  return [
    ...diffMeasures(before.measures, after.measures, label),
    ...diffMeasures(before.stepMeasures, after.stepMeasures, `${label} step`),
  ]
}

describe.skipIf(!ready)('doc-ref-canon: migration changes no geometry', () => {
  let occ: OccModule

  beforeAll(() => {
    if (!oc) throw new Error('unreachable: skipIf guards the suite')
    occ = oc
    resetSketchSolver()
    setSketchSolver(solveBytes)
    setSolveLocalsForTest(async () => oc)
  })

  afterAll(() => {
    setSolveLocalsForTest(null)
    resetSketchSolver()
  })

  it('rebuilds every oracle case identically with and without the migration', { timeout: 600_000 }, async () => {
    const issues: string[] = []
    const cases = listOracleCases()
    for (const oracleCase of cases) {
      // `before` is the stored recipe (feature refs still `$id`); `after` is the
      // loader's canonical output. Building both isolates the migration.
      const before = parseYaml(oracleCase.recipe) as Record<string, unknown>
      before.id = oracleCase.name + '~before'
      const after = partSpecFromText(oracleCase.recipe)
      after.id = oracleCase.name + '~after'
      const a = await buildAndMeasure(occ, before)
      const b = await buildAndMeasure(occ, after)
      issues.push(...diffOutcome(a, b, oracleCase.name))
    }
    expect(issues, issues.join('\n')).toEqual([])
  })

  it('rebuilds every regression baseline document identically with and without the migration', { timeout: 600_000 }, async () => {
    const issues: string[] = []
    for (const entry of baselineEntries) {
      const features = (entry.spec!.features as Array<{ kind?: unknown }> | undefined) ?? []
      if (unportedKinds(features).size > 0) continue

      const before = structuredClone(entry.spec!) as Record<string, unknown>
      before.id = entry.label + '~before'
      const loaded = loadPartDoc(structuredClone(entry.spec!))
      if (!loaded.ok) continue
      const after = loaded.doc as Record<string, unknown>
      after.id = entry.label + '~after'

      const a = await buildAndMeasure(occ, before)
      const b = await buildAndMeasure(occ, after)
      issues.push(...diffOutcome(a, b, entry.label))
    }
    expect(issues, issues.join('\n')).toEqual([])
  })
})
