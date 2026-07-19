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

import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { Canvas } from '@react-three/fiber'
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
import AssemblySelectionHighlight from '@/components/Viewport/assembly/AssemblySelectionHighlight'
import GizmoPickLayer from '@/components/Viewport/assembly/GizmoPickLayer'
import RollGuideGizmo, { type RollGuideSpec } from '@/components/Viewport/assembly/RollGuideGizmo'
import TriadGizmo from '@/components/Viewport/assembly/TriadGizmo'
import IdDebugOverlay from '@/components/Viewport/IdDebugOverlay'
import { CLICK_THRESHOLD_PX } from '@/components/Geometry3D/constants'
import type { EdgeCurve } from '@/kernel/partBundle'
import IdPickingDriver from '@/picking/IdPickingDriver'
import type { IdPipeline } from '@/picking'
import {
  EDGE_LAYER_NAME, FACE_LAYER_NAME, GIZMO_HANDLE_LAYER_NAME, ORIGIN_LAYER_NAME,
  PLANE_LAYER_NAME, VERTEX_LAYER_NAME,
} from '@/picking'
import { useAssemblyStore } from '@/stores/assemblyStore'
import { lookupAnchor, resolveAnchorGizmos } from '@/utils/anchorGizmos'
import {
  getAssemblyBuiltinsToRender,
  getAssemblyPartGroups,
  gizmoOrientation,
  gizmoOrigin,
} from '@/utils/assemblyRender'
import { captureThumbnail } from '@/components/Viewport/captureThumbnail'
import { createAssemblyPointerAdapter, gestureAllowsSelect } from '@/utils/assemblyPointer'
import { parseGizmoHandleKey } from '@/utils/gizmoPickGeometry'
import { isManipulable } from '@/utils/partManipulation'
import type { Ray } from '@/utils/gizmoMath'
import { rotateVector, transformQuat, type Vec3 } from '@/utils/transform3d'

// Everything an assembly can mate to: a part's B-rep entities and the
// assembly's own frame. The sketch layers never render here, but naming the
// set explicitly keeps a future layer from silently becoming pickable.
const ASSEMBLY_PICK_LAYERS: ReadonlySet<string> = new Set([
  FACE_LAYER_NAME, EDGE_LAYER_NAME, VERTEX_LAYER_NAME, PLANE_LAYER_NAME, ORIGIN_LAYER_NAME,
])

// Kept out of ASSEMBLY_PICK_LAYERS on purpose: a triad handle is a drag
// affordance, never a mate reference or a measurement target, so the mate
// picker and the selection toggle must not be able to resolve one.
const GIZMO_PICK_LAYERS: ReadonlySet<string> = new Set([GIZMO_HANDLE_LAYER_NAME])

// Hover asks both questions in one readback: the ID buffer is read at most once
// per frame, so a second resolve for the gizmo would double the GPU stall.
const HOVER_PICK_LAYERS: ReadonlySet<string> = new Set([...ASSEMBLY_PICK_LAYERS, GIZMO_HANDLE_LAYER_NAME])

// Stable identity: AssemblyBody memoizes its edge buffer on `curves`, so a fresh
// [] per render would rebuild every body's line geometry on every frame.
const EMPTY_CURVES: EdgeCurve[] = []

const CANVAS_STYLE = { width: '100%', height: '100%', background: '#111' }
const CANVAS_GL = { antialias: true, logarithmicDepthBuffer: true }
const PARENT_STYLE: React.CSSProperties = { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, touchAction: 'none' }

// The assembly editor grabs a preview of the solved scene on save, exactly as
// the part editor does; that is the whole of what it needs from the viewport.
export interface AssemblyViewportHandle {
  captureScreenshotForSaving: () => Promise<string | null>
}

