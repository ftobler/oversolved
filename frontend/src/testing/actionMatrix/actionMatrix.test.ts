// The action-matrix smoke gate: part of the default suite, so it runs without
// OCC.js (the fake scheduler). It replays the committed baseline's smoke slice
// (SMOKE_DOC_LABELS x SMOKE_MAX_TARGETS x every part command) through the real
// command table and compares row by row: a status or error-text change, a row
// the baseline lost and a row the baseline never saw all fail. The full
// corpus sweep lives in actionMatrixReal.test.ts behind ACTION_MATRIX_FULL=1;
// `just ratchet-matrix` runs it.
//
// The baseline was regenerated with npm run regen:action-matrix; its rows are
// the full sweep, and the smoke keys are a deterministic prefix of it.
import { describe, it, expect } from 'vitest'
import baselineFile from './baseline.json'
import { compareMatrix, toBaselineRows, type MatrixBaselineFile, type MatrixRow } from './baseline'
import { corpusDocs, SMOKE_DOC_LABELS, SMOKE_MAX_TARGETS, type CorpusDoc } from './corpus'
import { expectedBaselineRows, fakeMatrixSolver, runMatrix, type MatrixSweep } from './runner'

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
