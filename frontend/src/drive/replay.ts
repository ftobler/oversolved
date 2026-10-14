// Journal replay: execute a repro's commands in order against the same
// baseline document and verify every step landed on the recorded hash. The
// caller owns the session and the baseline load (the CLI and the gated test
// share this loop); this module owns the verification contract: a step whose
// Result failed or whose resulting doc hash differs from the journal stops the
// replay and is reported with both hashes, so a non-reproduction is a precise
// fact, not a silent divergence.

import type { CommandResult } from '@/utils/core/commandSpec'
import type { ReproPayload } from './journal'

export interface ReplayStepResult {
  index: number
  commandId: string
  ok: boolean
  expectedHash: string
  actualHash: string | null
  error?: { code: string; message: string }
}

export interface ReplayOutcome {
  ok: boolean
  // The hash of the doc before the first replayed command; compared against
  // the repro's own baseline hash.
  baselineHash: string | null
  expectedBaselineHash: string
  steps: ReplayStepResult[]
  finalHash: string | null
}

// The registry-shaped executor, with string ids: the closed CommandName union
// lives at the spec table, while a repro read from disk is external input. A
// method declaration (not a function property) so CommandRegistry satisfies it
// structurally without a cast.
export interface ReplayExecutor {
  execute(commandId: string, params: unknown): CommandResult
}

export async function replayJournal(
  repro: ReproPayload,
  executor: ReplayExecutor,
  hashDoc: () => string | null,
  settle?: () => Promise<void> | void,
): Promise<ReplayOutcome> {
  const baselineHash = hashDoc()
  const steps: ReplayStepResult[] = []
  let ok = baselineHash === repro.docHash
  if (ok) {
    for (let index = 0; index < repro.journal.length; index++) {
      const entry = repro.journal[index]
      let result: CommandResult
      try {
        result = executor.execute(entry.commandId, entry.params ?? undefined)
      } catch (e) {
        steps.push({
          index,
          commandId: entry.commandId,
          ok: false,
          expectedHash: entry.docHashAfter,
          actualHash: hashDoc(),
          error: { code: 'thrown', message: e instanceof Error ? e.message : String(e) },
        })
        ok = false
        break
      }
      if (settle) await settle()
      const actualHash = hashDoc()
      const stepOk = result.ok && actualHash === entry.docHashAfter
      steps.push({
        index,
        commandId: entry.commandId,
        ok: stepOk,
        expectedHash: entry.docHashAfter,
        actualHash,
        ...(result.ok ? {} : { error: { code: result.code, message: result.message } }),
      })
      if (!stepOk) {
        ok = false
        break
      }
    }
  }
  return {
    ok,
    baselineHash,
    expectedBaselineHash: repro.docHash,
    steps,
    finalHash: hashDoc(),
  }
}
