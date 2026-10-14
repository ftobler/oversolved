// The action-matrix baseline contract: the row shape the runner produces, the
// comparison that turns a replayed sweep into regression text, and the on-disk
// format. Rows are keyed by (doc, target, command); a baseline entry that
// disappears, changes status or changes its error text is a regression, and a
// row the baseline never saw is a new entry that has to be added explicitly by
// regenerating and reviewing the diff.
//
// The file is written one row per line so `git diff` shows exactly which
// entries moved, in the same spirit as the regression corpus.
import type { CommandName } from '@/utils/core/commandNames'

export type MatrixStatus = 'ok' | 'failed' | 'refused'

export interface MatrixRow {
  doc: string
  target: string
  command: CommandName
  status: MatrixStatus
  // The refusal reason, the failure message, or null for ok. Part of the
  // comparison: a failure that changes wording is a real change reviewers see.
  error: string | null
}

export type MatrixRowTuple = [string, string, string, MatrixStatus, string | null]

export interface MatrixSweepInfo {
  docs: number
  maxTargetsPerDoc: number | null
  commands: number
}

export interface MatrixBaselineFile {
  note: string
  sweep: MatrixSweepInfo
  rows: MatrixRowTuple[]
}

const KEY_SEPARATOR = '\u0000'

export function rowKey(row: Pick<MatrixRow, 'doc' | 'target' | 'command'>): string {
  return `${row.doc}${KEY_SEPARATOR}${row.target}${KEY_SEPARATOR}${row.command}`
}

function describe(row: MatrixRow): string {
  return `${row.doc} / ${row.target} / ${row.command}`
}

// Compares a replayed sweep against the baseline. `subset` drops the
// missing-row pass, for the PR-gate replay of a slice of the baseline; the
// full sweep uses the exact form, so a row that vanishes is caught too.
export function compareMatrix(
  baseline: readonly MatrixRow[],
  current: readonly MatrixRow[],
  options: { subset?: boolean } = {},
): string[] {
  const expected = new Map(baseline.map(row => [rowKey(row), row]))
  const deviations: string[] = []
  const seen = new Set<string>()
  for (const row of current) {
    const key = rowKey(row)
    seen.add(key)
    const base = expected.get(key)
    if (!base) {
      deviations.push(`${describe(row)}: new entry, not in the baseline (regenerate with npm run regen:action-matrix and review)`)
      continue
    }
    if (base.status !== row.status) {
      const tail = row.error ? ` (${row.error})` : ''
      deviations.push(`${describe(row)}: status ${base.status} -> ${row.status}${tail}`)
    } else if ((base.error ?? '') !== (row.error ?? '')) {
      deviations.push(`${describe(row)}: error text changed: ${JSON.stringify(base.error)} -> ${JSON.stringify(row.error)}`)
    }
  }
  if (!options.subset) {
    for (const row of baseline) {
      if (!seen.has(rowKey(row))) deviations.push(`${describe(row)}: entry missing from the sweep`)
    }
  }
  return deviations
}

export function toBaselineRows(tuples: readonly MatrixRowTuple[]): MatrixRow[] {
  return tuples.map(([doc, target, command, status, error]) => ({
    doc,
    target,
    command: command as CommandName,
    status,
    error,
  }))
}

export function sortRows(rows: readonly MatrixRow[]): MatrixRow[] {
  return [...rows].sort((a, b) => (
    a.doc.localeCompare(b.doc) || a.target.localeCompare(b.target) || a.command.localeCompare(b.command)
  ))
}

// One row per line: the file's job is a reviewable diff, not pretty printing.
export function serializeBaseline(rows: readonly MatrixRow[], sweep: MatrixSweepInfo): string {
  const tuples = sortRows(rows).map(row => [row.doc, row.target, row.command, row.status, row.error] as MatrixRowTuple)
  const lines = tuples.map(tuple => `    ${JSON.stringify(tuple)}`).join(',\n')
  const note = 'Action-matrix baseline: doc / target / command -> status + error. Regenerate with npm run regen:action-matrix and review the row diff.'
  return `{\n  "note": ${JSON.stringify(note)},\n  "sweep": ${JSON.stringify(sweep)},\n  "rows": [\n${lines}\n  ]\n}\n`
}
