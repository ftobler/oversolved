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
// Replay installs the recorded seed for its duration (restoring the previous
// source afterwards), because a recorded mutation may not embed every id it
// needs: the sugar handlers (add_rect, add_ngon) mint entities and constraints
// internally. A version-1 entry mints under the repro's top-level seed; a
// version-2 entry carries the seed its script step minted under, and replay
// installs it at that entry without deriving it again from a document replay
// may only reach later. Each entry also carries the source position it started
// from, so replay seeks there before applying; ids the recording minted outside
// the session (UI feature ids) advanced that position without being replayed,
// and the seek steps over them. Entries of one step share a seed and continue
// its sequence: the source is only replaced when the recorded seed changes.

import type { PartDoc, Mutation } from '@/types/cad'
import type { Result } from '@/session/result'
import { setIdSource, getIdSource } from '@/utils/yamlMutations'
import { DRIVE_ID_SEED, seededIdSource } from './seededIds'
import { docHashOf } from './docHash'
import { validateMutation } from './mutationCatalog'
import type { ReproPayload } from './journal'

// The largest source position a payload may seek to. A session's journal holds
// at most JOURNAL_CAPACITY entries and one apply mints a few hundred steps at
// most, so a million is orders above any real recording; anything past it (or
// non-finite) is hostile input, and seeking there would spin the generator
// loop instead of failing.
const MAX_REPLAY_MINT_INDEX = 1_000_000

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
  const fallbackSource = seededIdSource(seed)
  // The seed the active source was installed for; null means the fallback.
  let activeStepSeed: number | null = null
  let source = fallbackSource
  setIdSource(source)
  try {
    const baselineHash = hashDoc()
    const steps: ReplayStepResult[] = []
    let ok = baselineHash === repro.docHash
    if (ok) {
      for (let index = 0; index < repro.journal.length; index++) {
        const entry = repro.journal[index]
        // A payload read from disk is external input. A non-finite or absurd
        // mintIndex would hang the seek loop, so it is a loud step failure
        // rather than a clamp: a payload that lies about its position cannot
        // replay, and saying so beats stalling.
        const mintIndex = entry.mintIndex
        if (mintIndex !== undefined
          && (!Number.isInteger(mintIndex) || mintIndex < 0 || mintIndex > MAX_REPLAY_MINT_INDEX)) {
          steps.push({
            index,
            kind: entry.kind,
            ...(entry.label !== undefined && { label: entry.label }),
            ok: false,
            expectedBeforeHash: entry.docHashBefore,
            actualBeforeHash: hashDoc(),
            expectedHash: entry.docHashAfter,
            actualHash: null,
            error: { code: 'invalid-mint-index', message: `entry ${index} mintIndex ${String(mintIndex)} is out of range` },
          })
          ok = false
          break
        }
        // A recorded step seed is external input too, and it addresses the same
        // generator: a value outside the uint32 space is a lying payload.
        const stepSeed = entry.seed
        if (stepSeed !== undefined
          && (typeof stepSeed !== 'number' || !Number.isInteger(stepSeed) || stepSeed < 0 || stepSeed > 0xffffffff)) {
          steps.push({
            index,
            kind: entry.kind,
            ...(entry.label !== undefined && { label: entry.label }),
            ok: false,
            expectedBeforeHash: entry.docHashBefore,
            actualBeforeHash: hashDoc(),
            expectedHash: entry.docHashAfter,
            actualHash: null,
            error: { code: 'invalid-seed', message: `entry ${index} seed ${String(stepSeed)} is not a uint32` },
          })
          ok = false
          break
        }
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
        // A repro read from disk is external input: validate every payload
        // before the cast/apply so a malformed entry reports the mutation
        // refusal, not a bare hash mismatch after a silent no-op.
        const payloads = Array.isArray(entry.payload) ? entry.payload : [entry.payload]
        const validated: Mutation[] = []
        let invalidPayload: { code: string; message: string } | null = null
        for (const [payloadIndex, payload] of payloads.entries()) {
          const validation = validateMutation(payload, { allowInternal: true })
          if (!validation.ok) {
            const where = Array.isArray(entry.payload)
              ? `entry ${index} payload ${payloadIndex}`
              : `entry ${index}`
            invalidPayload = {
              code: validation.error.code,
              message: `${where}: ${validation.error.message}`,
            }
            break
          }
          validated.push(validation.mutation)
        }
        if (invalidPayload) {
          steps.push({
            index,
            kind: entry.kind,
            ...(entry.label !== undefined && { label: entry.label }),
            ok: false,
            expectedBeforeHash: entry.docHashBefore,
            actualBeforeHash,
            expectedHash: entry.docHashAfter,
            actualHash: hashDoc(),
            error: invalidPayload,
          })
          ok = false
          break
        }
        // Switch sources only when the recorded seed changes. A step may make
        // several applies that share one seed and continue its sequence, so
        // resetting the generator per entry would replay a different sequence.
        if (stepSeed !== undefined && stepSeed !== activeStepSeed) {
          source = seededIdSource(stepSeed)
          activeStepSeed = stepSeed
          setIdSource(source)
        } else if (stepSeed === undefined && activeStepSeed !== null) {
          // A legacy entry after a step-seeded one: resume the payload's own
          // generation sequence, which the step entries did not consume.
          source = fallbackSource
          activeStepSeed = null
          setIdSource(source)
        }
        // Resume the active id sequence where the recording started this
        // apply; ids minted outside the session since the last entry are not
        // replayed and the seek steps over them.
        if (mintIndex !== undefined) source.seek(mintIndex)
        let result: Result
        try {
          result = Array.isArray(entry.payload)
            ? session.executeGroup(validated)
            : session.execute(validated[0])
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
