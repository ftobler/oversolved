// The assembly editor's scene. Stage 6f: three earlier stages deferred their
// render work here: 6c's assembly origin + planes, 6d's drag and triad-gizmo
// pointer surface, and 6e's edge curves. Stage 7.5 added the ID-picking driver
// and hover-gated anchor gizmos on top.
//
// This is NOT the part editor's Viewport. That one is bound to partEditorStore
// and sketchEditorStore, which stay single-part by design, so the assembly gets
// its own shell over the same scene furniture (SceneController, EnvLight,
// CubeGizmoCanvas). What the shell computes is nothing: the render list comes
// from utils/assemblyRender.ts, every gesture goes through
// utils/assemblyPointer.ts, and the anchor set under the cursor comes from
// utils/anchorGizmos.ts, all viewport-free and unit-tested.

import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, Suspense } from 'react'
import type { ReactNode } from 'react'
import { Canvas } from '@react-three/fiber'
import { Environment } from '@react-three/drei'
import * as THREE from 'three'
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib'
import { CubeGizmoCanvas } from '@/components/misc/CubeGizmo'
import '@/components/Viewport/ViewportHud.css'
import type { Hit, Pv } from '@/components/misc/CubeGizmo.utils'
import SceneController from '@/components/Viewport/SceneController'
import EnvLight, { ENV_INTENSITY } from '@/components/Viewport/EnvLight'
import { INITIAL_CAMERA } from '@/components/Viewport/cameraConstants'
import { fitToContent, shouldAutoFit } from '@/components/Viewport/cameraController'
import AnchorGizmos from '@/components/Viewport/assembly/AnchorGizmos'
import AssemblyBody from '@/components/Viewport/assembly/AssemblyBody'
import AssemblyBuiltin from '@/components/Viewport/assembly/AssemblyBuiltin'
import AssemblyPickLayers from '@/components/Viewport/assembly/AssemblyPickLayers'
import AssemblySelectionHighlight from '@/components/Viewport/assembly/AssemblySelectionHighlight'
import GizmoPickLayer from '@/components/Viewport/assembly/GizmoPickLayer'
import RollGuideGizmo, { type RollGuideSpec } from '@/components/Viewport/assembly/RollGuideGizmo'
import TriadGizmo from '@/components/Viewport/assembly/TriadGizmo'
import IdDebugOverlay from '@/components/Viewport/IdDebugOverlay'
import type { EdgeCurve } from '@/kernel/partBundle'
import IdPickingDriver from '@/picking/IdPickingDriver'
import type { IdPipeline } from '@/picking'
import {
  EDGE_LAYER_NAME, FACE_LAYER_NAME, GIZMO_HANDLE_LAYER_NAME, ORIGIN_LAYER_NAME,
  PLANE_LAYER_NAME, VERTEX_LAYER_NAME,
} from '@/picking'
import { useAssemblyStore } from '@/stores/assemblyStore'
import { lookupAnchor, resolveAnchorGizmos } from '@/utils/anchorGizmos'
import { entityKeysForMate } from '@/utils/mateHighlight'
import {
  getAssemblyBuiltinsToRender,
  getAssemblyPartGroups,
  gizmoOrientation,
  gizmoOrigin,
} from '@/utils/assemblyRender'
import { captureThumbnail } from '@/components/Viewport/captureThumbnail'
import { createAssemblyPointerAdapter, gestureAllowsSelect, missClearsSelection } from '@/utils/assemblyPointer'
import type { PointerRef } from '@/utils/assemblyGesture'
import { p2w } from '@/utils/geometry/sketchHelpers'
import { GIZMO_PIXELS, parseGizmoHandleKey } from '@/utils/gizmoPickGeometry'
import { drawnPose, isManipulable } from '@/utils/partManipulation'
import { offsetPickBodies } from '@/utils/assemblyPick'
import { readSelection } from '@/utils/assemblySelection'
import { clickTarget, decideAssemblyHit, hoverTarget } from '@/utils/assemblyHitDecision'
import { HoverScheduler } from '@/picking/HoverScheduler'
import type { Ray } from '@/utils/gizmoMath'
import { rotateVector, transformQuat, type Vec3 } from '@/utils/transform3d'
import type { Transform3D } from '@/types/cad'

