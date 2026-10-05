import { useEffect, useRef, useCallback } from 'react'
import { useThree, useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { IdPipeline } from './IdPipeline'
import { useIdPipelineLifecycle } from './useIdPipelineLifecycle'
import { cameraPoseChanged, createCameraPose, recordCameraPoseInto, type CameraPoseSnapshot } from './cameraPose'
import { getPixelRatio } from './pickPixelRatio'

// Reused across getRenderSize calls (per-frame resize poll). getDrawingBufferSize
// only writes into the vector it is handed, so one module-scope instance avoids a
// fresh allocation every frame.
const RENDER_SIZE_SCRATCH = new THREE.Vector2()

interface IdPickingDriverProps {
  // External handle so non-Canvas code (Viewport pointer dispatch) can call resolveSync.
  onReady?: (pipeline: IdPipeline) => void
}

function getRenderSize(gl: THREE.WebGLRenderer, cssWidth: number, cssHeight: number): { width: number; height: number } {
  if (typeof gl.getDrawingBufferSize === 'function') {
    const db = gl.getDrawingBufferSize(RENDER_SIZE_SCRATCH)
    return { width: Math.max(1, Math.floor(db.x)), height: Math.max(1, Math.floor(db.y)) }
  }
  return {
    width: Math.max(1, Math.floor(cssWidth || 1)),
    height: Math.max(1, Math.floor(cssHeight || 1)),
  }
}

/**
 * Mounted inside the R3F Canvas. Owns the IdPipeline lifecycle:
 *   - allocate on mount with the current canvas size
 *   - resize when the canvas size changes
 *   - mark the buffer dirty when the camera pose changes, then render it
 *   - dispose on unmount
 *
 * Production geometry registers against the module-level live pipeline in
 * IdPipelineContext (via `useIdPipeline()`); this component returns null and
 * publishes `onReady` to non-Canvas callers (Viewport pointer dispatch).
 *
 * The pipeline instance is minted fresh on every Suspense hide/reveal by
 * `useIdPipelineLifecycle`, so a disposed pipeline is never republished:
 * the fixed ordering assumption (that the reveal happens before any
 * geometry arrives) is removed rather than satisfied.
 */
export default function IdPickingDriver({ onReady }: IdPickingDriverProps) {
  const three = useThree()
  const gl = three.gl
  const sizeWidth = three.size?.width ?? 1
  const sizeHeight = three.size?.height ?? 1

  // Camera-change state, keyed per pipeline. A fresh pipeline after a reveal
  // must start with a clean pose slate, otherwise the stale previous pipeline's
  // pose would suppress the first post-reveal dirty mark (and its render).
  const camState = useRef<
    Map<IdPipeline, { lastCamPose: CameraPoseSnapshot | null }>
  >(new Map())

  // The factory captures the gl + size at effect time; the hook calls it inside
  // its setup effect, so the very first size is used and later resizes flow
  // through resize() below (exactly the previous useState-lazy behaviour).
  const factory = useCallback(() => {
    const db = getRenderSize(gl, sizeWidth, sizeHeight)
    return new IdPipeline({
      width: db.width,
      height: db.height,
      pixelRatio: getPixelRatio(db.width, sizeWidth),
    })
  }, [gl, sizeWidth, sizeHeight])

  const { pipeline, tryRender } = useIdPipelineLifecycle(factory)

  const onReadyRef = useRef(onReady)
  useEffect(() => { onReadyRef.current = onReady }, [onReady])
  useEffect(() => {
    if (pipeline) onReadyRef.current?.(pipeline)
  }, [pipeline])

  // Prune the per-pipeline camera-state entry when this pipeline is disposed
  // (reveal/unmount). Without this the Map grows by one stale entry per
  // Suspense reveal over a long session.
  useEffect(() => {
    const table = camState.current
    return () => {
      if (pipeline) table.delete(pipeline)
    }
  }, [pipeline])

  useFrame(({ camera }) => {
    if (!pipeline) return
    const db = getRenderSize(gl, sizeWidth, sizeHeight)
    pipeline.resize(db.width, db.height)
    // Re-derived every frame alongside the size: dragging the window to a
    // display with a different DPR, or a browser zoom, changes the ratio
    // without changing anything the pipeline is otherwise told about.
    pipeline.setPixelRatio(getPixelRatio(db.width, sizeWidth))

    let cs = camState.current.get(pipeline)
    if (!cs) {
      cs = { lastCamPose: null }
      camState.current.set(pipeline, cs)
    }

    // Camera-change detection. Compare the camera's world AND projection matrix
    // every frame against the snapshot from the previous frame. The projection
    // half is what catches an OrbitControls dolly on an orthographic camera:
    // it only scales zoom, so matrixWorld alone misses it and the ID buffer
    // went stale after a pure wheel-zoom. A change marks the pipeline dirty so
    // the frame below re-renders it.
    if (!cs.lastCamPose) cs.lastCamPose = createCameraPose()
    const changed = cameraPoseChanged(cs.lastCamPose, camera)
    // Copy the current pose in place: the reused buffer is what next frame's
    // comparison reads, so no typed array is minted per frame.
    recordCameraPoseInto(cs.lastCamPose, camera)

    if (changed) pipeline.markDirty('camera-projection')
    tryRender(gl, camera)
  })  // default priority: do not take over the render loop

  return null
}
