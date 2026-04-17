import { useCallback, useMemo, useRef, useState, forwardRef, useImperativeHandle } from 'react'
import { Canvas } from '@react-three/fiber'
import { OrthographicCamera } from '@react-three/drei'
import * as THREE from 'three'
import type { SketchData, Feature, Sketch, BodyResult } from '../types/cad'
import { unflattenGeometry, deriveConstraints } from '../utils/geometryMapping'
import Geometry3D from './Geometry3D'
import { CubeGizmoCanvas } from './CubeGizmo'
import { type Hit, type Pv } from './CubeGizmo.utils'
import { useSketchEditorStore } from '../stores/sketchEditorStore'
import Body3D from './Geometry3D/Body3D'
import OriginMarker from './Viewport/OriginMarker'
import ReferencePlane from './Viewport/ReferencePlane'
import SceneController from './Viewport/SceneController'
import CameraLight from './Viewport/CameraLight'
import UserDefinedPlane from './Viewport/UserDefinedPlane'
import ContextMenuDialog from './ContextMenuDialog'
import { CLICK_THRESHOLD_PX } from './Geometry3D/constants'
import { useSelectionPointerUpCleanup } from './interaction/useSelectionPointerUpCleanup'
import { getBodiesToRender } from './Viewport/bodyUtils'

const INITIAL_POSITION: [number, number, number] = [20, 20, 100]

const INITIAL_ZOOM = 200

interface ViewportProps {
  features?: Feature[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  featureDefs?: any[]
  rollbackPosition?: number
  visibleFeatures?: Set<string>
  solveResults?: Record<string, SketchData>
  resetTrigger?: number
  activeFeatureId?: string
  onRightClick?: (pos: [number, number]) => void
  showDebugHit?: boolean
  otherSketches?: Record<string, Sketch>  // sketches from other features (for project tool)
  bodies?: Record<string, BodyResult>
}

function isActive(id: string, features: Feature[] | undefined, rollbackPos: number | undefined, visible: Set<string> | undefined): boolean {
  if (!features || features.length === 0) return true
  const idx = features.findIndex(f => f.id === id)
  if (idx < 0) return false
  return (rollbackPos === undefined || idx < rollbackPos) && (!visible || visible.has(id))
}


export interface ViewportHandle {
  captureScreenshot: () => Promise<string | null>
  captureScreenshotForSaving: () => Promise<string | null>
  autoZoomToFit: () => void
}

export default forwardRef<ViewportHandle, ViewportProps>(function Viewport({
  features,
  featureDefs,
  rollbackPosition,
  visibleFeatures,
  solveResults,
  resetTrigger = 0,
  activeFeatureId,
  onRightClick,
  showDebugHit = false,
  bodies,
}: ViewportProps, ref) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const pvRef = useRef<Pv[]>([])
  const hoverRef = useRef<Hit | null>(null)
  const snapRef = useRef<THREE.Vector3 | null>(null)
  const cameraRef = useRef<THREE.Camera | null>(null)
  const glRef = useRef<THREE.WebGLRenderer | null>(null)
  const sceneRef = useRef<THREE.Scene | null>(null)

  const [ready, setReady] = useState(false)
  const onCreated = useCallback((state: { gl: THREE.WebGLRenderer; scene: THREE.Scene }) => {
    glRef.current = state.gl
    sceneRef.current = state.scene
    requestAnimationFrame(() => setReady(true))
  }, [])

  const captureScreenshot = useCallback(async (): Promise<string | null> => {
    const gl = glRef.current
    const scene = sceneRef.current
    const camera = cameraRef.current
    if (!gl || !scene || !camera) return null
    gl.render(scene, camera)
    return gl.domElement.toDataURL('image/png')
  }, [])

  const captureScreenshotForSaving = useCallback(async (): Promise<string | null> => {
    const gl = glRef.current
    const scene = sceneRef.current
    const camera = cameraRef.current as THREE.OrthographicCamera | null
    if (!gl || !scene || !camera) return null

    const originalSize = gl.getSize(new THREE.Vector2())
    const smallWidth = Math.floor(originalSize.width / 4)
    const smallHeight = Math.floor(originalSize.height / 4)

    const originalZoom = camera.zoom
    const originalPosition = camera.position.clone()

    camera.zoom = INITIAL_ZOOM
    camera.position.set(...INITIAL_POSITION)
    camera.updateProjectionMatrix()

    await new Promise<void>(resolve => setTimeout(resolve, 0))

    gl.setSize(smallWidth, smallHeight)
    gl.render(scene, camera)
    const dataUrl = gl.domElement.toDataURL('image/png')

    gl.setSize(originalSize.width, originalSize.height)
    camera.position.set(originalPosition.x, originalPosition.y, originalPosition.z)
    camera.zoom = originalZoom
    camera.updateProjectionMatrix()

    const img = new Image()
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error('Failed to load image'))
      img.src = dataUrl
    })

