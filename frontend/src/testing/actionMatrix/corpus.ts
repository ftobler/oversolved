// The action-matrix corpus: the documents the matrix sweeps, plus the target
// enumerator that turns a document into the selection ids the command table
// reads. The corpus is the frozen 55-spec regression baseline (the same specs
// fullDocRegression replays through the kernel) plus the doc-shaped feature
// fixtures under kernel/features/__fixtures__; the occ fixture tables are case
// inputs for the kernel suites, not documents, so they are not part of the
// matrix. Real documents moved to the folder corpus and are not swept here.
import baseline from '@/wasm-kernel/regression-baseline.json'
import faceExtrudeAfterArrayCut from '@/kernel/features/__fixtures__/faceExtrudeAfterArrayCut.json'
import filletInvalidResultDoc from '@/kernel/features/__fixtures__/filletInvalidResultDoc.json'
import boxWithShellDoc from '@/kernel/features/__fixtures__/boxWithShellDoc.json'
import bossWithHelix from '@/kernel/features/__fixtures__/bossWithHelix.json'
import { loadPartDoc } from '@/persistence/docSchema'
import type { PartDoc, PartFeature } from '@/types/cad'

export interface CorpusDoc {
  label: string
  spec: PartDoc
}

// The PR-gate slice: the doc-shaped fixtures (real bug-report documents) plus
// corpus labels chosen for target coverage (a sketch with entities and
// constraints, a feature modifier, a two-extrude chain). The full sweep widens to
// every corpus document; the target caps must keep SMOKE <= FULL so the smoke
// keys are always a prefix of the baseline.
export const SMOKE_DOC_LABELS: readonly string[] = [
  'fixture:faceExtrudeAfterArrayCut',
  'fixture:filletInvalidResultDoc',
  'rect_sketch_10x10',
  'box_with_fillet',
  'chain_extrude_cut',
]
export const SMOKE_MAX_TARGETS = 6
export const FULL_MAX_TARGETS = 12

// The real-kernel PR-gate slice: the two bug-report fixtures solve at ~60-150
// ms per mutating entry (every entry rebuilds from its own mutation), which
// would add minutes to the default suite. They stay covered by the fake smoke
// gate (statuses are scheduler-independent) and by the full real sweep behind
// ACTION_MATRIX_FULL=1; these three replay in a few seconds.
export const REAL_SMOKE_DOC_LABELS: readonly string[] = [
  'rect_sketch_10x10',
  'box_with_fillet',
  'chain_extrude_cut',
]

interface BaselineEntry {
  label: string
  spec?: PartDoc
}

// A deterministic doc order: baseline order first, fixtures appended. Frozen
// because the baseline rows are keyed by (doc, target, command).
export function corpusDocs(): CorpusDoc[] {
  const docs: CorpusDoc[] = []
  for (const entry of baseline as unknown as BaselineEntry[]) {
    if (entry.spec) docs.push({ label: entry.label, spec: entry.spec })
  }
  // The bug-report fixture is a document like any other, so it goes through
  // the loader: the matrix must sweep docs the app would actually accept.
  const fixture = loadPartDoc(faceExtrudeAfterArrayCut, { name: 'fixture:faceExtrudeAfterArrayCut' })
  if (!fixture.ok) throw new Error(`action-matrix fixture failed to load: ${fixture.error.field} ${fixture.error.message}`)
  docs.push({ label: 'fixture:faceExtrudeAfterArrayCut', spec: fixture.doc })
  docs.push({
    label: 'fixture:filletInvalidResultDoc',
    spec: { version: 1, kind: 'part', features: filletInvalidResultDoc as unknown as PartFeature[] },
  })
  // A shell-containing document: the matrix needs one target for the shell
  // commands (the regression baseline predates the shell kind).
  const shellFixture = loadPartDoc(
    { version: 1, kind: 'part', features: boxWithShellDoc as unknown as PartFeature[] },
    { name: 'box_with_shell' },
  )
  if (!shellFixture.ok) throw new Error(`action-matrix fixture failed to load: ${shellFixture.error.field} ${shellFixture.error.message}`)
  docs.push({ label: 'box_with_shell', spec: shellFixture.doc })
  // A reference-curve producer: the matrix sweeps commands against the helix
  // feature target and confirms a non-body feature does not break the command
  // table (it produces no body to modify).
  const helixFixture = loadPartDoc(bossWithHelix, { name: 'fixture:boss_with_helix' })
  if (!helixFixture.ok) throw new Error(`action-matrix fixture failed to load: ${helixFixture.error.field} ${helixFixture.error.message}`)
  docs.push({ label: 'fixture:boss_with_helix', spec: helixFixture.doc })
  return docs
}

export type MatrixTargetKind = 'none' | 'feature' | 'entity' | 'vertex' | 'constraint'

export interface MatrixTarget {
  // The exact string the UI writes into normalSelection; '<none>' stands for
  // an empty selection.
  id: string
  kind: MatrixTargetKind
  // The feature an element target belongs to, installed as activeFeatureId:
  // an entity/vertex/constraint selection only exists while its sketch (or
  // feature) editor is open, and the store methods gate on that id.
  featureId: string | null
}

// Round-robin across kinds so a capped sweep still covers every target class
// early (features, entities, vertices, constraints), not just the first
// feature's first entity. The full list is the whole document.
function interleave(groups: MatrixTarget[][]): MatrixTarget[] {
  const out: MatrixTarget[] = []
  const longest = Math.max(0, ...groups.map(g => g.length))
  for (let i = 0; i < longest; i++) {
    for (const group of groups) {
      if (i < group.length) out.push(group[i])
    }
  }
  return out
}

export function enumerateTargets(doc: PartDoc): MatrixTarget[] {
  const features: MatrixTarget[] = []
  const entities: MatrixTarget[] = []
  const vertices: MatrixTarget[] = []
  const constraints: MatrixTarget[] = []
  for (const feature of doc.features ?? []) {
    features.push({ id: `@${feature.id}`, kind: 'feature', featureId: null })
    if (feature.kind !== 'sketch') continue
    for (const entity of feature.entities ?? []) {
      entities.push({ id: `entity:${feature.id}:${entity.id}`, kind: 'entity', featureId: feature.id })
      if (entity.kind === 'line') {
        vertices.push({ id: `vertex:${feature.id}:${entity.id}:start`, kind: 'vertex', featureId: feature.id })
        vertices.push({ id: `vertex:${feature.id}:${entity.id}:end`, kind: 'vertex', featureId: feature.id })
      }
    }
    for (const constraint of feature.constraints ?? []) {
      constraints.push({ id: `constraint:${feature.id}:${constraint.id}`, kind: 'constraint', featureId: feature.id })
    }
  }
  return [{ id: '<none>', kind: 'none', featureId: null }, ...interleave([features, entities, vertices, constraints])]
}

// The hidden "none" target is always swept: it pins every command's behavior
// on an empty selection. maxTargets === null sweeps the whole document.
export function targetsForSweep(doc: PartDoc, maxTargets: number | null): MatrixTarget[] {
  const targets = enumerateTargets(doc)
  return maxTargets === null ? targets : targets.slice(0, maxTargets)
}