export default forwardRef<AssemblyViewportHandle, object>(function AssemblyViewport(_props, ref) {
  const doc = useAssemblyStore(s => s.doc)
  const mates = useAssemblyStore(s => s.mates)
  const selectedMateId = useAssemblyStore(s => s.selectedMateId)
  const bodies = useAssemblyStore(s => s.bodies)
  const edgeCurves = useAssemblyStore(s => s.edgeCurves)
  const instances = useAssemblyStore(s => s.instances)
  const transforms = useAssemblyStore(s => s.transforms)
  const manipulation = useAssemblyStore(s => s.manipulation)
  const settlingOffsets = useAssemblyStore(s => s.settlingOffsets)
  const selectedPartHandle = useAssemblyStore(s => s.selectedPartHandle)
  const pickGeometry = useAssemblyStore(s => s.pickGeometry)
  const entityMateRefs = useAssemblyStore(s => s.entityMateRefs)
  const anchors = useAssemblyStore(s => s.anchors)
  const hoverHits = useAssemblyStore(s => s.hoverHits)
  const pickScopeEntity = useAssemblyStore(s => s.pickScopeEntity)
  const pickCandidates = useAssemblyStore(s => s.pickCandidates)
  const pickIndex = useAssemblyStore(s => s.pickIndex)
  const selection = useAssemblyStore(s => s.selection)
  const hoveredEntity = useAssemblyStore(s => s.hoveredEntity)
  const showPickDebug = useAssemblyStore(s => s.showPickDebug)
  // An armed mate chip turns the whole scene into a reference picker: a plain
  // click aims instead of grabbing, so authoring a mate never nudges a part.
  // With no chip armed the viewport is a plain B-rep selector instead (faces,
  // edges, planes for measurement), which is the part editor's normal mode.
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
  // Which triad handle the cursor is over, so it can light up. Viewport-local:
  // it is a drag affordance's highlight, not part of the document selection.
  const [hoveredGizmo, setHoveredGizmo] = useState<string | null>(null)

  const adapter = useMemo(() => createAssemblyPointerAdapter({
    beginPartManipulation: (h) => useAssemblyStore.getState().beginPartManipulation(h),
    dragPartTranslate: (d) => useAssemblyStore.getState().dragPartTranslate(d),
    rotatePartGizmo: (a, angle, pivot) => useAssemblyStore.getState().rotatePartGizmo(a, angle, pivot),
    endPartManipulation: () => useAssemblyStore.getState().endPartManipulation(),
    cancelPartManipulation: () => useAssemblyStore.getState().cancelPartManipulation(),
    setSelectedPartHandle: (h) => useAssemblyStore.getState().setSelectedPartHandle(h),
    setGizmoDrag: (d) => useAssemblyStore.getState().setGizmoDrag(d),
  }), [])

  const onCreated = useCallback((state: { gl: THREE.WebGLRenderer; scene: THREE.Scene }) => {
    glRef.current = state.gl
    sceneRef.current = state.scene
  }, [])

  useImperativeHandle(ref, () => ({
    captureScreenshotForSaving: () => captureThumbnail(glRef.current, sceneRef.current, cameraRef.current),
  }), [])

  const groups = useMemo(
    () => getAssemblyPartGroups(bodies, instances, manipulation, selectedPartHandle, settlingOffsets),
    [bodies, instances, manipulation, selectedPartHandle, settlingOffsets],
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
  const resolveHitsAt = useCallback((
    e: { clientX: number; clientY: number },
    layers: ReadonlySet<string> = ASSEMBLY_PICK_LAYERS,
  ) => {
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
    return pipeline.resolveAllSync(gl, cursor, { allowedLayers: layers })
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
    setHoveredGizmo(null)
    const store = useAssemblyStore.getState()
    store.clearHover()  // the aiming-mode anchor hover
    store.setHoveredEntity(null)  // the selection-mode B-rep hover
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
      const store = useAssemblyStore.getState()
      const all = resolveHitsAt(pending, HOVER_PICK_LAYERS)
      // A triad handle outranks every entity, so it can only be first. Split it
      // off before the entity paths see the list: a handle is never an entity.
      const gizmoHit = all[0]?.layer === GIZMO_HANDLE_LAYER_NAME ? all[0].entityKey : null
      setHoveredGizmo(gizmoHit)
      const hits = gizmoHit ? all.filter(h => h.layer !== GIZMO_HANDLE_LAYER_NAME) : all
      // Aiming reveals the hovered entity's anchor triads; the plain selector
      // just highlights the single top entity a click would toggle. Read the
      // mode from the store, not a captured prop, so a mid-hover mode switch is
      // never one frame stale.
      if (store.activeMateField !== null) {
        store.setHoverHits(hits, pending.ctrlKey)
      } else {
        store.setHoveredEntity(hits[0]?.entityKey ?? null)
      }
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
    // The triad already claimed this pointer-down in the capture phase below.
    // AssemblyBody's R3F handler runs later (R3F listens natively on its own
    // canvas wrapper, which this div encloses), so without this the body grab
    // would overwrite the gesture the user actually started.
    if (adapter.isActive()) return
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

  // The triad's pointer-down, run in the CAPTURE phase. React registers capture
  // listeners on its root container, an ancestor of this div, so this fires
  // while the event is still travelling down -- before it reaches the canvas
  // wrapper R3F listens on, and therefore before AssemblyBody's body grab. That
  // ordering is the whole fix: the gizmo is drawn on top and now decides first
  // too, with the ID buffer's layer priority as the single arbiter of what the
  // pixel under the cursor belongs to.
  const handleGizmoPointerDownCapture = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0 || e.ctrlKey || !selectedPartHandle || !triad) return
    const hit = resolveHitsAt(e, GIZMO_PICK_LAYERS)[0]
    const handle = parseGizmoHandleKey(hit?.entityKey)
    if (!handle) return
    const ray = rayFromEvent(e)
    if (!ray) return
    // The registered handles carry the part-local axis and its `u` companion;
    // the ray math works in world space, so lift both through the pose the
    // triad is drawn in. The axis NAME stays local, because that is what the
    // triad matches against GIZMO_AXES when it narrows to the grabbed handle.
    const axis = rotateVector(triad.orientation, handle.axis)
    const reference = rotateVector(triad.orientation, handle.reference)
    if (adapter.onGizmoPointerDown(
      selectedPartHandle, handle.kind, handle.name, axis, reference, triad.origin, ray,
    )) {
      clearHover()  // the gizmo moves the part too; same stale-anchor trail
      setManipulating(true)
    }
  }, [adapter, clearHover, rayFromEvent, resolveHitsAt, selectedPartHandle, triad])

  // Pointer-down screen position, kept so pointer-up can tell a click from a
  // drag: a body grab (which fires on the R3F mesh handler before this one) is
  // still a select if the pointer never moved.
  const pointerDownPos = useRef<{ x: number; y: number } | null>(null)

  // R3F's mesh handlers run on the canvas, whose events bubble here. Capturing
  // the pointer once a gesture has started keeps a drag alive when the cursor
  // grazes the pane edge, and guarantees the release reaches us wherever it
  // lands — otherwise a session would hang with the camera locked.
  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    // Record before the active-gesture early-out: the mesh handler has already
    // opened the grab by the time this bubbles up, so an early return here would
    // lose the down position a plain select needs.
    if (e.button === 0) pointerDownPos.current = { x: e.clientX, y: e.clientY }
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
    const down = pointerDownPos.current
    pointerDownPos.current = null
    // Commits the seed transform and asks for one re-solve; inert with no session.
    const gesture = adapter.onPointerUp()
    if (gesture.source) setManipulating(false)
    // Selection mode: a left click that never became a drag toggles the top
    // entity under the cursor into the measurement set. Which gestures are still
    // a click is gestureAllowsSelect's call, not this handler's: a triad handle
    // click and a drag that moved the part both end here and neither selects.
    // Aiming and Ctrl clicks are the mate picker's, handled on pointer-down, so
    // they never fall through here.
    if (!gestureAllowsSelect(gesture)) return
    const store = useAssemblyStore.getState()
    if (store.activeMateField !== null || e.button !== 0 || !down || e.ctrlKey) return
    if (Math.hypot(e.clientX - down.x, e.clientY - down.y) >= CLICK_THRESHOLD_PX) return
    const hits = resolveHitsAt(e)
    if (hits.length > 0) store.toggleSelection(hits[0].entityKey)
  }, [adapter, resolveHitsAt])

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
    const store = useAssemblyStore.getState()
    store.setSelectedPartHandle(null)
    store.setSelectedMateId(null)
    // An empty-space click clears the B-rep selection too, the same "click off to
    // deselect" the part editor gives. Not while aiming: the mate picker owns the
    // click there and a miss simply aims at nothing.
    if (store.activeMateField === null) store.clearSelection()
  }, [adapter])

  const handleContextMenu = useCallback((e: React.MouseEvent) => { e.preventDefault() }, [])

  return (
    <div
      style={PARENT_STYLE}
      onPointerDownCapture={handleGizmoPointerDownCapture}
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
        {showPickDebug && <IdDebugOverlay />}

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

        {/* B-rep selection highlight, only in the plain selector mode: the
            aiming mode shows anchor triads over the same geometry instead. It is
            also hidden mid-drag, where the pickGeometry it reads still holds the
            pre-drag pose and would leave the highlight detached from the part. */}
        {!aiming && !manipulating && (
          <AssemblySelectionHighlight
            pickBodies={pickGeometry}
            selection={selection}
            hovered={hoveredEntity}
          />
        )}

        {/* Anchor triads are the dock-connector picker: shown only while a mate
            field is armed. Out of that mode a stale hover must draw nothing. */}
        {aiming && <AnchorGizmos gizmos={gizmos} />}
        <RollGuideGizmo spec={rollGuideSpec} />

        {triad && (
          <>
            <TriadGizmo origin={triad.origin} orientation={triad.orientation} hovered={hoveredGizmo} />
            <GizmoPickLayer origin={triad.origin} orientation={triad.orientation} enabled={!manipulating} />
          </>
        )}
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
})
