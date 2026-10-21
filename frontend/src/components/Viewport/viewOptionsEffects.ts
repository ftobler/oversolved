// What a change to the drawn layers owes the picking pipeline.
//
// Shading and Edges change both what is painted and what the ID buffer
// registers (Body3D gates its face/edge registrations on them). The
// registration hooks mark the buffer dirty themselves when they mount or
// unmount, but the toggle also has to invalidate the hover: a resolve already
// launched for a face that just stopped being drawn would land a frame later
// and repaint a highlight for what is now empty space. That is the difference
// between "wireframe" and "the cursor still lights up a face I cannot see".
import { useEffect, useRef } from 'react'
import { getLivePipeline } from '@/picking'
import { useViewOptionsStore } from '@/stores/viewOptionsStore'

export interface LayerChangeTarget {
  markDirty: (reason?: string) => void
  clearHover: () => void
}

/**
 * The one order every layer toggle runs: dirty the ID buffer, then drop the
 * hover that was resolved against the old layers. Pure so a test can pin the
 * reason string and the order without a WebGL context.
 */
export function notifyLayerChange(target: LayerChangeTarget): void {
  target.markDirty('view-options')
  target.clearHover()
}

/**
 * Run `notifyLayerChange` whenever the drawn layers change. The first render is
 * skipped: mounting does not change a layer, and the registration hooks already
 * dirty the buffer for their own initial state. `clearHover` must be stable
 * (the viewports hand in their own teardown, which drops their in-flight
 * readback).
 */
export function useLayerPipelineEffects(clearHover: () => void): void {
  const shading = useViewOptionsStore(s => s.shading)
  const edges = useViewOptionsStore(s => s.edges)
  const mounted = useRef(false)
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true
      return
    }
    notifyLayerChange({
      markDirty: reason => getLivePipeline()?.markDirty(reason),
      clearHover,
    })
  }, [shading, edges, clearHover])
}
