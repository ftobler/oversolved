// The action-matrix runner: for every document in a sweep, every enumerated
// target and every command in the part table, it runs one entry on a fresh
// session and classifies the outcome. It never throws on a command result:
// command failures and refusals are data for the baseline, not test errors.
//
// Entry cost is dominated by session and store construction, not by the
// command, so the runner takes a solver factory (fake in the PR gate, real in
// the nightly) and a per-document hook (the real kernel resets its cross-solve
// cache per document there).
import type { PartDoc } from '@/types/cad'
import { PART_COMMAND_SPECS } from '@/pages/commandEntries'
import { createFakeSolveScheduler } from '@/session/__tests__/fakeSolveScheduler'
import type { CommandName } from '@/utils/core/commandNames'
import { createMatrixHarness, installTarget, type MatrixSolver } from './harness'

// Callers of runMatrix construct solvers, so the type is re-exported here
// rather than making every caller reach into harness.ts.
export type { MatrixSolver } from './harness'
import { targetsForSweep, type CorpusDoc, type MatrixTarget } from './corpus'
import type { MatrixRow, MatrixStatus } from './baseline'

// The command set is the real part table, enumerated in its declaration order.
export const PART_COMMANDS: CommandName[] = PART_COMMAND_SPECS.map(spec => spec.id)

// The single part command whose payload carries data; every other spec is
// noParams, which accepts undefined (the same minimal payload commandFixtures
// hands the completeness suite).
const MINIMAL_PARAMS: Partial<Record<CommandName, unknown>> = {
  apply_offset: { distance: 5 },
}

export interface MatrixSweep {
  docs: CorpusDoc[]
  // null sweeps every target of a document.
  maxTargetsPerDoc: number | null
}

export interface MatrixRunOptions {
  createSolver: () => MatrixSolver
  // Called before a document's entries; the real kernel drops its cross-solve
  // cache here so two documents can never share a checkpoint.
  onDocStart?: (doc: CorpusDoc) => void | Promise<void>
  onProgress?: (done: number, message: string) => void
  // A throw out of the solve pipeline is a kernel crash and fails the run; a
  // feature the kernel cannot solve is a status inside the response, not an
  // error, and stays the command's concern.
  failOnSolveError?: boolean
}

export function fakeMatrixSolver(): MatrixSolver {
  const scheduler = createFakeSolveScheduler<PartDoc>()
  return { scheduler, settle: () => scheduler.flush() }
}

// The baseline rows a sweep is expected to contain, by key membership: used by
// the smoke gate to compare a slice of the full baseline exactly (both a row
// that disappeared and a row the slice never saw are deviations).
export function expectedBaselineRows(
  sweep: MatrixSweep,
  baselineRows: readonly MatrixRow[],
): MatrixRow[] {
  const allowed = new Set<string>()
  for (const doc of sweep.docs) {
    for (const target of targetsForSweep(doc.spec, sweep.maxTargetsPerDoc)) {
      allowed.add(`${doc.label}\u0000${target.id}`)
    }
  }
  return baselineRows.filter(row => allowed.has(`${row.doc}\u0000${row.target}`))
}

// Every entry awaits only microtasks, so a long sweep can starve the event
// loop (a worker's RPC pings included) for minutes. Hand the loop a macrotask
// every so often; the cost is unmeasurable at this granularity.
const YIELD_EVERY = 256

function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, 0) })
}

export async function runMatrix(sweep: MatrixSweep, options: MatrixRunOptions): Promise<MatrixRow[]> {
  const rows: MatrixRow[] = []
  for (const doc of sweep.docs) {
    await options.onDocStart?.(doc)
    const targets = targetsForSweep(doc.spec, sweep.maxTargetsPerDoc)
    for (const target of targets) {
      for (const command of PART_COMMANDS) {
        rows.push(await runEntry(doc, target, command, options))
        if (rows.length % YIELD_EVERY === 0) await yieldToEventLoop()
      }
    }
    options.onProgress?.(rows.length, `${doc.label}: ${targets.length} target(s)`)
  }
  return rows
}

async function runEntry(
  doc: CorpusDoc,
  target: MatrixTarget,
  command: CommandName,
  options: MatrixRunOptions,
): Promise<MatrixRow> {
  const solver = options.createSolver()
  const harness = createMatrixHarness(doc.spec, solver)
  const row = (status: MatrixStatus, error: string | null): MatrixRow =>
    ({ doc: doc.label, target: target.id, command, status, error })
  try {
    installTarget(doc.spec, target)
    const enabled = harness.registry.enabled(command)
    if (enabled !== true) return row('refused', enabled)
    const result = await harness.run(command, MINIMAL_PARAMS[command])
    const solveError = harness.session.inspect().solve.lastError
    if ((options.failOnSolveError ?? true) && solveError !== null) {
      throw new Error(`[action-matrix] solve error at ${doc.label} / ${target.id} / ${command}: ${solveError}`)
    }
    if (!result.ok) return row('failed', result.message)
    // A command can succeed and still refuse the action through showMessage
    // (a constraint that does not fit the selection, a not-implemented tool):
    // for the matrix that is the command's refusal, not an ok.
    const refusal = harness.messages[0]
    if (refusal) return row('refused', refusal.message)
    return row('ok', null)
  } finally {
    harness.dispose()
  }
}
