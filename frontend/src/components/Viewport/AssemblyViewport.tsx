// The assembly editor's scene. Stage 6f: three earlier stages deferred their
// render work here — 6c's assembly origin + planes, 6d's drag and triad-gizmo
// pointer surface, and (next) 6e's edge curves.
//
// This is NOT the part editor's Viewport. That one is bound to partEditorStore
// and sketchEditorStore, which stay single-part by design, so the assembly gets
// its own shell over the same scene furniture (SceneController, EnvLight,
// CubeGizmoCanvas). What the shell computes is nothing: the render list comes
// from utils/assemblyRender.ts and every gesture goes through
// utils/assemblyPointer.ts, both viewport-free and unit-tested.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Canvas, type ThreeEvent } from '@react-three/fiber'
import { Environment } from '@react-three/drei'
import * as THREE from 'three'
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib'
import { CubeGizmoCanvas } from '@/components/misc/CubeGizmo'
import type { Hit, Pv } from '@/components/misc/CubeGizmo.utils'
import SceneController from '@/components/Viewport/SceneController'
import EnvLight, { ENV_INTENSITY } from '@/components/Viewport/EnvLight'
import { INITIAL_CAMERA } from '@/components/Viewport/cameraConstants'
import { fitToContent } from '@/components/Viewport/cameraController'
import { PlaneLabel, PlaneSurface } from '@/components/Viewport/PlaneVisual'
import { Dot } from '@/components/Geometry3D/VertexDots'
import { COLOR_INACTIVE } from '@/components/Geometry3D/constants'
import AssemblyBody from '@/components/Viewport/assembly/AssemblyBody'
import TriadGizmo from '@/components/Viewport/assembly/TriadGizmo'
import type { EdgeCurve } from '@/kernel/partBundle'
import { useAssemblyStore } from '@/stores/assemblyStore'
import {
  ASSEMBLY_PLANE_SIZE,
  getAssemblyBuiltinsToRender,
  getAssemblyPartGroups,
  gizmoOrigin,
} from '@/utils/assemblyRender'
import { createAssemblyPointerAdapter, type GizmoMode } from '@/utils/assemblyPointer'
import { isManipulable } from '@/utils/partManipulation'
import type { Ray } from '@/utils/gizmoMath'
import type { Vec3 } from '@/utils/transform3d'

// Stable identity: AssemblyBody memoizes its edge buffer on `curves`, so a fresh
// [] per render would rebuild every body's line geometry on every frame.
const EMPTY_CURVES: EdgeCurve[] = []

const CANVAS_STYLE = { width: '100%', height: '100%', background: '#111' }
const CANVAS_GL = { antialias: true, logarithmicDepthBuffer: true }
const PARENT_STYLE: React.CSSProperties = { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, touchAction: 'none' }

