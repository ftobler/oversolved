// The action-matrix smoke gate: part of the default suite, so it runs without
// OCC.js (the fake scheduler). It replays the committed baseline's smoke slice
// (SMOKE_DOC_LABELS x SMOKE_MAX_TARGETS x every part command) through the real
// command table and compares row by row: a status or error-text change, a row
// the baseline lost and a row the baseline never saw all fail. The full
// corpus sweep lives in actionMatrixReal.test.ts behind ACTION_MATRIX_FULL=1;
// `just action-matrix` runs it.
//
// The baseline was regenerated with npm run regen:action-matrix; its rows are
// the full sweep, and the smoke keys are a deterministic prefix of it.
import { describe, it, expect } from 'vitest'
import baselineFile from './baseline.json'
import { okResult, type SessionFailure } from '@/session/result'
import { noParams } from '@/utils/core/commandSpec'
import type { PartCommandSpec } from '@/pages/commandEntries'
import { compareMatrix, toBaselineRows, type MatrixBaselineFile, type MatrixRow } from './baseline'
import { corpusDocs, SMOKE_DOC_LABELS, SMOKE_MAX_TARGETS, targetsForSweep, type CorpusDoc } from './corpus'
import {
  classifyEntry,
  checkSweepCoverage,
  expectedBaselineRows,
  fakeMatrixSolver,
  liveSweepInfo,
  runMatrix,
  type MatrixSweep,
} from './runner'
import type { MatrixHarness } from './harness'

const baselineRows = toBaselineRows((baselineFile as MatrixBaselineFile).rows)

function smokeDocs(): CorpusDoc[] {
  const all = corpusDocs()
  return SMOKE_DOC_LABELS.map(label => {
    const doc = all.find(entry => entry.label === label)
    if (!doc) throw new Error(`smoke doc '${label}' is not in the corpus`)
    return doc
  })
}

const smokeSweep: MatrixSweep = { docs: smokeDocs(), maxTargetsPerDoc: SMOKE_MAX_TARGETS }

describe('the action-matrix comparator', () => {
  const rows: MatrixRow[] = [
    { doc: 'd', target: '<none>', command: 'undo', status: 'refused', error: 'nothing to undo' },
    { doc: 'd', target: '<none>', command: 'add_extrude', status: 'ok', error: null },
  ]

  it('passes when every row matches', () => {
    expect(compareMatrix(rows, rows)).toEqual([])
  })

  it('flags a removed baseline entry, the synthetic removal proof', () => {
    const deviations = compareMatrix(rows, rows.slice(0, 1))
    expect(deviations).toHaveLength(1)
    expect(deviations[0]).toContain('add_extrude')
    expect(deviations[0]).toContain('missing')
  })

  it('flags a status flip', () => {
    const changed: MatrixRow = { ...rows[0], status: 'ok', error: null }
    const deviations = compareMatrix(rows, [changed, rows[1]])
    expect(deviations.some(d => d.includes('refused -> ok'))).toBe(true)
  })

  it('flags error-text drift under the same status', () => {
    const changed: MatrixRow = { ...rows[0], error: 'different wording' }
    const deviations = compareMatrix(rows, [changed, rows[1]])
    expect(deviations.some(d => d.includes('error text changed'))).toBe(true)
  })

  it('flags a new entry as needing an explicit baseline update', () => {
    const deviations = compareMatrix(rows, [...rows, { doc: 'd', target: 't', command: 'redo', status: 'ok', error: null }])
    expect(deviations.some(d => d.includes('new entry'))).toBe(true)
  })

  it('subset mode ignores baseline rows outside the replayed slice', () => {
    expect(compareMatrix(rows, rows.slice(0, 1), { subset: true })).toEqual([])
  })
})

describe('the synthetic origin-pair target', () => {
  it('is swept past the target cap on its corpus document', () => {
    const doc = corpusDocs().find(entry => entry.label === 'box_with_hole')
    expect(doc).toBeDefined()
    const targets = targetsForSweep(doc!, 1)
    // The cap keeps the ordinary first target, and the pair is appended rather
    // than displacing it.
    expect(targets[0].id).toBe('<none>')
    const pair = targets.find(target => target.selection !== undefined)
    expect(pair).toBeDefined()
    expect(pair!.selection![0]).toBe('@builtin_origin')
    expect(pair!.selection![1]).toMatch(/^vertex:/)
  })
})

