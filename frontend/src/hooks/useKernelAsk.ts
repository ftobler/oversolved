// The debounce + staleness machinery one kernel readout needs, shared by the
// part editor's `useKernelMeasure` and the assembly's kernel measure.
//
// A readout is view state and a Worker round trip. `key` names everything the
// request depends on, so a key change tears the effect down before a reply for
// the old selection can land; `request` is read through a ref so a callback
// rebuilt on every render does not re-ask. A refusal (stale, unresolved, a dead
// Worker) reads nothing rather than surfacing an error.
import { useEffect, useMemo, useRef, useState } from 'react'

/** How long a selection must hold still before the Worker is asked. A pick
 *  sweep changes the ids on every pointer move; only where it stops is worth a
 *  request, and the Worker serializes whatever it does receive. */
export const KERNEL_ASK_DEBOUNCE_MS = 120

export interface KernelAskState {
  // True while the reply for the current key has not landed: the HUD reserves
  // its row and leaves it empty (K2).
  pending: boolean
  // The formatted readout lines, empty until the reply lands.
  lines: string[]
}

const IDLE: KernelAskState = { pending: false, lines: [] }

export function useKernelAsk<TReply>(
  key: string | null,
  request: (() => Promise<TReply | null>) | null,
  format: (reply: TReply) => string[],
): KernelAskState {
  // The effect keys on the string, so a caller whose request object is rebuilt
  // every render (a selection that did not change) does not re-ask. The request
  // and the formatter are read through refs, sync'd by the effects above: writing
  // a ref during render is not allowed, and reading it in an effect is.
  const requestRef = useRef(request)
  useEffect(() => {
    requestRef.current = request
  }, [request])
  const formatRef = useRef(format)
  useEffect(() => {
    formatRef.current = format
  }, [format])

  const [reply, setReply] = useState<{ key: string; lines: string[] } | null>(null)

  useEffect(() => {
    const run = requestRef.current
    if (key === null || run === null) return
    // The cleanup below is the staleness guard: any key change tears the effect
    // down first, so a reply for the old selection can never land in the new one.
    let cancelled = false
    const timer = setTimeout(() => {
      void run()
        .then((result) => {
          if (cancelled) return
          // A null reply is a Worker that is gone: the ask is answered with
          // nothing, which empties the reserved row instead of holding it open.
          setReply({ key, lines: result === null ? [] : formatRef.current(result) })
        })
        // Every refusal reads nothing: the reserved row is released rather than
        // left hanging.
        .catch(() => {
          if (!cancelled) setReply({ key, lines: [] })
        })
    }, KERNEL_ASK_DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [key])

  return useMemo(() => {
    if (key === null) return IDLE
    if (reply !== null && reply.key === key) return { pending: false, lines: reply.lines }
    return { pending: true, lines: [] }
  }, [key, reply])
}