// Everything an assembly can resolve from one pixel: a part's B-rep entities,
// the assembly's own frame, and the triad handle. One set for hover, click,
// aim and gizmo capture, so decideAssemblyHit is the single arbiter of what is
// on top; the gizmo is no longer kept out of the pick set and filtered by hand
// at each call site. A handle is a drag affordance, never a mate reference or a
// measurement target, and decideAssemblyHit is what enforces that now.
const ASSEMBLY_PICK_LAYERS: ReadonlySet<string> = new Set([
  FACE_LAYER_NAME, EDGE_LAYER_NAME, VERTEX_LAYER_NAME, PLANE_LAYER_NAME, ORIGIN_LAYER_NAME,
  GIZMO_HANDLE_LAYER_NAME,
])

// Stable identity: AssemblyBody memoizes its edge buffer on `curves`, so a fresh
// [] per render would rebuild every body's line geometry on every frame.
const EMPTY_CURVES: EdgeCurve[] = []

// The tree subject's part half does not read the entity selection, and the
// accessor wants the orthogonal set: a shared empty set keeps a measurement
// click from rebuilding the render groups.
const EMPTY_ENTITIES: ReadonlySet<string> = new Set()

// React and R3F pointer events both carry the two fields the gesture machine
// keys on. A ThreeEvent spreads the native pointer's own fields, so the same
// accessor reads either one.
const pointerOf = (e: { pointerId: number; button: number }): PointerRef => ({ id: e.pointerId, button: e.button })

const CANVAS_STYLE = { width: '100%', height: '100%', background: '#111' }
const CANVAS_GL = { antialias: true, logarithmicDepthBuffer: true }
// `isolation: isolate` makes this div a stacking context, penning anything drei
// portals next to the canvas inside the viewport. The assembly scene draws its
// overlays in-canvas (Text/Billboard) and mounts no `<Html>` today, so this is
// the part viewport's fix (see Viewport/index.tsx) carried over so a DOM
// overlay added here cannot escape over the app's dialogs.
const PARENT_STYLE: React.CSSProperties = { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, touchAction: 'none', isolation: 'isolate' }

// The assembly editor grabs a preview of the solved scene on save, exactly as
// the part editor does; that is the whole of what it needs from the viewport.
export interface AssemblyViewportHandle {
  captureScreenshotForSaving: () => Promise<string | null>
}

export interface AssemblyViewportProps {
  // Bottom-right overlay content, stacked under the orientation cube. Mirrors
  // the part viewport's `hud`.
  hud?: ReactNode
}

