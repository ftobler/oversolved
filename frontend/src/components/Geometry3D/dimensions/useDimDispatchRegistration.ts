import { useEffect, useRef } from 'react'
import { registerDimCallbacks } from '@/components/Viewport/idDispatch/dimensionLabelCallbacks'

interface DispatchTarget {
  onOver: (ev: { stopPropagation: () => void }) => void
  onOut: () => void
  onClick: (ev: { stopPropagation: () => void; clientX: number; clientY: number }) => void
  onPointerDown: (ev: { stopPropagation: () => void; clientX: number; clientY: number }) => void
}

/**
 * Mirrors the dimension component's hover / click / drag-start handlers
 * into the id-buffer dispatch registry under the constraint id, so the
 * canvas-level pointer dispatcher (267.2) can drive the same callbacks
 * via the dimensionLabel ID layer. As of 267.3, this is the *only*
 * pick path for dimension labels -- the R3F event props on the label
 * hit meshes have been removed.
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
      onPointerDown: (clientX, clientY) =>
        targetRef.current.onPointerDown({ stopPropagation: () => { }, clientX, clientY }),
    })
  }, [cid])
}
