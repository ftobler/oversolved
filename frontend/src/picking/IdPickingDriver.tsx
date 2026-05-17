import { useEffect, useRef, useState } from 'react'
import { useThree, useFrame } from '@react-three/fiber'
import { IdPipeline } from './IdPipeline'
import { setLivePipeline } from './IdPipelineContext'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'

interface IdPickingDriverProps {
  /** External handle so non-Canvas code (Viewport pointer dispatch) can call resolveSync. */
  onReady?: (pipeline: IdPipeline) => void
}

/**
 * Mounted inside the R3F Canvas. Owns the IdPipeline lifecycle:
 *   - allocate on mount with the current canvas size
 *   - resize when the canvas size changes
 *   - render the ID target after each frame when dirty
 *   - dispose on unmount
 *
 * Children render inside the Provider so Body3D (etc.) can register their
 * geometry via `useIdPipeline()`.
 *
 * Camera change detection is deferred to id-buffer-perf.md (#264). For
 * this slice the pipeline marks dirty on geometry registration changes
 * only; callers can `pipeline.markDirty()` for camera moves until then.
 */
export default function IdPickingDriver({ onReady }: IdPickingDriverProps) {
  const three = useThree()
  const gl = three.gl
  // `size` may be undefined in tests that stub useThree; treat as 1x1.
  const sizeWidth = three.size?.width ?? 1
  const sizeHeight = three.size?.height ?? 1

  // Pipeline is created once via useState lazy initializer. Subsequent size
  // changes flow through resize() below, not by reconstructing the pipeline.
  const [pipeline] = useState<IdPipeline>(() => new IdPipeline({
    width: Math.max(1, Math.floor(sizeWidth)),
    height: Math.max(1, Math.floor(sizeHeight)),
  }))

  const onReadyRef = useRef(onReady)
  useEffect(() => { onReadyRef.current = onReady }, [onReady])

  useEffect(() => {
    setLivePipeline(pipeline)
    onReadyRef.current?.(pipeline)
    return () => {
      // Guard against StrictMode (and any future double-mount): only clear
      // the global if it still points at OUR pipeline. Without this, a
      // remount that re-runs setLivePipeline before our cleanup runs would
      // be wiped out by our unmount clearing the latest pointer.
      setLivePipeline(null, pipeline)
      pipeline.dispose()
    }
  }, [pipeline])

  useEffect(() => {
    pipeline.resize(Math.max(1, Math.floor(sizeWidth)), Math.max(1, Math.floor(sizeHeight)))
  }, [pipeline, sizeWidth, sizeHeight])

  // Mirror the visible-pass `interactive={!activeFeatureId}` rule from
  // Body3D: while a sketch is being edited, B-rep layers go inert in the
  // ID buffer so the resolver never returns a B-rep entity.
  useEffect(() => {
    pipeline.setBrepInertPredicate(() => {
      return useSketchEditorStore.getState().activeFeatureId !== null
    })
    // Re-render whenever the edit flag flips.
    const unsub = useSketchEditorStore.subscribe((state, prev) => {
      if (state.activeFeatureId !== prev.activeFeatureId) pipeline.markDirty()
    })
    return () => {
      pipeline.setBrepInertPredicate(null)
      unsub()
    }
  }, [pipeline])

  useFrame(({ camera }) => {
    pipeline.renderIfDirty(gl, camera)
  }, 1)  // priority > 0 -> runs after default render

  return null
}
