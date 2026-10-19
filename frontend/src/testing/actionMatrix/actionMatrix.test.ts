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
import { corpusDocs, SMOKE_DOC_LABELS, SMOKE_MAX_TARGETS, type CorpusDoc } from './corpus'
import {
  classifyEntry,
  expectedBaselineRows,
  fakeMatrixSolver,
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