export default forwardRef<AssemblyViewportHandle, AssemblyViewportProps>(function AssemblyViewport({ hud }, ref) {
  const doc = useAssemblyStore(s => s.doc)
  const mates = useAssemblyStore(s => s.mates)
  // One subject slot instead of two independent selected fields: the part handle
  // and the mate id are read off the union, so they can never both be live.
  const subject = useAssemblyStore(s => s.subject)
  const selectedPartHandle = subject?.kind === 'part' ? subject.handle : null
  const selectedMateId = subject?.kind === 'mate' ? subject.id : null
  const bodies = useAssemblyStore(s => s.bodies)
  const edgeCurves = useAssemblyStore(s => s.edgeCurves)
  const instances = useAssemblyStore(s => s.instances)
  const transforms = useAssemblyStore(s => s.transforms)
  const manipulation = useAssemblyStore(s => s.manipulation)
  const settlingOffsets = useAssemblyStore(s => s.settlingOffsets)
  const gizmoDrag = useAssemblyStore(s => s.gizmoDrag)
  const pickGeometry = useAssemblyStore(s => s.pickGeometry)
  const pickGeometryPose = useAssemblyStore(s => s.pickGeometryPose)
  const entityMateRefs = useAssemblyStore(s => s.entityMateRefs)
  const anchors = useAssemblyStore(s => s.anchors)
  const hoverHits = useAssemblyStore(s => s.hoverHits)
  const pickScopeEntity = useAssemblyStore(s => s.pickScopeEntity)
  const pickCandidates = useAssemblyStore(s => s.pickCandidates)
  const pickIndex = useAssemblyStore(s => s.pickIndex)
  const entitySelection = useAssemblyStore(s => s.entitySelection)
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
  // move the part and the camera. Derived from the store's manipulation session
  // rather than mirrored into React state, so the orbit lock, the render gates
  // and the pick layer follow the one owner an open, commit or cancel writes.
  const manipulating = manipulation !== null
  // Which triad handle the cursor is over, so it can light up. Viewport-local:
  // it is a drag affordance's highlight, not part of the document selection.
  const [hoveredGizmo, setHoveredGizmo] = useState<string | null>(null)

  const adapter = useMemo(() => createAssemblyPointerAdapter({
    beginPartManipulation: (h) => useAssemblyStore.getState().beginPartManipulation(h),
    beginBodyDrag: (h, grab) => useAssemblyStore.getState().beginBodyDrag(h, grab),
    setDragTarget: (t) => useAssemblyStore.getState().setDragTarget(t),
    dragPartTranslate: (d) => useAssemblyStore.getState().dragPartTranslate(d),
    rotatePartGizmo: (a, angle, pivot) => useAssemblyStore.getState().rotatePartGizmo(a, angle, pivot),
    endPartManipulation: () => useAssemblyStore.getState().endPartManipulation(),
    cancelPartManipulation: () => useAssemblyStore.getState().cancelPartManipulation(),
    selectPart: (h) => useAssemblyStore.getState().selectPart(h),
    setGizmoDrag: (d) => useAssemblyStore.getState().setGizmoDrag(d),
  }), [])

  // Same readiness story as Viewport: a fit can be armed (first geometry
  // arriving) while the scene tree has not rendered yet, so the camera is
  // still absent and the only other retry (a bodies change) has already
  // fired. The two sources stay separate: onCreated fires before the scene
  // tree in R3F, so the camera arrival is usually the later event and must
  // not be swallowed by a shared one-shot. onSceneReady needs no latch of
  // its own -- it is called from scene-tree effects (never mid-render) and
  // is one-shot per instance inside SceneController.
  const [sceneTick, setSceneTick] = useState(0)
  const onSceneReady = useCallback(() => setSceneTick(t => t + 1), [])

  const createdLiveRef = useRef(false)
  const onCreated = useCallback((state: { gl: THREE.WebGLRenderer; scene: THREE.Scene }) => {
    glRef.current = state.gl
    sceneRef.current = state.scene
    // Latched: a caller may invoke onCreated while rendering, and re-entering
    // setState from there would loop renders.
    if (createdLiveRef.current) return
    createdLiveRef.current = true
    setSceneTick(t => t + 1)
  }, [])

  useImperativeHandle(ref, () => ({
    captureScreenshotForSaving: () => captureThumbnail(glRef.current, sceneRef.current, cameraRef.current),
  }), [])

  // The subject's part half as a set, which is what the render groups take so a
  // future multi-part subject widens in the one accessor rather than here. It
  // reads only `subject`, so a measurement click in the viewport (which churns
  // `entitySelection`) does not rebuild every part group.
  const selectedParts = useMemo(
    () => readSelection(subject, EMPTY_ENTITIES).parts,
    [subject],
  )
  const groups = useMemo(
    () => getAssemblyPartGroups(bodies, instances, manipulation, selectedParts, settlingOffsets),
    [bodies, instances, manipulation, selectedParts, settlingOffsets],
  )
  // The drawn pose of every handle, the same offset the render groups carry.
  const drawnPoses = useMemo(() => {
    const out: Record<string, Transform3D> = {}
    for (const handle of new Set([...Object.keys(transforms), ...Object.keys(settlingOffsets)])) {
      out[handle] = drawnPose(handle, manipulation, transforms, settlingOffsets)
    }
    return out
  }, [transforms, manipulation, settlingOffsets])
  // The ID buffer follows the drawn pose, so a click in the settle window lands
  // on the entity the user sees rather than the one the old solve baked.
  const drawnPickGeometry = useMemo(
    () => offsetPickBodies(pickGeometry, pickGeometryPose, drawnPoses),
    [pickGeometry, pickGeometryPose, drawnPoses],
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
  // Selecting a mate in the tree highlights the geometry its refs resolve to,
  // in the same colour a hover would use. Deps are the whole values, not
  // sub-fields like `selectedMate?.ref_a.part`: `mates` is itself memoized on
  // `doc` (useAssemblyDoc.ts), so `selectedMate`'s identity is already stable
  // across renders that do not mutate the document, and this Set must stay
  // referentially stable too -- it feeds AssemblySelectionHighlight's own
  // useMemo, and a fresh Set every render would rebuild the highlight's
  // Float32Arrays and dispose/recreate every THREE.BufferGeometry each frame.
  const mateHighlighted = useMemo(
    () => entityKeysForMate(selectedMate, entityMateRefs),
    [selectedMate, entityMateRefs],
  )
  const rollGuideSpec = useMemo((): RollGuideSpec | null => {
    if (!rollGuideAnchor) return null
    return { point: [...rollGuideAnchor.point] as Vec3, axis: [...rollGuideAnchor.axis] as Vec3, angleDeg: rollGuideAngleDeg }
  }, [rollGuideAnchor, rollGuideAngleDeg])

  const onPipelineReady = useCallback((p: IdPipeline) => { pipelineRef.current = p }, [])
  // A `fixed` part is the assembly's static frame: it selects, but it gets no
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

  // Frame the assembly once, when its first geometry lands. `fittedRef` doubles
  // as the abandon latch: see shouldAutoFit for why a grab has to retire a fit
  // that never got its chance rather than merely postpone it.
  const fittedRef = useRef(false)
  useEffect(() => {
    if (manipulating) fittedRef.current = true
  }, [manipulating])
  useEffect(() => {
    if (!shouldAutoFit(fittedRef.current, Object.keys(bodies).length, manipulating)) return
    const camera = cameraRef.current as THREE.OrthographicCamera | null
    if (!camera) return
    if (fitToContent(camera, controlsRef.current, bodies, sceneRef.current)) fittedRef.current = true
  }, [bodies, manipulating, sceneTick])

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
  //
  // Division of labour with the R3F raycast: a grab is geometric, so AssemblyBody's
  // raycast against the drawn mesh is the grab authority. The ID buffer is the
  // entity-reference authority for mate picks and B-rep selection. Both read the
  // drawn pose now, so neither can answer "what is under this pixel" with a
  // layout the other does not have.
  const cursorFromPointer = useCallback((e: { clientX: number; clientY: number }) => {
    const gl = glRef.current
    if (!gl) return null
    const canvas = gl.domElement
    const rect = canvas.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return null
    return {
      x: (e.clientX - rect.left) * (canvas.width / rect.width),
      y: (e.clientY - rect.top) * (canvas.height / rect.height),
    }
  }, [])

  const resolveHitsAtCursor = useCallback((
    cursor: { x: number; y: number },
    layers: ReadonlySet<string> = ASSEMBLY_PICK_LAYERS,
  ) => {
    const gl = glRef.current
    const pipeline = pipelineRef.current
    if (!gl || !pipeline) return []
    return pipeline.resolveAllSync(gl, cursor, { allowedLayers: layers })
  }, [])

  const resolveHitsAt = useCallback((
    e: { clientX: number; clientY: number },
    layers: ReadonlySet<string> = ASSEMBLY_PICK_LAYERS,
  ) => {
    const cursor = cursorFromPointer(e)
    return cursor ? resolveHitsAtCursor(cursor, layers) : []
  }, [cursorFromPointer, resolveHitsAtCursor])

  // Ctrl as of the latest move. The scheduler's onHits receives only the hits,
  // and the scope rides the hover, so the modifier is carried across the (short)
  // gap between schedule and resolve in a ref.
  const hoverCtrlRef = useRef(false)

  // One GPU readback per frame at most, and the one cancellation owner for the
  // hover. The scheduler caps resolves and drops any readback a clear overtook.
  // eslint-disable-next-line react-hooks/refs -- onHits reads hoverCtrlRef when a hit lands, never during render
  const hoverScheduler = useMemo(() => new HoverScheduler({
    // resolveAllSync is a blocking GPU readback, so defer even the first move of
    // a frame into the frame: the assembly does at most one readback per frame,
    // as it did before the scheduler was shared.
    leading: false,
    resolve: (q) => resolveHitsAtCursor(q.cursor, q.allowed),
    onHits: (hits) => {
      const store = useAssemblyStore.getState()
      const decision = decideAssemblyHit(hits)
      setHoveredGizmo(decision.gizmoHandle)
      // Aiming reveals the hovered entity's anchor triads; the plain selector
      // just highlights the single top entity a click would toggle. Read the
      // mode from the store, not a captured prop, so a mid-hover mode switch is
      // never one frame stale.
      if (store.activeMateField !== null) {
        // The anchor resolver only knows B-rep entity keys, so the handle is
        // stripped from what it sees: a triad is a drag affordance, not a dock
        // connector, and it must not appear in the hover set.
        const entityHits = decision.gizmoHandle === null
          ? hits
          : hits.filter(h => h.layer !== GIZMO_HANDLE_LAYER_NAME)
        store.setHoverHits(entityHits, hoverCtrlRef.current)
      } else {
        // A gizmo handle under the cursor occludes the entity behind it exactly
        // as it does for a click, so hoverTarget is null there and the entity is
        // not advertised as selectable.
        store.setHoveredEntity(hoverTarget(decision))
      }
    },
  }), [resolveHitsAtCursor])

  // Dropping the hover means dropping the frame that would restore it. A move
  // from a fraction of a frame ago is still queued when the user grabs the part
  // or leaves the pane, and letting it land would re-draw the anchors the clear
  // was for, with nothing left to clear them again.
  const clearHover = useCallback(() => {
    hoverScheduler.clear()
    setHoveredGizmo(null)
    const store = useAssemblyStore.getState()
    store.clearHover()  // the aiming-mode anchor hover
    store.setHoveredEntity(null)  // the selection-mode B-rep hover
  }, [hoverScheduler])

  const scheduleHover = useCallback((e: React.PointerEvent) => {
    // A held button means an orbit is in progress. Every frame of it would
    // re-render the ID buffer and read it back, to answer a question the user is
    // not asking while swinging the camera around.
    if (e.buttons !== 0) {
      clearHover()
      return
    }
    const cursor = cursorFromPointer(e)
    if (!cursor) {
      clearHover()
      return
    }
    hoverCtrlRef.current = e.ctrlKey
    hoverScheduler.schedule({ cursor, allowed: ASSEMBLY_PICK_LAYERS })
  }, [clearHover, cursorFromPointer, hoverScheduler])

  // Unmounting mid-hover leaves the store's anchor/highlight fields behind:
  // they are module-level and only pointer events clear them, so a remount
  // would redraw a pick nothing is under until one does. clearHover also
  // cancels any readback still queued for the frame that never ran.
  useEffect(() => () => { clearHover() }, [clearHover])

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

  const handleGrabBody = useCallback((handle: string, point: Vec3, pointer: PointerRef) => {
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
    if (adapter.onBodyPointerDown(handle, point, [forward.x, forward.y, forward.z], pointer)) {
      // The ID buffer keeps the solved pose while the drag offsets the drawn
      // part, so anchors held over from before the grab would trail behind it.
      clearHover()
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
    const handle = parseGizmoHandleKey(decideAssemblyHit(resolveHitsAt(e)).gizmoHandle)
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
      selectedPartHandle, handle.kind, handle.name, axis, reference, triad.origin, ray, pointerOf(e),
    )) {
      clearHover()  // the gizmo moves the part too; same stale-anchor trail
    }
  }, [adapter, clearHover, rayFromEvent, resolveHitsAt, selectedPartHandle, triad])

  // R3F's mesh handlers run on the canvas, whose events bubble here. Capturing
  // the pointer once a gesture has started keeps a drag alive when the cursor
  // grazes the pane edge, and guarantees the release reaches us wherever it
  // lands, otherwise a session would hang with the camera locked.
  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    // Record before the active-gesture early-out: the mesh handler has already
    // opened the grab by the time this bubbles up, so an early return here would
    // lose the down position a plain select needs.
    adapter.pointerDown(pointerOf(e), e.clientX, e.clientY)
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
      const hits = resolveHitsAt(e)
      // A gizmo handle on top makes the pixel a drag affordance, never a mate
      // reference, so it cannot aim either. The handle is also stripped from the
      // list handed on, so the one decision is the only gizmo gate the picker
      // relies on.
      if (decideAssemblyHit(hits).gizmoHandle === null) {
        useAssemblyStore.getState().pickFromHitsOrCycle(
          hits.filter(h => h.layer !== GIZMO_HANDLE_LAYER_NAME),
        )
      }
    }
  }, [adapter, aiming, resolveHitsAt])

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    // Latch the travel as it happens: an orbit that swings out and comes back
    // would read as a stationary click if only the two end points were compared.
    adapter.pointerMove(e.clientX, e.clientY)
    if (!adapter.isActive()) {
      scheduleHover(e)
      return
    }
    const ray = rayFromEvent(e)
    if (!ray) return
    // The very scale TriadGizmo's useScreenScale(GIZMO_PIXELS) applies, read
    // fresh each move: the ring drag gates its snapping on the cursor being
    // inside the DRAWN circle, and the camera may dolly mid-drag. Reading it
    // here rather than caching it is what keeps the gate and the ring the user
    // is aiming at the same circle. GizmoPickLayer quantizes the same product,
    // but only because re-registering the ID buffer is expensive; this is free.
    const camera = cameraRef.current
    adapter.onPointerMove(ray, camera ? GIZMO_PIXELS * p2w(camera) : undefined)
  }, [adapter, rayFromEvent, scheduleHover])

  // The cursor left the pane, so nothing is under it. Gizmos drawn from the last
  // hover would sit there advertising a pick the pointer can no longer make.
  const handlePointerLeave = useCallback(() => { clearHover() }, [clearHover])

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    // A release that does not own the gesture (another button, another pointer)
    // ends nothing: it must not commit a pose the user is still holding. On the
    // owned release the machine also closes the click tracker, and the click
    // event that decides whether to deselect arrives later and reads its verdict.
    const outcome = adapter.onPointerUp(pointerOf(e), e.clientX, e.clientY)
    if (!outcome.owned) return
    // Selection mode: a left click that never became a drag toggles the top
    // entity under the cursor into the measurement set. Which gestures are still
    // a click is gestureAllowsSelect's call, not this handler's: a triad handle
    // click and a drag that moved the part both end here and neither selects.
    // Aiming and Ctrl clicks are the mate picker's, handled on pointer-down, so
    // they never fall through here.
    if (!gestureAllowsSelect(outcome)) return
    const store = useAssemblyStore.getState()
    if (store.activeMateField !== null || e.button !== 0 || e.ctrlKey) return
    const click = adapter.clickState
    if (click.button !== 0 || click.wasDrag) return
    const target = clickTarget(decideAssemblyHit(resolveHitsAt(e)))
    if (target !== null) store.toggleSelection(target)
  }, [adapter, resolveHitsAt])

  // The browser tore the gesture away (a touch became a scroll, the pointer was
  // lost). Abandon it rather than commit a pose the user never released on.
  // The pending click verdict goes with it: a stale origin left open here would
  // pair with the NEXT release (or feed onPointerMissed a verdict from a
  // gesture the browser cancelled). The machine's pointerCancel routes through
  // the one cancel transition and only for the opener, so a secondary pointer
  // going away cannot abandon the primary's gesture.
  const handlePointerCancel = useCallback((e: React.PointerEvent) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    adapter.pointerCancel(pointerOf(e))
  }, [adapter])

  // Unmounting mid-drag means the pointerup never arrives, and both the session
  // and the published gizmoDrag live outside React (a closure and a module-level
  // store), so they would survive into the next mount: the triad would come back
  // narrowed to a handle nobody is holding, with GizmoPickLayer still registering
  // all nine, leaving eight invisible handles that still take clicks.
  useEffect(() => () => { adapter.cancel() }, [adapter])

  // Escape abandons the gesture: the part snaps back to its solved pose and no
  // re-solve runs, the standard out for a drag started by mistake.
  useEffect(() => {
    if (!manipulating) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      adapter.cancel()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [adapter, manipulating])

  const onPointerMissed = useCallback(() => {
    // R3F counts `contextmenu` as a click event, and Chrome on Linux fires it on
    // the pointer-DOWN that starts a right-button orbit -- so this handler runs
    // at the very start of every camera rotation, with a travel distance of zero
    // that R3F's own delta guard cannot reject. Deferring to the gesture (which
    // knows the orbit opened on the right button) is what keeps the camera from
    // wiping the selection.
    if (!missClearsSelection(adapter.clickState, adapter.isActive())) return
    const store = useAssemblyStore.getState()
    // A miss deselects the one subject (part or mate), and disarms an armed
    // field just as the old two-field clear did.
    store.selectPart(null)
    store.setActiveMateField(null)
    // An empty-space click clears the B-rep entity selection too, the same "click
    // off to deselect" the part editor gives. Not while aiming: the mate picker
    // owns the click there and a miss simply aims at nothing.
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
          gizmoCanvasRef={canvasRef}
          pvRef={pvRef}
          hoverRef={hoverRef}
          snapRef={snapRef}
          cameraRef={cameraRef}
          controlsRef={controlsRef}
          orbitEnabled={!manipulating}
          onReady={onSceneReady}
        />

        <IdPickingDriver onReady={onPipelineReady} />
        <AssemblyPickLayers bodies={drawnPickGeometry} />
        {showPickDebug && <IdDebugOverlay />}

        <Suspense fallback={null}>
          <Environment files="/env.hdr" background={false} environmentIntensity={ENV_INTENSITY} />
        </Suspense>
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
                onGrab={(point, event) => handleGrabBody(g.handle, point, pointerOf(event))}
              />
            ))}
          </group>
        ))}

        {/* B-rep selection highlight, only in the plain selector mode: the
            aiming mode shows anchor triads over the same geometry instead. It is
            hidden mid-drag, where the raycast owns the gesture. The pick bodies
            are the drawn ones, so the highlight follows the parts through a
            settle rather than hanging at the old solved pose. */}
        {!aiming && !manipulating && (
          <AssemblySelectionHighlight
            pickBodies={drawnPickGeometry}
            selection={entitySelection}
            hovered={hoveredEntity}
            mateHighlighted={mateHighlighted}
          />
        )}

        {/* Anchor triads are the dock-connector picker: shown only while a mate
            field is armed. Out of that mode a stale hover must draw nothing. */}
        {aiming && <AnchorGizmos gizmos={gizmos} />}
        <RollGuideGizmo spec={rollGuideSpec} />

        {triad && (
          <>
            <TriadGizmo origin={triad.origin} orientation={triad.orientation} hovered={hoveredGizmo} drag={gizmoDrag} />
            <GizmoPickLayer origin={triad.origin} orientation={triad.orientation} enabled={!manipulating} />
          </>
        )}
      </Canvas>

      <div className="viewport-hud">
        <CubeGizmoCanvas
          canvasRef={canvasRef}
          pvRef={pvRef}
          hoverRef={hoverRef}
          snapRef={snapRef}
          cameraRef={cameraRef}
        />
        <div className="viewport-hud-readout">{hud}</div>
      </div>
    </div>
  )
})
