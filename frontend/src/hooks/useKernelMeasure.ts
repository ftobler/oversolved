// The kernel half of the measurement readout: one worker request per kernel
// cell, debounced, keyed to the solve it was asked against.
//
// A readout is view state. The hook owns the only main-thread state a
// measurement has (the pending key and the last reply), writes no document and
// records no undo entry. It renders nothing for a refusal: a stale generation, an
// unresolved element and a dead Worker are all "no answer", never an error
// banner.
import { useEffect, useMemo, useRef, useState } from 'react'
import type { LengthUnit } from '@/types/cad'
import { measureViaWorker, type MeasureReply } from '@/kernel/worker/solverClient'
import type { MeasureOp, MeasurePickRef, MeasureSet } from '@/kernel/worker/solverProtocol'
import { formatReadout } from '@/utils/measure/format'
import type { KernelMeasureAsk } from '@/utils/measure/measureSelection'

/** How long the selection must hold still before the Worker is asked. A pick
 *  sweep changes the ids on every pointer move; only where it stops is worth a
 *  request, and the Worker serializes whatever it does receive. */
export const MEASURE_DEBOUNCE_MS = 120

export interface KernelMeasureState {
  // True while the reply for the current key has not landed: the HUD reserves
  // its row and leaves it empty (K2).
  pending: boolean
  // The formatted readout lines, empty until the reply lands.
  lines: string[]
}

const IDLE: KernelMeasureState = { pending: false, lines: [] }

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
    : `${generation}|${set}|${ask.op}|${picksKey(ask.picks)}`

  // The effect keys on the string, so a caller whose `ask` object is rebuilt
  // every render (a selection that did not change) does not re-ask. The object
  // itself is read through a ref, sync'd by the effect above it: writing a ref
  // during render is not allowed, and reading it in an effect is.
  const askRef = useRef<KernelMeasureAsk | null>(ask)
  useEffect(() => {
    askRef.current = ask
  }, [ask])

  const [reply, setReply] = useState<{ key: string; lines: string[] } | null>(null)

  useEffect(() => {
    const current = askRef.current
    if (key === null || generation === null || current === null) return
    // The cleanup below is the staleness guard: any key change tears the effect
    // down first, so a reply for the old selection can never land in the new
    // one, whether the selection or the solve generation moved.
    let cancelled = false
    const timer = setTimeout(() => {
      void measureViaWorker({
        generation,
        set,
        op: current.op,
        picks: current.picks,
      })
        .then((result) => {
          // A reply for a key the selection has moved past is dropped: the user
          // is already measuring something else.
          if (cancelled) return
          // A null reply is a Worker that is gone: the ask is answered with
          // nothing, which empties the reserved row instead of holding it open.
          setReply({
            key,
            lines: result === null ? [] : formatKernelReadout(current.op, result, unit),
          })
        })
        // Every refusal (stale, unresolved) reads nothing: the reserved row is
        // released rather than left hanging.
        .catch(() => {
          if (!cancelled) setReply({ key, lines: [] })
        })
    }, MEASURE_DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [key, generation, set, unit])

  return useMemo(() => {
    if (key === null) return IDLE
    if (reply !== null && reply.key === key) return { pending: false, lines: reply.lines }
    return { pending: true, lines: [] }
  }, [key, reply])
}
