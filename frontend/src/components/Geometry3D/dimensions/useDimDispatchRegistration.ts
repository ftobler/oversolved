import { useEffect, useRef } from 'react'
import { registerDimCallbacks } from '@/components/Viewport/idDispatch/dimensionLabelCallbacks'

interface DispatchTarget {
  onOver: (ev: { stopPropagation: () => void }) => void
  onOut: () => void
  onClick: (ev: { stopPropagation: () => void; clientX: number; clientY: number }) => void
}

/**
 * Mirrors the visible-pass R3F handlers into the id-buffer dispatch
 * registry under the constraint id, so 267.2's canvas-level pointer
 * dispatcher can drive the same callbacks via the dimensionLabel ID
 * layer. Parallel-installed: the existing R3F handlers stay live.
 */
export function useDimDispatchRegistration(cid: string, target: DispatchTarget): void {
  const targetRef = useRef(target)
  useEffect(() => { targetRef.current = target })

  useEffect(() => {
    return registerDimCallbacks(cid, {
      onOver: () => targetRef.current.onOver({ stopPropagation: () => { } }),
      onOut:  () => targetRef.current.onOut(),
      onClick: (clientX, clientY) =>
        targetRef.current.onClick({ stopPropagation: () => { }, clientX, clientY }),
    })
  }, [cid])
}
