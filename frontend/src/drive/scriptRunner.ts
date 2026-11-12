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
 * frames, and `offset` (only a fixed mate, and only when the seed translation is
 * non-zero) carried into A's own frame. `overridden` names the keys the same
 * step spelled explicitly, so the captured value did not land there and the
 * document carries the explicit one. Only the assembly drive produces it; a
 * step that captured nothing has no `captured` field at all.
 */
export interface MateCapture {
  flip: boolean
  angle?: number
  // A rotating mate's measured seed roll, report only: never written into the
  // mate, since capturing it would lock the hinge. Signed degrees in
  // (-180, 180], the limit_min/limit_max coordinate, so it copies into a bound
  // as is and `roll + N` opens the hinge N degrees from the seed.
  roll?: number
  // B's anchor delta from A's anchor, in A's local frame (the fixed mate's
  // offset convention); absent when the seed delta is the default zero.
  offset?: [number, number, number]
  overridden?: ('flip' | 'angle' | 'offset')[]
}

/** Which pose a `set_part_fixed` step froze into the instance's seed: the last
 *  solve's transforms (the default bake) or the authored seed (`bake: false`). */
export type KeptPose = 'solved' | 'seed'

/** The part document an `add_step_part` step bound and instanced, so a caller
 *  can name it without guessing the derived doc_id. */
export interface StepPartBinding {
  docId: string
  name: string
  fileId: string
}

export interface ScriptStepOutcome {
  index: number
  kind: 'command' | 'mutation'
  // The command id or the mutation type; both are the step's external name.
  id: string
  ok: boolean
  createdIds: string[]
  // Present only when createdIds omits the constraints (rect, n-gon, mirror,
  // pattern, fillet): their count.
  constraints?: number
  // Present when createdIds leaves the ids out: on an import_dxf or add_text
  // step, or a sketch copy step that created more than
  // MAX_REPORTED_CREATED_IDS ids. How many entities the step added. The
  // document resource has the ids.
  createdCount?: number
  error?: { code: string; message: string }
  // Present only when the step measured an orientation into the document.
  captured?: MateCapture
  // Present when a step replaced a dimension: the old id and the new one that
  // now carries the size. fillet_corners is the only producer today.
  replacedConstraints?: Array<{ from: string; to: string }>
  // Present only on a fixed toggle, which always reports the pose it kept.
  poseKept?: KeptPose
  // Present only on an add_step_part step: the part it bound and instanced.
  part?: StepPartBinding
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
  part?: StepPartBinding
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

// Past this many ids a sketch copy step reports `createdCount` instead, so a
// large pattern or import does not double the reply; the document resource has
// the ids. Assembly pattern steps keep their documented per-copy order, so the
// limit is scoped by step id rather than applied to every reply.
export const MAX_REPORTED_CREATED_IDS = 200
const ALWAYS_COUNTED_STEPS = new Set(['import_dxf', 'add_text'])
const SKETCH_COPY_STEPS = new Set(['mirror_entities', 'pattern_entities', 'fillet_corners'])

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
    const part = 'part' in result ? result.part : undefined
    const constraints = 'constraints' in result ? result.constraints : undefined
    const replacedConstraints = 'replacedConstraints' in result ? result.replacedConstraints : undefined
    // A DXF import or a text run is the bulk case of the reply-size rule: one
    // step can add hundreds of entities, so the reply carries the count and
    // the document resource (or the run's docHash) serves the ids. A sketch
    // copy step (pattern, mirror, fillet) is the other way to cross the limit.
    const counted = ALWAYS_COUNTED_STEPS.has(id)
      || (SKETCH_COPY_STEPS.has(id) && createdIds.length > MAX_REPORTED_CREATED_IDS)
    return {
      index, kind, id, ok: true, createdIds: counted ? [] : createdIds,
      ...(counted && { createdCount: createdIds.length }),
      ...(constraints !== undefined && { constraints }),
      ...(replacedConstraints !== undefined && { replacedConstraints }),
      ...(captured !== undefined && { captured }),
      ...(poseKept !== undefined && { poseKept }),
      ...(part !== undefined && { part }),
    }
  }
  return { index, kind, id, ok: false, createdIds: [], error: { code: result.code, message: result.message } }
}

/**
 * Run steps in order. Each step's Result is recorded; the first failure stops
 * the script unless that step (or the whole run) says continue. `settle` runs
 * after every executed step, so a caller that awaits the script also awaits the
 * solves each step started: the browser bridge passes the session idle, the CLI
 * passes its local scheduler's idle. It receives the outcomes recorded so far,
 * refused tail included, so a caller that has to report a stalled solve can
 * describe the accepted prefix.
 */
export async function runScript<S extends AnyScriptStep = ScriptStep>(
  steps: readonly S[],
  run: ScriptStepRunner<S>,
  settle?: (outcomes: readonly ScriptStepOutcome[]) => Promise<void> | void,
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
    if (settle) await settle(outcomes)
    const continueOnError = isObject(step) && step.continueOnError === true
    if (!outcome.ok && !continueOnError) break
  }
  return { ok: outcomes.every(o => o.ok), steps: outcomes }
}
