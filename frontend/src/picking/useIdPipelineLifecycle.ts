import { useEffect, useRef, useState } from 'react'
import type * as THREE from 'three'
import type { IdPipeline } from './IdPipeline'
import { setLivePipeline } from './IdPipelineContext'

export interface IdPipelineLifecycle {
  // The currently published pipeline, or null between a dispose and the next
  // setup. Consumers (R3F useFrame) read this; it changes identity on every
  // Suspense hide/reveal because each reveal mints a fresh instance.
  pipeline: IdPipeline | null
  // Render the ID buffer for the current pipeline, applying the per-pipeline
  // render-failure latch: a pipeline whose render threw is disabled until it is
  // replaced by a fresh instance. This bounds C2 (a disposed/revealed pipeline
  // can never permanently kill id-buffer picking for the whole session).
  tryRender: (renderer: THREE.WebGLRenderer, camera: THREE.Camera) => void
}

/**
 * Owns the IdPipeline lifecycle independent of the Canvas tree. The pipeline is
 * created by the SAME effect that publishes it and destroyed by the SAME cleanup
 * that unpublishes it, so a disposed instance is unreachable by construction:
 * React StrictMode and R3F's Suspense hide/reveal (cleanup-then-setup) mint a
 * fresh pipeline every time instead of republishing a corpse.
 *
 * Contains no R3F import so it is unit-testable without a Canvas (the
 * "delete the Viewport" rule): `factory` is supplied by the R3F adapter and
 * only called inside the effect, while `tryRender`'s GL objects arrive as
 * call-time parameters.
 */
export function useIdPipelineLifecycle(factory: () => IdPipeline): IdPipelineLifecycle {
  const [pipeline, setPipeline] = useState<IdPipeline | null>(null)
  const pipelineRef = useRef<IdPipeline | null>(null)
  const renderFailed = useRef<Map<IdPipeline, boolean>>(new Map())

  // The factory is captured from the first render on purpose: a reveal mints a
  // fresh pipeline from the current gl/size, and later resizes flow through
  // resize() below, so re-running this effect on resize would be wrong.
  useEffect(() => {
    const created = factory()
    const failedMap = renderFailed.current
    pipelineRef.current = created
    setPipeline(created)
    setLivePipeline(created)
    return () => {
      // Unpublish only if we are still the live pipeline; a faster remount may
      // already have published its own instance.
      setLivePipeline(null, created)
      created.dispose()
      pipelineRef.current = null
      setPipeline(null)
      failedMap.delete(created)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const tryRender = (renderer: THREE.WebGLRenderer, camera: THREE.Camera): void => {
    const current = pipelineRef.current
    if (!current) return
    if (renderFailed.current.get(current)) return
    try {
      current.renderIfDirty(renderer, camera)
    } catch (err) {
      // Latch per-pipeline so a fresh instance after a reveal starts clean.
      renderFailed.current.set(current, true)
      console.warn('ID pipeline render failed; disabling id-buffer picking for the replaced pipeline', err)
    }
  }

  return { pipeline, tryRender }
}