describe('the action-matrix sweep coverage ratchet', () => {
  // One empty document sweeps exactly one target ('<none>') at a cap of one,
  // so the fixture is small enough to name every deviation precisely.
  const doc: CorpusDoc = { label: 'd', spec: { version: 1, kind: 'part', features: [] } }
  const sweep: MatrixSweep = { docs: [doc], maxTargetsPerDoc: 1 }
  const info = liveSweepInfo(sweep)
  const rows: MatrixRow[] = [
    { doc: 'd', target: '<none>', command: 'undo', status: 'refused', error: 'nothing to undo' },
  ]

  it('passes when the baseline covers exactly the live sweep', () => {
    expect(checkSweepCoverage(sweep, rows, info)).toEqual([])
  })

  it('names a baseline row whose document the sweep no longer enumerates', () => {
    const deviations = checkSweepCoverage(sweep, [], info)
    expect(deviations).toContain("doc 'd': swept but absent from the baseline (regenerate and review)")
  })

  it('names a document the baseline still holds after it left the corpus', () => {
    const extra: MatrixRow = { ...rows[0], doc: 'gone' }
    const deviations = checkSweepCoverage(sweep, [rows[0], extra], info)
    expect(deviations).toContain("doc 'gone': in the baseline but no longer swept (a vanished document)")
  })

  it('names a target the enumerator stopped yielding', () => {
    const extra: MatrixRow = { ...rows[0], target: '@old_feature' }
    const deviations = checkSweepCoverage(sweep, [rows[0], extra], info)
    expect(deviations).toContain("target 'd / @old_feature': in the baseline but no longer enumerated")
  })

  it('flags a swept target the baseline never recorded', () => {
    const renamed: MatrixRow = { ...rows[0], target: '@new_feature' }
    const deviations = checkSweepCoverage(sweep, [renamed], info)
    expect(deviations.some(d => d.includes("target 'd / <none>': swept but absent from the baseline"))).toBe(true)
    expect(deviations.some(d => d.includes("target 'd / @new_feature': in the baseline"))).toBe(true)
  })

  it('flags every drifted header field', () => {
    expect(checkSweepCoverage(sweep, rows, { ...info, docs: 2 })).toContain('baseline sweep.docs is 2, the live sweep is 1')
    expect(checkSweepCoverage(sweep, rows, { ...info, commands: 1 })).toContain(
      `baseline sweep.commands is 1, the live sweep is ${info.commands}`,
    )
    expect(checkSweepCoverage(sweep, rows, { ...info, maxTargetsPerDoc: null })).toContain(
      'baseline sweep.maxTargetsPerDoc is null, the live sweep is 1',
    )
  })
})

// The store-driven failure path, which used to be unreachable: a command body
// can return ok while the mutation it dispatched through the store seam failed
// (the UI surfaces that through failLoud). The classifier has to record it as
// failed, and the runner has to reach that classification from an entry.
describe('the action-matrix entry classification', () => {
  it('classifies a store-driven mutation failure as failed, over a refusal message', () => {
    const failure: SessionFailure = { ok: false, code: 'rollback-unsynced', message: 'set_rollback dispatched with the rollback store not pre-synced' }
    expect(classifyEntry(okResult(), [{ title: 'Cannot apply', message: 'refused by message', variant: 'error' }], [failure]))
      .toEqual({ status: 'failed', error: 'rollback-unsynced: set_rollback dispatched with the rollback store not pre-synced' })
  })

  it('records a failing entry and the comparator reports it', { timeout: 60_000 }, async () => {
    // A synthetic command with a store body's shape: dispatch through the seam,
    // return ok. The mutation is a set_rollback the harness never pre-synced,
    // so the session refuses it with rollback-unsynced. Replacing
    // apply_horizontal keeps this out of the committed corpus baseline.
    const failingSpec = (harness: MatrixHarness): PartCommandSpec => ({
      id: 'apply_horizontal',
      label: 'contract failing command',
      params: noParams(),
      enabled: () => true,
      undoable: true,
      run: () => {
        harness.handleMutation({ type: 'set_rollback', position: 3 })
        return okResult()
      },
    })
    const tiny: CorpusDoc = { label: 'contract:tiny', spec: { version: 1, kind: 'part', features: [] } }
    const sweep: MatrixSweep = { docs: [tiny], maxTargetsPerDoc: 1 }

    const rows = await runMatrix(sweep, {
      createSolver: fakeMatrixSolver,
      extraSpecs: harness => [failingSpec(harness)],
    })

    const entry = rows.find(row => row.command === 'apply_horizontal')
    expect(entry).toEqual({
      doc: 'contract:tiny',
      target: '<none>',
      command: 'apply_horizontal',
      status: 'failed',
      error: 'rollback-unsynced: set_rollback dispatched with the rollback store not pre-synced',
    })
    // A baseline that had the entry as ok now deviates with the failure text.
    const deviations = compareMatrix([{ ...entry!, status: 'ok', error: null }], rows, { subset: true })
    expect(deviations.some(deviation => deviation.includes('status ok -> failed'))).toBe(true)
  })
})

describe('the action-matrix smoke gate (fake scheduler)', () => {
  it('replays the smoke slice without a deviation', { timeout: 120_000 }, async () => {
    expect(baselineRows.length, 'baseline is empty; run npm run regen:action-matrix').toBeGreaterThan(0)
    const current = await runMatrix(smokeSweep, { createSolver: fakeMatrixSolver })
    const expected = expectedBaselineRows(smokeSweep, baselineRows)
    // The committed baseline must cover the whole slice: a slice the baseline
    // never saw means the sweep config and the baseline have drifted apart.
    expect(expected.length).toBe(current.length)
    expect(compareMatrix(expected, current)).toEqual([])

    // The synthetic-removal proof on the live baseline rows, not a fixture:
    // dropping one real row from the expected side shows up as a row the
    // baseline never saw, which is the same deviation class a new command or
    // an unexpected corpus entry produces.
    const deviations = compareMatrix(expected.slice(1), current)
    expect(deviations.some(deviation => deviation.includes('new entry'))).toBe(true)
  })
})
