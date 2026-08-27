import { useEffect, useRef } from 'react'
import { stepPlainNumber } from './wheelStep'

interface WheelStepOptions {
  // What the box currently shows. Read live so the handler never churns.
  readText: () => string
  // The field's own validation; undefined means every step commits.
  accept?: (next: number) => boolean
  // Commit, through the caller's normal path (NOT a direct store write).
  onStep: (next: number) => void
  // Attaches the listener only when the field is enabled.
  enabled?: boolean
  // Optional caller-owned ref (e.g. an uncontrolled input) to attach to.
  inputRef?: React.RefObject<HTMLInputElement | null>
}

// Attaches a non-passive `wheel` listener that steps a numeric box by exactly
// one per notch. Returns a ref to spread onto the `<input>`.
//
// React registers its synthetic `onWheel` as passive at the root, so a native
// listener is required to call `preventDefault()`. Everything the handler needs
// is read through `latest` (updated every render via an effect, not during
// render), so the listener effect attaches once and never re-subscribes per
// keystroke.
export function useWheelStep(opts: WheelStepOptions): React.RefObject<HTMLInputElement | null> {
  const internalRef = useRef<HTMLInputElement | null>(null)
  const ref = opts.inputRef ?? internalRef
  const latest = useRef(opts)
  // Keep the handler's view of the options fresh without writing during render.
  useEffect(() => { latest.current = opts })

  useEffect(() => {
    const el = ref.current
    if (!el || opts.enabled === false) return
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY === 0) return  // pure horizontal scroll: not a step
      const dir: 1 | -1 = e.deltaY < 0 ? 1 : -1  // sign only, magnitude ignored
      const next = stepPlainNumber(latest.current.readText(), dir)
      if (next === null) return  // not a number: fall through to the panel scroll
      e.preventDefault()  // the field owns this gesture
      if (latest.current.accept && !latest.current.accept(next)) return  // hold at the boundary
      latest.current.onStep(next)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [opts.enabled, ref])

  return ref
}
