// Journal replay: apply a repro's recorded mutations in order to a fresh
// session and verify every step landed on the recorded hashes. The caller owns
// the session and the baseline load (the CLI and the gated suites share this
// loop); this module owns the verification contract: each step's before-hash
// must chain onto the running doc, its apply must succeed, and its after-hash
// must match the recorded one, all measured synchronously right after the
// apply and BEFORE the step's solve settles. Hashing before the settle is what
// makes record and replay compare the same authored, pre-write-back state;
// settling after the hash lets the next step start from the same baked state
// the recording saw. A divergence stops the replay and is reported with both
// hashes, so a non-reproduction is a precise fact, not a silent failure.
//
// Replay installs the recorded generation seed for its duration (restoring the
// previous source afterwards), because a recorded mutation may not embed every
// id it needs: the sugar handlers (add_rect, add_ngon) mint entities and
// constraints internally. The seed is what the recording minted under, and each
// entry carries the source position it started from, so replay seeks there
// before applying; ids the recording minted outside the session (UI feature
// ids) advanced that position without being replayed, and the seek steps over
// them.

import type { PartDoc, Mutation } from '@/types/cad'
import type { Result } from '@/session/result'
import { setIdSource, getIdSource } from '@/utils/yamlMutations'
import { DRIVE_ID_SEED, seededIdSource } from './seededIds'
import { docHashOf } from './docHash'
import type { ReproPayload } from './journal'

export interface ReplayStepResult {
  index: number
  kind: 'mutation' | 'batch'
  label?: string
  ok: boolean
  expectedBeforeHash: string
  actualBeforeHash: string | null
  expectedHash: string
  actualHash: string | null
  error?: { code: string; message: string }
}

export interface ReplayOutcome {
  ok: boolean
  // The hash of the doc before the first replayed mutation; compared against
  // the repro's own baseline hash.
  baselineHash: string | null
  expectedBaselineHash: string
  steps: ReplayStepResult[]
  finalHash: string | null
}

// The session-shaped executor. Structural, so the CLI's DocSession satisfies it
// without a cast and a test can pass a minimal double.
export interface ReplaySession {
  getDoc(): PartDoc | null
  execute(mutation: Mutation): Result
  executeGroup(mutations: Mutation[]): Result
}

export async function replayJournal(
  repro: ReproPayload,
  session: ReplaySession,
  settle?: () => Promise<void> | void,
): Promise<ReplayOutcome> {
  const hashDoc = (): string | null => (session.getDoc() ? docHashOf(session.getDoc()) : null)
  const previousSource = getIdSource()
  // A payload read from disk is external input: a missing seed falls back to
  // the constant, the best a hand-written payload can do.
  const seed = typeof repro.seed === 'number' && Number.isFinite(repro.seed) ? repro.seed : DRIVE_ID_SEED
  const source = seededIdSource(seed)
  setIdSource(source)
  try {
    const baselineHash = hashDoc()
    const steps: ReplayStepResult[] = []
    let ok = baselineHash === repro.docHash
    if (ok) {
      for (let index = 0; index < repro.journal.length; index++) {
        const entry = repro.journal[index]
        const actualBeforeHash = hashDoc()
        if (actualBeforeHash !== entry.docHashBefore) {
          steps.push({
            index,
            kind: entry.kind,
            ...(entry.label !== undefined && { label: entry.label }),
            ok: false,
            expectedBeforeHash: entry.docHashBefore,
            actualBeforeHash,
            expectedHash: entry.docHashAfter,
            actualHash: null,
          })
          ok = false
          break
        }
        // Resume the generation's id sequence where the recording started this
        // apply; ids minted outside the session since the last entry are not
        // replayed and the seek steps over them.
        if (typeof entry.mintIndex === 'number') source.seek(entry.mintIndex)
        let result: Result
        try {
          result = Array.isArray(entry.payload)
            ? session.executeGroup(entry.payload)
            : session.execute(entry.payload)
        } catch (e) {
          steps.push({
            index,
            kind: entry.kind,
            ...(entry.label !== undefined && { label: entry.label }),
            ok: false,
            expectedBeforeHash: entry.docHashBefore,
            actualBeforeHash,
            expectedHash: entry.docHashAfter,
            actualHash: hashDoc(),
            error: { code: 'thrown', message: e instanceof Error ? e.message : String(e) },
          })
          ok = false
          break
        }
        // Hash before settling: the recorded hash is the authored state, and
        // the settle below bakes solved geometry for the next step.
        const actualHash = hashDoc()
        const stepOk = result.ok && actualHash === entry.docHashAfter
        steps.push({
          index,
          kind: entry.kind,
          ...(entry.label !== undefined && { label: entry.label }),
          ok: stepOk,
          expectedBeforeHash: entry.docHashBefore,
          actualBeforeHash,
          expectedHash: entry.docHashAfter,
          actualHash,
          ...(result.ok ? {} : { error: { code: result.code, message: result.message } }),
        })
        if (!stepOk) {
          ok = false
          break
        }
        if (settle) await settle()
      }
    }
    return {
      ok,
      baselineHash: baselineHash,
      expectedBaselineHash: repro.docHash,
      steps,
      finalHash: hashDoc(),
    }
  } finally {
    setIdSource(previousSource)
  }
}
