// The one script semantics every driver shares: the browser bridge, the node
// CLI and the tests all run their steps through this loop, so "stops on the
// first error unless told otherwise" cannot drift between surfaces. A step is
// either a command id with its params (the external vocabulary) or a raw
// mutation (the deterministic path scripts use to author geometry the command
// table has no id for, e.g. add_rect). The runner itself knows nothing about
// registries or sessions: the caller supplies the one step executor.

import type { Mutation } from '@/types/cad'
import type { CommandResult } from '@/utils/core/commandSpec'
import type { Result } from '@/session/result'

// A failure from outside the registry/session vocabularies: the bridge's own
// guard for a throwing executor. Kept here so the runner accepts it without
// importing the bridge module back.
export interface ScriptFailure {
  ok: false
  code: string
  message: string
}

export type ScriptStep =
  | { command: string; params?: unknown; continueOnError?: boolean }
  | { mutation: Mutation; continueOnError?: boolean }

/** The shape the loop reads from any step: a command id or a typed mutation.
 *  The assembly drive has its own mutation union, so the runner is generic over
 *  the step type and this is the constraint both satisfy. */
export type AnyScriptStep =
  | { command: string; params?: unknown; continueOnError?: boolean }
  | { mutation: { type: string }; continueOnError?: boolean }

/**
 * What a `capture: true` mate step measured at the instances' seeds and froze
 * into the document: `flip` from which way the two anchor axes point, `angle`
 * (only for the kinds that read a roll) from the roll between their canonical
 * frames. `overridden` names the keys the same step spelled explicitly, so the
 * captured value did not land there and the document carries the explicit one.
 * Only the assembly drive produces it; a step that captured nothing has no
 * `captured` field at all.
 */
export interface MateCapture {
  flip: boolean
  angle?: number
  overridden?: ('flip' | 'angle')[]
}

/** Which pose a `set_part_fixed` step froze into the instance's seed: the last
 *  solve's transforms (the default bake) or the authored seed (`bake: false`). */
export type KeptPose = 'solved' | 'seed'

export interface ScriptStepOutcome {
  index: number
  kind: 'command' | 'mutation'
  // The command id or the mutation type; both are the step's external name.
  id: string
  ok: boolean
  createdIds: string[]
  // Present only when createdIds omits the constraints (rect, n-gon): their count.
  constraints?: number
  error?: { code: string; message: string }
  // Present only when the step measured an orientation into the document.
  captured?: MateCapture
  // Present only on a fixed toggle, which always reports the pose it kept.
  poseKept?: KeptPose
}

export interface ScriptRunOutcome {
  ok: boolean
  steps: ScriptStepOutcome[]
}

// A step's result: the registry Result, the session Result, a bridge failure,
// an assembly success decorated with what it wrote (the capture report, the
// pose a fixed toggle kept), or null for the adapter's "no document" no-op.
// Anything else (a thrown exception) is caught here and recorded as an error
// outcome, never allowed to abort the script silently. A runner may be
// asynchronous (the assembly session awaits an OCC bundle build to resolve a
// mate ref); the loop awaits it, so the sync runners are unchanged.
export type ScriptStepResult = CommandResult | Result | AnnotatedSuccess | ScriptFailure | null

/** A success that also reports what the step wrote into the document: the
 *  assembly session's only decorated result (see MateCapture, KeptPose). Every
 *  other runner returns a plain SessionSuccess, which this shape extends. */
export interface AnnotatedSuccess {
  ok: true
  createdIds: string[]
  captured?: MateCapture
  poseKept?: KeptPose
}

export type ScriptStepRunner<S extends AnyScriptStep = ScriptStep> = (step: S) => ScriptStepResult | Promise<ScriptStepResult>

function isObject(value: unknown): value is { [key: string]: unknown } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stepKind(step: unknown): 'command' | 'mutation' {
  return isObject(step) && 'command' in step ? 'command' : 'mutation'
}

