// The kernel half of the part editor's measurement readout: one worker request
// per kernel cell, debounced, keyed to the solve it was asked against.
//
// A readout is view state. The hook owns the only main-thread state a
// measurement has (the pending key and the last reply), writes no document and
// records no undo entry. It renders nothing for a refusal: a stale generation, an
// unresolved element and a dead Worker are all "no answer", never an error
// banner. The debounce and staleness machinery is `useKernelAsk`, shared with
// the assembly's kernel measure.
import type { LengthUnit } from '@/types/cad'
import { measureViaWorker, type MeasureReply } from '@/kernel/worker/solverClient'
import type { MeasureOp, MeasurePickRef, MeasureSet } from '@/kernel/worker/solverProtocol'
import { formatReadout } from '@/utils/measure/format'
import type { KernelMeasureAsk } from '@/utils/measure/measureSelection'
import { KERNEL_ASK_DEBOUNCE_MS, useKernelAsk, type KernelAskState } from './useKernelAsk'

export const MEASURE_DEBOUNCE_MS = KERNEL_ASK_DEBOUNCE_MS

export type KernelMeasureState = KernelAskState

function picksKey(picks: readonly MeasurePickRef[]): string {
  return picks
    .map((pick) => (pick.kind === 'body'
      ? `${pick.bodyId}/body`
      : `${pick.bodyId}/${pick.kind}/${pick.index}`))
    .join(',')
}

/** The readout a kernel reply states, in the one formatter the HUD uses. */
export function formatKernelReadout(op: MeasureOp, reply: MeasureReply, unit: LengthUnit): string[] {
  const extras = (reply.extra ?? []).map((extra) => formatReadout(extra, unit))
  if (op === 'length') {
    return [formatReadout({ kind: 'length', value: reply.value, label: 'length' }, unit), ...extras]
  }
  if (op === 'area' || op === 'volume') {
    return [formatReadout({ kind: op, value: reply.value, label: op }, unit), ...extras]
  }
  const line = formatReadout(
    { kind: 'distance', value: reply.value, label: op === 'clearance' ? 'clearance' : 'distance' },
    unit,
  )
  // A clearance of 0 says WHY it is 0; a plain distance has no note.
  return [reply.note === undefined ? line : `${line} (${reply.note})`, ...extras]
}

/**
 * Ask the solver Worker for a kernel cell's measurement. `ask` is the pure
 * core's question (null when the sync readout answered), `generation` the solve
 * it was asked against and `set` the body set the picks were made in (the pick
 * boundary while a feature edit is open).
 */
export function useKernelMeasure(
  ask: KernelMeasureAsk | null,
  generation: string | null,
  set: MeasureSet,
  unit: LengthUnit = 'mm',
): KernelMeasureState {
  const key = ask === null || generation === null
    ? null
    : `${generation}|${set}|${ask.op}|${picksKey(ask.picks)}|${unit}`
  const request = ask === null || generation === null
    ? null
    : () => measureViaWorker({ generation, set, op: ask.op, picks: ask.picks })
  return useKernelAsk(key, request, (reply) => (ask === null ? [] : formatKernelReadout(ask.op, reply, unit)))
}
