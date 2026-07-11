// The assembly editor's scene. Stage 6f: three earlier stages deferred their
// render work here — 6c's assembly origin + planes, 6d's drag and triad-gizmo
// pointer surface, and 6e's edge curves. Stage 7.5 added the ID-picking driver
// and hover-gated anchor gizmos on top.
//
// This is NOT the part editor's Viewport. That one is bound to partEditorStore
// and sketchEditorStore, which stay single-part by design, so the assembly gets
// its own shell over the same scene furniture (SceneController, EnvLight,
// CubeGizmoCanvas). What the shell computes is nothing: the render list comes
// from utils/assemblyRender.ts, every gesture goes through
// utils/assemblyPointer.ts, and the anchor set under the cursor comes from
// utils/anchorGizmos.ts — all viewport-free and unit-tested.

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
import AnchorGizmos from '@/components/Viewport/assembly/AnchorGizmos'
import AssemblyBody from '@/components/Viewport/assembly/AssemblyBody'
import AssemblyBuiltin from '@/components/Viewport/assembly/AssemblyBuiltin'
import AssemblyPickLayers from '@/components/Viewport/assembly/AssemblyPickLayers'
import RollGuideGizmo, { type RollGuideSpec } from '@/components/Viewport/assembly/RollGuideGizmo'
import TriadGizmo from '@/components/Viewport/assembly/TriadGizmo'
import type { EdgeCurve } from '@/kernel/partBundle'
import IdPickingDriver from '@/picking/IdPickingDriver'
import type { IdPipeline } from '@/picking'
import {
  EDGE_LAYER_NAME, FACE_LAYER_NAME, ORIGIN_LAYER_NAME, PLANE_LAYER_NAME, VERTEX_LAYER_NAME,
} from '@/picking'
import { useAssemblyStore } from '@/stores/assemblyStore'
import { lookupAnchor, resolveAnchorGizmos } from '@/utils/anchorGizmos'
import {
  getAssemblyBuiltinsToRender,
  getAssemblyPartGroups,
  gizmoOrientation,
  gizmoOrigin,
} from '@/utils/assemblyRender'
import { createAssemblyPointerAdapter, type GizmoMode } from '@/utils/assemblyPointer'
import { isManipulable } from '@/utils/partManipulation'
import type { Ray } from '@/utils/gizmoMath'
import { rotateVector, transformQuat, type Vec3 } from '@/utils/transform3d'

// Everything an assembly can mate to: a part's B-rep entities and the
// assembly's own frame. The sketch layers never render here, but naming the
// set explicitly keeps a future layer from silently becoming pickable.
const ASSEMBLY_PICK_LAYERS: ReadonlySet<string> = new Set([
  FACE_LAYER_NAME, EDGE_LAYER_NAME, VERTEX_LAYER_NAME, PLANE_LAYER_NAME, ORIGIN_LAYER_NAME,
])

// Stable identity: AssemblyBody memoizes its edge buffer on `curves`, so a fresh
// [] per render would rebuild every body's line geometry on every frame.
const EMPTY_CURVES: EdgeCurve[] = []

const CANVAS_STYLE = { width: '100%', height: '100%', background: '#111' }
const CANVAS_GL = { antialias: true, logarithmicDepthBuffer: true }
const PARENT_STYLE: React.CSSProperties = { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, touchAction: 'none' }