// The step id is read defensively: a JSON script can carry `{}` or a null
// mutation, and reading `.mutation.type` there used to crash the runner inside
// both the outcome builder and the catch block.
function stepId(step: unknown): string {
  if (isObject(step)) {
    if (typeof step.command === 'string') return step.command
    const mutation = step.mutation
    if (isObject(mutation) && typeof mutation.type === 'string') return mutation.type
  }
  return 'invalid-step'
}

// Structural step failures are step outcomes, not thrown exceptions: a caller
// needs the index and the reason even when the payload is not a step at all.
function malformedStep(index: number, step: unknown): ScriptStepOutcome | null {
  if (!isObject(step)) {
    return {
      index, kind: 'mutation', id: 'invalid-step', ok: false, createdIds: [],
      error: { code: 'invalid-step', message: `step ${index} must be an object` },
    }
  }
  if ('command' in step) {
    if (typeof step.command !== 'string' || step.command.length === 0) {
      return {
        index, kind: 'command', id: 'invalid-step', ok: false, createdIds: [],
        error: { code: 'invalid-step', message: `step ${index} needs a command id` },
      }
    }
    return null
  }
  if (!('mutation' in step) || !isObject(step.mutation)) {
    return {
      index, kind: 'mutation', id: 'invalid-step', ok: false, createdIds: [],
      error: { code: 'invalid-mutation', message: `step ${index} needs a command or a mutation` },
    }
  }
  return null
}

function outcomeFor(index: number, step: unknown, result: ScriptStepResult): ScriptStepOutcome {
  const kind = stepKind(step)
  const id = stepId(step)
  if (result === null) {
    return {
      index, kind, id, ok: false, createdIds: [],
      error: { code: 'no-document', message: 'no document is open to apply the step to' },
    }
  }
  if (result.ok) {
    // The registry's CommandResult and the session's Result both carry
    // createdIds on success; the failure shapes carry code/message. The two
    // assembly annotations ride only on the decorated success, so a step that
    // captured nothing or kept no pose reports neither.
    const createdIds = 'createdIds' in result ? result.createdIds : []
    const captured = 'captured' in result ? result.captured : undefined
    const poseKept = 'poseKept' in result ? result.poseKept : undefined
    const constraints = 'constraints' in result ? result.constraints : undefined
    return {
      index, kind, id, ok: true, createdIds,
      ...(constraints !== undefined && { constraints }),
      ...(captured !== undefined && { captured }),
      ...(poseKept !== undefined && { poseKept }),
    }
  }
  return { index, kind, id, ok: false, createdIds: [], error: { code: result.code, message: result.message } }
}

/**
 * Run steps in order. Each step's Result is recorded; the first failure stops
 * the script unless that step (or the whole run) says continue. `settle` runs
 * after every executed step, so a caller that awaits the script also awaits the
 * solves each step started: the browser bridge passes the session idle, the CLI
 * passes its local scheduler's idle.
 */
export async function runScript<S extends AnyScriptStep = ScriptStep>(
  steps: readonly S[],
  run: ScriptStepRunner<S>,
  settle?: () => Promise<void> | void,
): Promise<ScriptRunOutcome> {
  const outcomes: ScriptStepOutcome[] = []
  for (let index = 0; index < steps.length; index++) {
    const step = steps[index]
    const malformed = malformedStep(index, step)
    let outcome: ScriptStepOutcome
    if (malformed) {
      outcome = malformed
    } else {
      try {
        outcome = outcomeFor(index, step, await run(step))
      } catch (e) {
        outcome = {
          index,
          kind: stepKind(step),
          id: stepId(step),
          ok: false,
          createdIds: [],
          error: { code: 'thrown', message: e instanceof Error ? e.message : String(e) },
        }
      }
    }
    outcomes.push(outcome)
    if (settle) await settle()
    const continueOnError = isObject(step) && step.continueOnError === true
    if (!outcome.ok && !continueOnError) break
  }
  return { ok: outcomes.every(o => o.ok), steps: outcomes }
}
