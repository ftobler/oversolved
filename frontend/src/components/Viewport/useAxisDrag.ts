// Screen-space axis math shared by the feature-edit arrows and the section
// plane's offset arrow: map the cursor onto a 3D axis and keep the pixel ->
// world factor quantized so a zoom tick does not rebuild the pick buffer.
import { useCallback, useRef, useState } from 'react'
import * as THREE from 'three'
import { useThree } from '@react-three/fiber'
import { closestParamOnAxis, type Ray } from '@/utils/gizmoMath'
import { p2w } from '@/components/Geometry3D/sketchSceneHelpers'

// How far the pixel factor may drift before it is worth a re-render. Only steps
// of ~25% propagate; the resolver's snap window absorbs the residual error at
// the screen-sized arrow tip.
const ZOOM_STEP_UP = 1.25
const ZOOM_STEP_DOWN = 0.8

export interface AxisDragTools {
  // Pixel-to-world factor at the last quantization step.
  pxToWorld: number
  // The world ray under a pointer position, or null when the canvas has no
  // measurable size.
  rayFrom: (clientX: number, clientY: number) => Ray | null
  // The axis parameter under the cursor, or null when the pointer rays past it.
  cursorAxisParam: (e: PointerEvent, axisPoint: [number, number, number], axisDir: [number, number, number]) => number | null
  // Re-quantize from the live camera; call from useFrame with the fresh factor.
  trackZoom: (pixelsPerWorld: number) => void
}

export function useAxisDrag(): AxisDragTools {
  const { camera, gl } = useThree()
  const [pxToWorld, setPxToWorld] = useState(() => {
    const ortho = camera as THREE.OrthographicCamera
    return ortho.isOrthographicCamera ? p2w(camera) : 1
  })
  const raycasterRef = useRef(new THREE.Raycaster())

  const rayFrom = useCallback((clientX: number, clientY: number): Ray | null => {
    const rect = gl.domElement.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return null
    const ndc = {
      x: ((clientX - rect.left) / rect.width) * 2 - 1,
      y: -((clientY - rect.top) / rect.height) * 2 + 1,
    }
    const rc = raycasterRef.current
    rc.setFromCamera(new THREE.Vector2(ndc.x, ndc.y), camera)
    const o = rc.ray.origin
    const d = rc.ray.direction
    return { origin: [o.x, o.y, o.z], direction: [d.x, d.y, d.z] }
  }, [camera, gl])

  const cursorAxisParam = useCallback((
    e: PointerEvent,
    axisPoint: [number, number, number],
    axisDir: [number, number, number],
  ): number | null => {
    const ray = rayFrom(e.clientX, e.clientY)
    if (!ray) return null
    return closestParamOnAxis(ray, axisPoint, axisDir)
  }, [rayFrom])

  const trackZoom = useCallback((pixelsPerWorld: number) => {
    if (pixelsPerWorld > pxToWorld * ZOOM_STEP_UP || pixelsPerWorld < pxToWorld * ZOOM_STEP_DOWN) {
      setPxToWorld(pixelsPerWorld)
    }
  }, [pxToWorld])

  return { pxToWorld, rayFrom, cursorAxisParam, trackZoom }
}