export default function AssemblyViewport() {
  const doc = useAssemblyStore(s => s.doc)
  const mates = useAssemblyStore(s => s.mates)
  const selectedMateId = useAssemblyStore(s => s.selectedMateId)
  const bodies = useAssemblyStore(s => s.bodies)
  const edgeCurves = useAssemblyStore(s => s.edgeCurves)
  const instances = useAssemblyStore(s => s.instances)
  const transforms = useAssemblyStore(s => s.transforms)
  const manipulation = useAssemblyStore(s => s.manipulation)
  const selectedPartHandle = useAssemblyStore(s => s.selectedPartHandle)
  const pickGeometry = useAssemblyStore(s => s.pickGeometry)
  const entityMateRefs = useAssemblyStore(s => s.entityMateRefs)
  const anchors = useAssemblyStore(s => s.anchors)
  const hoverHits = useAssemblyStore(s => s.hoverHits)
  const pickScopeEntity = useAssemblyStore(s => s.pickScopeEntity)
  const pickCandidates = useAssemblyStore(s => s.pickCandidates)
  const pickIndex = useAssemblyStore(s => s.pickIndex)
  // An armed mate chip turns the whole scene into a reference picker: a plain
  // click aims instead of grabbing, so authoring a mate never nudges a part.
  const aiming = useAssemblyStore(s => s.activeMateField !== null)

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const pipelineRef = useRef<IdPipeline | null>(null)
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

  // Each part's world basis, so a hovered anchor's display rings turn with the
  // part instead of staying world-locked. Anchors are hover-only and cleared on
  // grab, so the solved transform (not the live drag pose) is the right frame.
  const partBases = useMemo(() => {
    const out: Record<string, [Vec3, Vec3, Vec3]> = {}
    for (const handle of Object.keys(transforms)) {
      const q = transformQuat(transforms[handle])
      out[handle] = [
        rotateVector(q, [1, 0, 0]),
        rotateVector(q, [0, 1, 0]),
        rotateVector(q, [0, 0, 1]),
      ]
    }
    return out
  }, [transforms])

  // Nothing is drawn until the cursor rests on an entity: this is the whole of
  // the hover gate. The aimed candidate is highlighted only while it is still
  // under the cursor; moving away leaves the pick standing but undrawn.
  const gizmos = useMemo(
    () => resolveAnchorGizmos(
      hoverHits, entityMateRefs, anchors, pickScopeEntity, pickCandidates[pickIndex] ?? null, partBases,
    ),
    [hoverHits, entityMateRefs, anchors, pickScopeEntity, pickCandidates, pickIndex, partBases],
  )

  // The roll-guide arrow (Stage 3): only a selected `fixed` mate has one, drawn
  // about ref_a's anchor axis so it moves with whichever body the roll is
  // measured against. A stale ref_a (anchor missing from the solved table)
  // simply draws nothing rather than a guide floating at the origin.
  //
  // `mates` is a fresh array of fresh wrapper objects on every doc mutation
  // (useAssemblyDoc.ts derives it via `useMemo(() => mateFeatures(doc), [doc])`),
  // so depending on it directly would rebuild the guide's geometry on every
  // unrelated edit -- another part dragged, a different mate renamed. The find
  // below is cheap and runs every render; the memo instead keys on the handful
  // of primitive values that actually change what the guide draws, so its
  // identity (and RollGuideGizmo's own geometry memo) survives an unrelated
  // re-render or re-solve.
  const selectedMate = selectedMateId ? mates.find(m => m.id === selectedMateId)?.mate : undefined
  const rollGuideAnchor = selectedMate && selectedMate.kind === 'fixed'
    ? lookupAnchor(anchors, selectedMate.ref_a)
    : undefined
  const rollGuideAngleDeg = typeof selectedMate?.angle === 'number' ? selectedMate.angle : 0
  const rollGuideSpec = useMemo((): RollGuideSpec | null => {
    if (!rollGuideAnchor) return null
    return { point: [...rollGuideAnchor.point] as Vec3, axis: [...rollGuideAnchor.axis] as Vec3, angleDeg: rollGuideAngleDeg }
  }, [rollGuideAnchor, rollGuideAngleDeg])

  const onPipelineReady = useCallback((p: IdPipeline) => { pipelineRef.current = p }, [])
  // A grounded part is the assembly's static frame: it selects, but it gets no
  // gizmo, because there is nothing the gizmo could move. Nor does any part while
  // a mate chip is armed: the triad's arrows sit over the very geometry the user
  // is aiming at, and grabbing one would move the part instead of picking it.
  const triad = useMemo(() => {
    if (aiming) return null
    const inst = instances.find(i => i.handle === selectedPartHandle)
    if (!isManipulable(inst)) return null
    const origin = gizmoOrigin(selectedPartHandle, groups, transforms, instances)
    const orientation = gizmoOrientation(selectedPartHandle, groups, transforms, instances)
    return origin && orientation ? { origin, orientation } : null
  }, [aiming, selectedPartHandle, groups, transforms, instances])

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

  // The ID buffer is read in drawing-buffer pixels; the pointer speaks CSS.
  const resolveHitsAt = useCallback((e: { clientX: number; clientY: number }) => {
    const gl = glRef.current
    const pipeline = pipelineRef.current
    if (!gl || !pipeline) return []
    const canvas = gl.domElement
    const rect = canvas.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return []
    const cursor = {
      x: (e.clientX - rect.left) * (canvas.width / rect.width),
      y: (e.clientY - rect.top) * (canvas.height / rect.height),
    }
    return pipeline.resolveAllSync(gl, cursor, { allowedLayers: ASSEMBLY_PICK_LAYERS })
  }, [])

  // One GPU readback per frame at most. A pointermove fires far faster than the
  // ID buffer can be re-read, and a sync readback stalls the pipeline.
  const hoverFrame = useRef(0)
  const hoverEvent = useRef<{ clientX: number; clientY: number; ctrlKey: boolean } | null>(null)

  // Dropping the hover means dropping the frame that would restore it. A move
  // from a fraction of a frame ago is still queued when the user grabs the part
  // or leaves the pane, and letting it land would re-draw the anchors the clear
  // was for, with nothing left to clear them again.
  const clearHover = useCallback(() => {
    if (hoverFrame.current) cancelAnimationFrame(hoverFrame.current)
    hoverFrame.current = 0
    hoverEvent.current = null
    useAssemblyStore.getState().clearHover()
  }, [])

  const scheduleHover = useCallback((e: React.PointerEvent) => {
    // A held button means an orbit is in progress. Every frame of it would
    // re-render the ID buffer and read it back, to answer a question the user is
    // not asking while swinging the camera around.
    if (e.buttons !== 0) {
      clearHover()
      return
    }
    hoverEvent.current = { clientX: e.clientX, clientY: e.clientY, ctrlKey: e.ctrlKey }
    if (hoverFrame.current) return
    hoverFrame.current = requestAnimationFrame(() => {
      hoverFrame.current = 0
      const pending = hoverEvent.current
      if (!pending) return
      useAssemblyStore.getState().setHoverHits(resolveHitsAt(pending), pending.ctrlKey)
    })
  }, [clearHover, resolveHitsAt])

  useEffect(() => () => { if (hoverFrame.current) cancelAnimationFrame(hoverFrame.current) }, [])

  // Ctrl narrows the hover scope, and the user may press or release it without
  // moving the mouse. Re-deriving from the hits already in hand keeps the drawn
  // set honest without another readback.
  useEffect(() => {
    const sync = (e: KeyboardEvent) => {
      if (e.key !== 'Control') return
      const store = useAssemblyStore.getState()
      if (store.hoverHits.length === 0) return
      store.setHoverHits(store.hoverHits, e.type === 'keydown')
    }
    window.addEventListener('keydown', sync)
    window.addEventListener('keyup', sync)
    return () => {
      window.removeEventListener('keydown', sync)
      window.removeEventListener('keyup', sync)
    }
  }, [])

  const handleGrabBody = useCallback((handle: string, point: Vec3) => {
    const camera = cameraRef.current
    if (!camera) return
    // Free drag happens in the plane facing the camera through the grab point,
    // so the part follows the cursor exactly under any view direction.
    const forward = camera.getWorldDirection(new THREE.Vector3())
    if (adapter.onBodyPointerDown(handle, point, [forward.x, forward.y, forward.z])) {
      // The ID buffer keeps the solved pose while the drag offsets the drawn
      // part, so anchors held over from before the grab would trail behind it.
      clearHover()
      setManipulating(true)
    }
  }, [adapter, clearHover])

  const handleGrabGizmo = useCallback((mode: GizmoMode, axis: Vec3, e: ThreeEvent<PointerEvent>) => {
    if (!selectedPartHandle || !triad) return
    const ray = rayFromEvent(e)
    if (!ray) return
    if (adapter.onGizmoPointerDown(selectedPartHandle, mode, axis, triad.origin, ray)) {
      clearHover()  // the gizmo moves the part too; same stale-anchor trail
      setManipulating(true)
    }
  }, [adapter, clearHover, rayFromEvent, selectedPartHandle, triad])

  // R3F's mesh handlers run on the canvas, whose events bubble here. Capturing
  // the pointer once a gesture has started keeps a drag alive when the cursor
  // grazes the pane edge, and guarantees the release reaches us wherever it
  // lands — otherwise a session would hang with the camera locked.
  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (adapter.isActive()) {
      e.currentTarget.setPointerCapture(e.pointerId)
      return
    }
    // Ctrl+click aims a mate reference instead of grabbing the part (AssemblyBody
    // declines the grab for the same modifier), and so does a plain click while a
    // mate chip is armed. Landing on the pixel that produced the current set
    // advances the cycle, so a corner's seven entities are all reachable without
    // moving the mouse.
    if (e.button === 0 && (e.ctrlKey || aiming)) {
      useAssemblyStore.getState().pickFromHitsOrCycle(resolveHitsAt(e))
    }
  }, [adapter, aiming, resolveHitsAt])

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!adapter.isActive()) {
      scheduleHover(e)
      return
    }
    const ray = rayFromEvent(e)
    if (ray) adapter.onPointerMove(ray)
  }, [adapter, rayFromEvent, scheduleHover])

  // The cursor left the pane, so nothing is under it. Gizmos drawn from the last
  // hover would sit there advertising a pick the pointer can no longer make.
  const handlePointerLeave = useCallback(() => { clearHover() }, [clearHover])

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
      onPointerLeave={handlePointerLeave}
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

        <IdPickingDriver onReady={onPipelineReady} />
        <AssemblyPickLayers bodies={pickGeometry} />

        <Environment files="/env.hdr" background={false} environmentIntensity={ENV_INTENSITY} />
        <EnvLight />

        {builtins.map(b => <AssemblyBuiltin key={b.id} item={b} />)}

        {groups.map(g => (
          <group key={g.handle} position={g.position} quaternion={g.quaternion}>
            {g.items.map(item => (
              <AssemblyBody
                key={item.key}
                item={item}
                curves={edgeCurves[item.bodyId] ?? EMPTY_CURVES}
                selected={g.selected}
                aiming={aiming}
                onGrab={(point) => handleGrabBody(g.handle, point)}
              />
            ))}
          </group>
        ))}

        <AnchorGizmos gizmos={gizmos} />
        <RollGuideGizmo spec={rollGuideSpec} />

        {triad && <TriadGizmo origin={triad.origin} orientation={triad.orientation} onGrab={handleGrabGizmo} />}
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
