import { useEffect, type RefObject } from 'react'
import { useThree } from '@react-three/fiber'
import { subscribeSceneInvalidation } from '@/components/Viewport/sceneInvalidation'

interface RenderOnChangeProps {
  // The in-canvas invalidate, published to the host page. The imperative
  // camera paths (a fit, a plane or face alignment, the gizmo's
  // snap-to-direction) move the camera outside React, so the reconciler's own
  // invalidation cannot see them; their call sites reach this ref instead.
  invalidateRef: RefObject<(() => void) | null>
}

/**
 * The part viewport's demand-mode heartbeat, mounted inside the Canvas. It owns
 * the one rule the policy module documents: while the viewport is idle no frame
 * is drawn, and every store write asks for the next one. The ref it publishes
 * is what the host page's imperative camera paths use.
 */
export function RenderOnChange({ invalidateRef }: RenderOnChangeProps) {
  const invalidate = useThree(state => state.invalidate)
  const gl = useThree(state => state.gl)

  useEffect(() => {
    invalidateRef.current = invalidate
    const unsubscribe = subscribeSceneInvalidation(invalidate)
    // The mount frame. R3F also invalidates while the root configures itself,
    // but an empty scene has no instance change to rely on.
    invalidate()

    // A GPU-process restart restores the context but leaves the canvas blank,
    // and no store changed: on demand nothing would repaint it until the next
    // unrelated interaction.
    const canvas = gl.domElement
    const onContextRestored = () => invalidate()
    canvas.addEventListener('webglcontextrestored', onContextRestored)

    return () => {
      canvas.removeEventListener('webglcontextrestored', onContextRestored)
      unsubscribe()
      invalidateRef.current = null
    }
  }, [gl, invalidate, invalidateRef])

  return null
}

/**
 * Ask for one frame when this mounts. For components that apply scene state
 * from an effect instead of through R3F props, like drei's `Environment`: the
 * env map lands after the first painted frame, creates or updates no instance,
 * and on demand would never reach the canvas on its own. Mount effects run
 * after the commit, so the state is in place when the frame is drawn.
 */
export function RenderOnce() {
  const invalidate = useThree(state => state.invalidate)

  useEffect(() => {
    invalidate()
  }, [invalidate])

  return null
}