    const MAX_SIZE = 512
    const finalScale = Math.min(MAX_SIZE / img.width, MAX_SIZE / img.height, 1)
    const newWidth = Math.floor(img.width * finalScale)
    const newHeight = Math.floor(img.height * finalScale)

    const canvas = document.createElement('canvas')
    canvas.width = newWidth
    canvas.height = newHeight
    const ctx = canvas.getContext('2d')
    if (!ctx) return null

    ctx.drawImage(img, 0, 0, newWidth, newHeight)
    return canvas.toDataURL('image/png')
  }, [])

  const autoZoomToFit = useCallback(() => {
    const camera = cameraRef.current as THREE.OrthographicCamera | null
    const scene = sceneRef.current
    if (!camera || !scene) return

    const box = new THREE.Box3()
    let hasContent = false

    scene.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.computeBoundingBox()
        const geoBox = obj.geometry.boundingBox
        if (geoBox) {
          const worldBox = geoBox.clone().applyMatrix4(obj.matrixWorld)
          box.union(worldBox)
          hasContent = true
        }
      }
    })

    if (!hasContent) return

    const size = box.getSize(new THREE.Vector3())
    const center = box.getCenter(new THREE.Vector3())

    const gl = glRef.current
    if (!gl) return

    const aspect = gl.domElement.width / gl.domElement.height
    const margin = 1.2

    const viewHeight = size.y * margin
    const viewWidth = size.x * margin

    let targetViewHeight = viewHeight
    let targetViewWidth = viewWidth
    if (targetViewWidth / aspect > targetViewHeight) {
      targetViewHeight = targetViewWidth / aspect
    } else {
      targetViewWidth = targetViewHeight * aspect
    }

    const zoom = gl.domElement.height / targetViewHeight
    if (zoom > 0) {
      camera.zoom = zoom
      camera.position.set(center.x, center.y, 100)
      camera.updateProjectionMatrix()
    }
  }, [])

  useImperativeHandle(ref, () => ({ captureScreenshot, captureScreenshotForSaving, autoZoomToFit }), [captureScreenshot, captureScreenshotForSaving, autoZoomToFit])

  const closeContextMenu = useSketchEditorStore(s => s.closeContextMenu)

  const pointerDownPos = useRef<[number, number] | null>(null)
  const pointerDownButton = useRef<number | null>(null)
  const wasPointerDrag = useRef(false)

  // Layer 3B: clear isPointerDown and dynamicSelection on any pointer-up (including off-canvas releases).
  useSelectionPointerUpCleanup()

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    pointerDownButton.current = e.button
    if (e.button === 0 || e.button === 1 || e.button === 2) {
      pointerDownPos.current = [e.clientX, e.clientY]
    }
    if (e.button !== 2) closeContextMenu()
  }, [closeContextMenu])

  const handleMouseUp = useCallback((e: React.MouseEvent) => {
    if (!pointerDownPos.current) {
      wasPointerDrag.current = false
      pointerDownButton.current = null
      return
    }
    const dx = e.clientX - pointerDownPos.current[0]
    const dy = e.clientY - pointerDownPos.current[1]
    const wasDrag = Math.hypot(dx, dy) >= CLICK_THRESHOLD_PX
    wasPointerDrag.current = wasDrag
    pointerDownPos.current = null

    if (wasDrag) return

    if (e.button === 2 && onRightClick) {
      onRightClick([e.clientX, e.clientY])
    }
  }, [onRightClick])

  const showOrigin = isActive('Origin', features, rollbackPosition, visibleFeatures)
  const showFront  = isActive('Front',  features, rollbackPosition, visibleFeatures)
  const showTop    = isActive('Top',    features, rollbackPosition, visibleFeatures)
  const showRight  = isActive('Right',  features, rollbackPosition, visibleFeatures)

  const bodyItems = useMemo(
    () => getBodiesToRender(bodies, features, rollbackPosition, visibleFeatures),
    [bodies, features, rollbackPosition, visibleFeatures]
  )

  const activeSketchFeatures = useMemo(() => {
    if (!features) return []
    const limit = rollbackPosition ?? features.length
    return features.slice(0, limit).filter(f => f.kind === 'sketch' && (!visibleFeatures || visibleFeatures.has(f.id)))
  }, [features, rollbackPosition, visibleFeatures])

  return (
    <div
      style={{ position: 'relative', width: '100%', height: '100%' }}
      onMouseDown={handleMouseDown}
      onMouseUp={handleMouseUp}
      onContextMenu={e => { e.preventDefault(); }}
    >
      <Canvas
        style={{ width: '100%', height: '100%', background: '#111' }}
        gl={{ antialias: true, logarithmicDepthBuffer: true }}
        onCreated={onCreated}
        onPointerMissed={() => {
          // Only clear selection if this was a left-click on empty space, not a camera drag
          if (!wasPointerDrag.current && pointerDownButton.current === 0) {
            useSketchEditorStore.getState().clearNormalSelection()
            useSketchEditorStore.getState().setHoveredBodyId(null)
          }
        }}
      >
        <OrthographicCamera makeDefault position={INITIAL_POSITION} zoom={INITIAL_ZOOM} near={-10} far={1000} /* clipping planes */ />
        <SceneController resetTrigger={resetTrigger} canvasRef={canvasRef} pvRef={pvRef} hoverRef={hoverRef} snapRef={snapRef} cameraRef={cameraRef} />

        <CameraLight />

        {showOrigin && <OriginMarker />}
        {showFront  && <ReferencePlane rotation={[0,0,0]} label="Front" />}
        {showTop    && <ReferencePlane rotation={[-Math.PI/2,0,0]} label="Top" />}
        {showRight  && <ReferencePlane rotation={[0,Math.PI/2,0]} label="Right" />}

        {(features ?? [])
          .filter(f => f.kind === 'plane' && !['Origin','Top','Front','Right'].includes(f.id))
          .filter(f => isActive(f.id, features, rollbackPosition, visibleFeatures))
          .map(f => {
            const solveResult = solveResults?.[f.id]
            if (!solveResult?.plane_transform) return null
            return <UserDefinedPlane key={f.id} featureId={f.id} label={f.label || f.id} planeTransform={solveResult.plane_transform} />
          })}

        {activeSketchFeatures.map(f => {
          const solveResult = solveResults?.[f.id]
          const fullFeatureDef = featureDefs?.find(fd => fd.id === f.id) || f
          const sketch = solveResult?.solved ? solveResult.solved : unflattenGeometry(fullFeatureDef.initial || {}, fullFeatureDef.entities)
          const constraints = solveResult?.constraints ? solveResult.constraints : deriveConstraints(fullFeatureDef, sketch)
          return (
            <Geometry3D key={f.id} featureId={f.id} solved={sketch} entities={fullFeatureDef.entities} constraints={constraints} topology={solveResult?.topology} activeFeatureId={activeFeatureId} plane={fullFeatureDef.plane} planeTransform={solveResult?.plane_transform} solveStatus={solveResult?.status} entityStatus={solveResult?.features} showDebugHit={showDebugHit} />
          )
        })}

        {bodyItems.map(b => (
          <Body3D key={b.key} featureId={b.featureId} mesh={b.mesh} edges={b.edges} edgeQueries={b.edgeQueries} vertices={b.vertices} vertexQueries={b.vertexQueries} visible={b.visible} showDebugHit={showDebugHit} />
        ))}
      </Canvas>

      {!ready && <div style={{ position: 'absolute', inset: 0, background: '#111', zIndex: 1 }} />}

      <CubeGizmoCanvas canvasRef={canvasRef} pvRef={pvRef} hoverRef={hoverRef} snapRef={snapRef} cameraRef={cameraRef} />
      <ContextMenuDialog />
    </div>
  )
})
