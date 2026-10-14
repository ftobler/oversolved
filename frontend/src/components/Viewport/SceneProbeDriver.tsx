import { useEffect, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import {
  cameraPoseChanged, createCameraPose, recordCameraPoseInto, type CameraPoseSnapshot,
} from '@/picking/cameraPose'
import { probeCameraFrom } from '@/picking/sceneProbe'
import { publishProbeCamera, publishProbeCanvas } from '@/picking/sceneProbeStore'

/**
 * Publishes the live camera pose and canvas size to the scene probe. Mounted
 * inside the Canvas next to IdPickingDriver.
 *
 * On change, never per frame: the pose is compared exactly like the ID
 * pipeline's own staleness check (world AND projection matrix, so a pure
 * orthographic wheel-zoom counts), and the store additionally no-ops an equal
 * publish. `camera.updateMatrixWorld()` keeps that comparison same-frame: the
 * renderer would otherwise only refresh the matrix after useFrame callbacks
 * have run, costing one frame of publish latency on every orbit step.
 */
export default function SceneProbeDriver() {
  const camera = useThree(state => state.camera)
  const size = useThree(state => state.size)
  const lastPose = useRef<CameraPoseSnapshot | null>(null)

  useEffect(() => {
    publishProbeCanvas(size.width, size.height)
  }, [size.width, size.height])

  // The viewport unmounted: a stale camera would make every later probe read
  // project through a canvas nobody is looking at.
  useEffect(() => () => publishProbeCamera(null), [])

  useFrame(() => {
    camera.updateMatrixWorld()
    if (!lastPose.current) {
      lastPose.current = createCameraPose()
      recordCameraPoseInto(lastPose.current, camera)
      publishProbeCamera(probeCameraFrom(camera))
      return
    }
    if (!cameraPoseChanged(lastPose.current, camera)) return
    recordCameraPoseInto(lastPose.current, camera)
    publishProbeCamera(probeCameraFrom(camera))
  })

  return null
}
