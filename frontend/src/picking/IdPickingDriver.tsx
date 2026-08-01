import { useEffect, useRef, useState } from 'react'
import { useThree, useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { IdPipeline } from './IdPipeline'
import { setLivePipeline } from './IdPipelineContext'
interface IdPickingDriverProps {
  /** External handle so non-Canvas code (Viewport pointer dispatch) can call resolveSync. */
  onReady?: (pipeline: IdPipeline) => void
}

function getRenderSize(gl: THREE.WebGLRenderer, cssWidth: number, cssHeight: number): { width: number; height: number } {
  if (typeof gl.getDrawingBufferSize === 'function') {
    const db = gl.getDrawingBufferSize(new THREE.Vector2())
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
  const sizeWidth = three.size?.width ?? 1
  const sizeHeight = three.size?.height ?? 1

  // Pipeline is created once via useState lazy initializer. Subsequent size
  // changes flow through resize() below, not by reconstructing the pipeline.
  const [pipeline] = useState<IdPipeline>(() => {
    const db = getRenderSize(gl, sizeWidth, sizeHeight)
    return new IdPipeline({
      width: db.width,
      height: db.height,
      pickDuringCameraMotion: true,
    })
  })

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

  useFrame(() => {
    const db = getRenderSize(gl, sizeWidth, sizeHeight)
    pipeline.resize(db.width, db.height)
  })

  // Camera-change detection. Compare the camera's world matrix every frame
  // against the snapshot from the previous frame. A change marks the
  // pipeline dirty; when `pickDuringCameraMotion` is false (default) we
  // additionally suppress the actual render while the camera is moving,
  // so the ID buffer settles once after the camera stops.
  const lastCamMatrix = useRef<Float32Array>(new Float32Array(16))
  const lastCamMatrixValid = useRef(false)
  const cameraMovedThisFrame = useRef(false)
  const renderFailed = useRef(false)

  useFrame(({ camera }) => {
    if (renderFailed.current) return
    const m = camera.matrixWorld.elements
    let changed = false
    if (!lastCamMatrixValid.current) {
      lastCamMatrixValid.current = true
    } else {
      for (let i = 0; i < 16; i++) {
        if (Math.abs(lastCamMatrix.current[i] - m[i]) > 1e-6) { changed = true; break }
      }
    }
    lastCamMatrix.current.set(m)

    if (changed) {
      // Capture whether the pipeline was already dirty from a geometry
      // change (registration hooks) BEFORE we add the camera-change mark.
      // When geometry is stale we must NOT defer, the ID buffer needs
      // fresh pixel data so clicks resolve correctly. Only defer when
      // the sole reason for dirtiness is this frame's camera motion.
      const hadGeometryDirty = pipeline.isDirty()
      pipeline.markDirty('camera')
      cameraMovedThisFrame.current = true
      if (!pipeline.pickDuringCameraMotion && !hadGeometryDirty) {
        return  // defer render until the camera settles
      }
    } else {
      cameraMovedThisFrame.current = false
    }
    try {
      pipeline.renderIfDirty(gl, camera)
    } catch (err) {
      // Never let id-buffer failures take down visible rendering.
      renderFailed.current = true
      console.warn('ID pipeline render failed; disabling id-buffer picking for this session', err)
    }
  })  // default priority: do not take over the render loop

  return null
}