export default function AssemblyViewport() {
  const doc = useAssemblyStore(s => s.doc)
  const bodies = useAssemblyStore(s => s.bodies)
  const edgeCurves = useAssemblyStore(s => s.edgeCurves)
  const instances = useAssemblyStore(s => s.instances)
  const transforms = useAssemblyStore(s => s.transforms)
  const manipulation = useAssemblyStore(s => s.manipulation)
  const selectedPartHandle = useAssemblyStore(s => s.selectedPartHandle)

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const pvRef = useRef<Pv[]>([])
  const hoverRef = useRef<Hit | null>(null)
  const snapRef = useRef<THREE.Vector3 | null>(null)
  const cameraRef = useRef<THREE.Camera | null>(null)
  const controlsRef = useRef<OrbitControlsImpl | null>(null)
  const glRef = useRef<THREE.WebGLRenderer | null>(null)
  const sceneRef = useRef<THREE.Scene | null>(null)
  const raycaster = useMemo(() => new THREE.Raycaster(), [])

  // Orbiting must stop while a part is under the pointer, or the same drag would
  // move the part and the camera. Mirrored into state because OrbitControls is a
  // rendered prop, not a ref read.
  const [manipulating, setManipulating] = useState(false)

  const adapter = useMemo(() => createAssemblyPointerAdapter({
    beginPartManipulation: (h) => useAssemblyStore.getState().beginPartManipulation(h),
    dragPartTranslate: (d) => useAssemblyStore.getState().dragPartTranslate(d),
    rotatePartGizmo: (a, angle, pivot) => useAssemblyStore.getState().rotatePartGizmo(a, angle, pivot),
    endPartManipulation: () => useAssemblyStore.getState().endPartManipulation(),
    cancelPartManipulation: () => useAssemblyStore.getState().cancelPartManipulation(),
    setSelectedPartHandle: (h) => useAssemblyStore.getState().setSelectedPartHandle(h),
  }), [])

  const onCreated = useCallback((state: { gl: THREE.WebGLRenderer; scene: THREE.Scene }) => {
    glRef.current = state.gl
    sceneRef.current = state.scene
  }, [])

  const groups = useMemo(
    () => getAssemblyPartGroups(bodies, instances, manipulation, selectedPartHandle),
    [bodies, instances, manipulation, selectedPartHandle],
  )
  const builtins = useMemo(() => getAssemblyBuiltinsToRender(doc), [doc])
  // A grounded part is the assembly's static frame: it selects, but it gets no
  // gizmo, because there is nothing the gizmo could move.
  const triadOrigin = useMemo(() => {
    const inst = instances.find(i => i.handle === selectedPartHandle)
    if (!isManipulable(inst)) return null
    return gizmoOrigin(selectedPartHandle, groups, transforms, instances)
  }, [selectedPartHandle, groups, transforms, instances])

  // Frame the assembly once, when its first geometry lands.
  const fittedRef = useRef(false)
  useEffect(() => {
    if (fittedRef.current || Object.keys(bodies).length === 0) return
    const camera = cameraRef.current as THREE.OrthographicCamera | null
    if (!camera) return
    if (fitToContent(camera, controlsRef.current, bodies, sceneRef.current)) fittedRef.current = true
  }, [bodies])

  // A drag continues while the pointer is outside the pane, so the move/up
  // listeners live on the wrapper (which captures the pointer), not on the
  // meshes. Only the client coords are read, so a three.js pointer event serves
  // as well as a React one.
  const rayFromEvent = useCallback((e: { clientX: number; clientY: number }): Ray | null => {
    const gl = glRef.current
    const camera = cameraRef.current
    if (!gl || !camera) return null
    const rect = gl.domElement.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return null
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    )
    raycaster.setFromCamera(ndc, camera)
    const { origin, direction } = raycaster.ray
    return {
      origin: [origin.x, origin.y, origin.z],
      direction: [direction.x, direction.y, direction.z],
    }
  }, [raycaster])

  const handleGrabBody = useCallback((handle: string, point: Vec3) => {
    const camera = cameraRef.current
    if (!camera) return
    // Free drag happens in the plane facing the camera through the grab point,
    // so the part follows the cursor exactly under any view direction.
    const forward = camera.getWorldDirection(new THREE.Vector3())
    if (adapter.onBodyPointerDown(handle, point, [forward.x, forward.y, forward.z])) {
      setManipulating(true)
    }
  }, [adapter])

  const handleGrabGizmo = useCallback((mode: GizmoMode, axis: Vec3, e: ThreeEvent<PointerEvent>) => {
    if (!selectedPartHandle || !triadOrigin) return
    const ray = rayFromEvent(e)
    if (!ray) return
    if (adapter.onGizmoPointerDown(selectedPartHandle, mode, axis, triadOrigin, ray)) {
      setManipulating(true)
    }
  }, [adapter, rayFromEvent, selectedPartHandle, triadOrigin])

  // R3F's mesh handlers run on the canvas, whose events bubble here. Capturing
  // the pointer once a gesture has started keeps a drag alive when the cursor
  // grazes the pane edge, and guarantees the release reaches us wherever it
  // lands — otherwise a session would hang with the camera locked.
  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (adapter.isActive()) e.currentTarget.setPointerCapture(e.pointerId)
  }, [adapter])

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!adapter.isActive()) return
    const ray = rayFromEvent(e)
    if (ray) adapter.onPointerMove(ray)
  }, [adapter, rayFromEvent])

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    if (!adapter.isActive()) return
    adapter.onPointerUp()  // commits the seed transform and asks for one re-solve
    setManipulating(false)
  }, [adapter])

  // The browser tore the gesture away (a touch became a scroll, the pointer was
  // lost). Abandon it rather than commit a pose the user never released on.
  const handlePointerCancel = useCallback(() => {
    if (!adapter.isActive()) return
    adapter.cancel()
    setManipulating(false)
  }, [adapter])

  // Escape abandons the gesture: the part snaps back to its solved pose and no
  // re-solve runs, the standard out for a drag started by mistake.
  useEffect(() => {
    if (!manipulating) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      adapter.cancel()
      setManipulating(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [adapter, manipulating])

  const onPointerMissed = useCallback(() => {
    if (adapter.isActive()) return
    useAssemblyStore.getState().setSelectedPartHandle(null)
  }, [adapter])

  const handleContextMenu = useCallback((e: React.MouseEvent) => { e.preventDefault() }, [])

  return (
    <div
      style={PARENT_STYLE}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onContextMenu={handleContextMenu}
    >
      <Canvas
        orthographic
        camera={INITIAL_CAMERA}
        style={CANVAS_STYLE}
        gl={CANVAS_GL}
        onCreated={onCreated}
        onPointerMissed={onPointerMissed}
      >
        <SceneController
          key="scene-ctrl"
          canvasRef={canvasRef}
          pvRef={pvRef}
          hoverRef={hoverRef}
          snapRef={snapRef}
          cameraRef={cameraRef}
          controlsRef={controlsRef}
          orbitEnabled={!manipulating}
        />

        <Environment files="/env.hdr" background={false} environmentIntensity={ENV_INTENSITY} />
        <EnvLight />

        {builtins.map(b => (b.kind === 'origin' ? (
          <Dot key={b.id} x={0} y={0} px={4} color={COLOR_INACTIVE} billboard renderOrder={999} depthTest={false} />
        ) : (
          <group key={b.id} rotation={b.rotation}>
            <PlaneSurface size={ASSEMBLY_PLANE_SIZE} />
            <PlaneLabel x={-ASSEMBLY_PLANE_SIZE / 2} y={ASSEMBLY_PLANE_SIZE / 2}>{b.label}</PlaneLabel>
          </group>
        )))}

        {groups.map(g => (
          <group key={g.handle} position={g.position} quaternion={g.quaternion}>
            {g.items.map(item => (
              <AssemblyBody
                key={item.key}
                item={item}
                curves={edgeCurves[item.bodyId] ?? EMPTY_CURVES}
                selected={g.selected}
                onGrab={(point) => handleGrabBody(g.handle, point)}
              />
            ))}
          </group>
        ))}

        {triadOrigin && <TriadGizmo origin={triadOrigin} onGrab={handleGrabGizmo} />}
      </Canvas>

      <CubeGizmoCanvas
        canvasRef={canvasRef}
        pvRef={pvRef}
        hoverRef={hoverRef}
        snapRef={snapRef}
        cameraRef={cameraRef}
      />
    </div>
  )
}
