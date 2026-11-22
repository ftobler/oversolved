import { useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { useFrame, useThree } from '@react-three/fiber'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { useSectionStore } from '@/stores/sectionStore'
import { useFeatureHandleIdRegistration } from '@/picking'
import { registerFeatureHandleCallbacks } from '@/components/Viewport/idDispatch/featureHandleCallbacks'
import {
  SECTION_HANDLE_FEATURE_ID, SECTION_HANDLE_FIELD, SECTION_HANDLE_KEY,
  SECTION_PITCH_RING_KEY, SECTION_YAW_RING_KEY,
} from '@/viewport/sectionHandle'
import { shouldActivateDrag } from '@/utils/geometry/dragLogic'
import { handleColor } from '@/components/Geometry3D/featureHandleMath'
import { p2w } from '@/components/Geometry3D/sketchSceneHelpers'
import {
  applySectionTiltSwing, offsetFramePoint, sectionOffsetFromTiltedDrag, sectionOutlineBounds,
  sectionOutlineRect, tiltedSectionFrame,
} from '@/viewport/sectionPlane'
import type { SectionTilt } from '@/viewport/sectionTypes'
import { useSectionClip } from '@/viewport/useSection'
import ScreenArrow, { TIP } from '@/components/Viewport/ScreenArrow'
import GizmoRing from '@/components/Viewport/GizmoRing'
import SectionOutline from '@/components/Viewport/SectionOutline'
import AngleDial from '@/components/Viewport/assembly/AngleDial'
import { useAxisDrag } from '@/components/Viewport/useAxisDrag'
import { beginRingDrag, moveRingDrag, type RingDragState } from '@/utils/ringDrag'
import { GIZMO_PIXELS, RING_RADIUS, type GizmoRingAxis } from '@/utils/gizmoPickGeometry'
import { TRIAD_COLOR, TRIAD_COLOR_HOVER } from '@/utils/core/gizmoColors'
import { cross } from '@/utils/vec3'
import type { Vec3 } from '@/utils/transform3d'

// The section's manipulation gizmo: an offset arrow along the tilted normal
// plus two tilt rings drawn with the triad's recipe.
//
// Everything rides the existing featureHandle pick layer under its own key,
// exactly like an edit handle: the dispatcher routes each grab to the matching
// callback, and hover lights it through hoveredSelectionId, so there is one
// pick path per editor. Rings are registered as closed chains of segments; a
// ring is one grab target, not one per sampled segment.
//
// Tilt is viewer state: nothing here dispatches a Mutation or asks for a solve.

// The faint plane outline is world-sized: it marks a geometric plane, so it
// grows and shrinks with the model rather than with the camera. The rectangle
// is fitted to the model's bounds; this is the square kept when there is no
// geometry to measure, so the section still shows where its plane is.
const OUTLINE_SIZE = 120
const OUTLINE_COLOR = '#7fa6c9'

// The rings are drawn in their own local frame (local Z is the ring axis,
// local X the bearing zero) and scaled to the triad's on-screen size, so the
// dial's tick radii and the ring radius agree.
const LOCAL_RING: GizmoRingAxis = { axis: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] }
const RING_SEGMENTS = 64

interface PendingOffsetDrag {
  startClient: [number, number]
  startOffset: number
  // The tilt the arrow was pressed with: it cannot change during an offset
  // drag, and the conversion must use the pose the user sees.
  tilt: SectionTilt
  axisPoint: [number, number, number]
  axisDir: [number, number, number]
}

interface PendingRingDrag {
  key: string
  axis: 'pitch' | 'yaw'
  startClient: [number, number]
  startTilt: SectionTilt
  drag: RingDragState
}

interface RingDragView {
  key: string
  datum: number
  swing: number
  snapped: boolean
  snapArmed: boolean
}

interface RingView {
  key: string
  // Local-to-world pose of the ring plane: local Z is its rotation axis.
  quaternion: THREE.Quaternion
  // World pick chain, closed (the first point repeats at the end).
  points: Vec3[]
}

function ringView(key: string, center: Vec3, axis: Vec3, reference: Vec3, radius: number): RingView {
  // `v` is derived from the axis so the basis is right-handed whatever the
  // reference's own roll.
  const u = new THREE.Vector3(...reference).normalize()
  const v = new THREE.Vector3(...cross(axis, reference)).normalize()
  const z = new THREE.Vector3(...axis).normalize()
  const quaternion = new THREE.Quaternion().setFromRotationMatrix(
    new THREE.Matrix4().makeBasis(u, v, z),
  )
  const points: Vec3[] = []
  for (let i = 0; i <= RING_SEGMENTS; i++) {
    const angle = (i / RING_SEGMENTS) * Math.PI * 2
    const point = new THREE.Vector3(Math.cos(angle) * radius, Math.sin(angle) * radius, 0)
      .applyQuaternion(quaternion)
      .add(new THREE.Vector3(...center))
    points.push([point.x, point.y, point.z])
  }
  return { key, quaternion, points }
}

function buildOutlineGeometry(halfU: number, halfV: number): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
    -halfU, -halfV, 0,
     halfU, -halfV, 0,
     halfU,  halfV, 0,
    -halfU,  halfV, 0,
  ]), 3))
  return geometry
}

/** The arrow, the plane outline and the two tilt rings of the live section. */
export default function SectionPlaneHandle() {
  const { camera } = useThree()
  const { active, frame, offset, tilt } = useSectionClip()
  const parts = usePartEditorStore(s => s.parts)
  const features = usePartEditorStore(s => s.features)
  const visibleParts = usePartEditorStore(s => s.visibleParts)
  const visibleFeatures = usePartEditorStore(s => s.visibleFeatures)
  const capturing = useSectionStore(s => s.capturing)
  const hoveredKey = useSketchEditorStore(s => s.hoveredSelectionId)
  const { pxToWorld, rayFrom, cursorAxisParam, trackZoom } = useAxisDrag()

  const [dragging, setDragging] = useState(false)
  const [ringDrag, setRingDrag] = useState<RingDragView | null>(null)
  const draggingRef = useRef(false)
  const pendingRef = useRef<PendingOffsetDrag | null>(null)
  const ringPendingRef = useRef<PendingRingDrag | null>(null)
  const startParamRef = useRef<number | null>(null)
  const headRef = useRef<THREE.Group>(null)
  const pitchRingRef = useRef<THREE.Group>(null)
  const yawRingRef = useRef<THREE.Group>(null)

  // The model's extent is a fact about the bodies, not about the plane, so it
  // is measured once per body change. An offset drag or a tilt only re-projects
  // these eight corners and never walks a vertex list.
  const modelBounds = useMemo(
    () => sectionOutlineBounds({ parts, features, visibleParts, visibleFeatures }),
    [parts, features, visibleParts, visibleFeatures],
  )

  // The tilted pose: the plane normal and the two axes the rings turn about.
  const tilted = useMemo(() => (frame ? tiltedSectionFrame(frame, tilt) : null), [frame, tilt])

  // The gizmo centre: the offset along the SOURCE normal. The tilt pivots about
  // this point, so it stays on the plane through the whole drag.
  const planePoint = useMemo(
    () => (frame ? offsetFramePoint(frame, offset) : null),
    [frame, offset],
  )

  // The fitted rectangle, in the tilted plane's own axes so the fit and the
  // drawing cannot disagree. No bounds keeps the default square on the anchor.
  const outlineRect = useMemo(
    () => (planePoint && tilted ? sectionOutlineRect(modelBounds, planePoint, tilted.u, tilted.v) : null),
    [modelBounds, planePoint, tilted],
  )

  // A re-solve that lands on the same bounds must not rebuild the buffer, so
  // the memo keys on the rounded extents rather than on the float values.
  const halfU = Math.round((outlineRect?.halfU ?? OUTLINE_SIZE / 2) * 1000) / 1000
  const halfV = Math.round((outlineRect?.halfV ?? OUTLINE_SIZE / 2) * 1000) / 1000
  const outlineGeometry = useMemo(() => buildOutlineGeometry(halfU, halfV), [halfU, halfV])
  useEffect(() => () => { outlineGeometry.dispose() }, [outlineGeometry])

  const outlineQuaternion = useMemo(() => {
    if (!tilted) return new THREE.Quaternion()
    // The fitted rectangle is measured in `u`/`v`, so the drawn one takes the
    // same basis: local X is `u`, local Y is `v`, local Z the normal.
    return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(
      new THREE.Vector3(...tilted.u),
      new THREE.Vector3(...tilted.v),
      new THREE.Vector3(...tilted.normal),
    ))
  }, [tilted])
  const arrowQuaternion = useMemo(() => {
    if (!tilted) return new THREE.Quaternion()
    return new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(...tilted.normal),
    )
  }, [tilted])

  const tipPoint = useMemo<[number, number, number] | null>(() => {
    if (!tilted || !planePoint) return null
    const [nx, ny, nz] = tilted.normal
    const tip = TIP * pxToWorld
    return [planePoint[0] + nx * tip, planePoint[1] + ny * tip, planePoint[2] + nz * tip]
  }, [tilted, planePoint, pxToWorld])

  // The pitch ring turns about the source u; the yaw ring about the pitched v.
  // Their bearing zeros are fixed source directions, so the dial does not spin
  // under the drag it is measuring.
  const ringViews = useMemo(() => {
    if (!frame || !tilted || !planePoint) return null
    const radius = RING_RADIUS * GIZMO_PIXELS * pxToWorld
    return {
      pitch: ringView(SECTION_PITCH_RING_KEY, planePoint, frame.u, frame.normal, radius),
      yaw: ringView(SECTION_YAW_RING_KEY, planePoint, tilted.yawAxis, frame.u, radius),
    }
  }, [frame, tilted, planePoint, pxToWorld])

  const arrowActive = active && !capturing && planePoint !== null && tipPoint !== null
  const ringsActive = arrowActive && !dragging && ringDrag === null && ringViews !== null

  useFeatureHandleIdRegistration({
    featureId: SECTION_HANDLE_FEATURE_ID,
    field: SECTION_HANDLE_FIELD,
    start: planePoint ?? [0, 0, 0],
    end: tipPoint ?? [0, 0, 0],
    enabled: arrowActive && !dragging && ringDrag === null,
  })
  useFeatureHandleIdRegistration({
    key: SECTION_PITCH_RING_KEY,
    points: ringViews?.pitch.points,
    enabled: ringsActive,
  })
  useFeatureHandleIdRegistration({
    key: SECTION_YAW_RING_KEY,
    points: ringViews?.yaw.points,
    enabled: ringsActive,
  })

  // The two rings' presses. Each records a pending drag; the move listener
  // activates past the click threshold, so a click on a ring does not nudge the
  // plane, exactly like a click on the arrow.
  useEffect(() => {
    if (!active || !frame || !tilted || !planePoint || capturing) return
    const center = planePoint
    const startRing = (
      key: string,
      axis: 'pitch' | 'yaw',
      ringAxis: Vec3,
      reference: Vec3,
    ) => (clientX: number, clientY: number) => {
      const ray = rayFrom(clientX, clientY)
      if (!ray) return
      const drag = beginRingDrag(ray, center, ringAxis, reference)
      if (!drag) return
      // The camera yields through the press claim (viewport/pointerClaim), not
      // through this store flag: the dispatcher claims the pointer on the
      // featureHandle layer.
      useSketchEditorStore.getState().setIsPointerDown(true)
      pendingRef.current = null
      ringPendingRef.current = {
        key,
        axis,
        startClient: [clientX, clientY],
        startTilt: useSectionStore.getState().tilt,
        drag,
      }
      setRingDrag({ key, datum: drag.datum, swing: 0, snapped: true, snapArmed: true })
    }
    const unregisterPitch = registerFeatureHandleCallbacks(SECTION_PITCH_RING_KEY, {
      onPointerDown: startRing(SECTION_PITCH_RING_KEY, 'pitch', frame.u, frame.normal),
      onDoubleClick: () => {},
    })
    const unregisterYaw = registerFeatureHandleCallbacks(SECTION_YAW_RING_KEY, {
      onPointerDown: startRing(SECTION_YAW_RING_KEY, 'yaw', tilted.yawAxis, frame.u),
      onDoubleClick: () => {},
    })
    return () => {
      unregisterPitch()
      unregisterYaw()
    }
  }, [active, frame, tilted, planePoint, capturing, rayFrom])

  // Grab: the dispatcher has already resolved the arrow's pixels in the ID
  // buffer. This records a pending drag; the move listener activates past the
  // click threshold so a click on the arrow does not nudge the plane.
  useEffect(() => {
    if (!active || !frame || !tilted || capturing) return
    return registerFeatureHandleCallbacks(SECTION_HANDLE_KEY, {
      onPointerDown: (clientX, clientY) => {
        // The camera yields through the press claim (viewport/pointerClaim),
        // not through this store flag: the dispatcher claims the pointer on the
        // featureHandle layer. Do not "fix" the orbit gate by pushing a fake
        // dragPending here, that would break the click rule.
        const st = useSketchEditorStore.getState()
        st.setIsPointerDown(true)
        const state = useSectionStore.getState()
        ringPendingRef.current = null
        pendingRef.current = {
          startClient: [clientX, clientY],
          startOffset: state.offset,
          tilt: state.tilt,
          axisPoint: offsetFramePoint(frame, state.offset),
          // The arrow is drawn along the direction the cut actually moves.
          axisDir: tilted.normal,
        }
      },
      onDoubleClick: () => {},
    })
  }, [active, frame, tilted, capturing])

  const moveImpl = (e: PointerEvent) => {
    const ring = ringPendingRef.current
    if (ring) {
      if (!draggingRef.current) {
        if (!shouldActivateDrag(ring.startClient, [e.clientX, e.clientY])) return
        draggingRef.current = true
        setDragging(true)
      }
      const ray = rayFrom(e.clientX, e.clientY)
      if (!ray) return
      // The gate is the drawn ring's own radius, so the pick chain above and
      // the snap boundary are the same circle.
      const moved = moveRingDrag(ring.drag, ray, GIZMO_PIXELS * pxToWorld)
      if (!moved) return
      const applied = applySectionTiltSwing(ring.startTilt, ring.axis, moved.swing)
      // Viewer state only: no Mutation, no solve request. Undo re-solves nothing
      // because there is nothing here for it to undo.
      useSectionStore.getState().setTilt(applied.tilt)
      setRingDrag({
        key: ring.key,
        datum: moved.datum,
        // The clamped part of the drag is what the plane received, so the dial
        // readout holds at the 85 degree limit instead of running past it. A
        // held reading is no longer on a tick, so it must not light one.
        swing: applied.swing,
        snapped: moved.snapped && Math.abs(applied.swing - moved.swing) < 1e-9,
        snapArmed: moved.snapArmed,
      })
      return
    }

    const pending = pendingRef.current
    if (!pending) return
    if (!draggingRef.current) {
      if (!shouldActivateDrag(pending.startClient, [e.clientX, e.clientY])) return
      const startParam = cursorAxisParam(e, pending.axisPoint, pending.axisDir)
      if (startParam === null) return
      startParamRef.current = startParam
      draggingRef.current = true
      setDragging(true)
    }
    if (!frame) return
    const param = cursorAxisParam(e, pending.axisPoint, pending.axisDir)
    if (param === null || startParamRef.current === null) return
    // Travel is measured along the tilted normal, while the offset still counts
    // along the source normal, so the two are converted at the current pose.
    useSectionStore.getState().setOffset(sectionOffsetFromTiltedDrag(
      pending.startOffset,
      param - startParamRef.current,
      frame,
      pending.tilt,
    ))
  }
  const moveRef = useRef(moveImpl)
  useEffect(() => { moveRef.current = moveImpl })

  const finish = () => {
    pendingRef.current = null
    ringPendingRef.current = null
    startParamRef.current = null
    setRingDrag(null)
    if (draggingRef.current) {
      draggingRef.current = false
      setDragging(false)
    }
    useSketchEditorStore.getState().setIsPointerDown(false)
  }

  const upImpl = () => {
    if (!pendingRef.current && !ringPendingRef.current) return
    finish()
  }
  const upRef = useRef(upImpl)
  useEffect(() => { upRef.current = upImpl })

  // Escape and pointercancel abandon the drag: a ring put back where the press
  // found it, so an interrupted turn does not stick.
  const cancelImpl = () => {
    const ring = ringPendingRef.current
    if (ring) useSectionStore.getState().setTilt(ring.startTilt)
    if (!pendingRef.current && !ring) return
    finish()
  }
  const cancelRef = useRef(cancelImpl)
  useEffect(() => { cancelRef.current = cancelImpl })

  useEffect(() => {
    const onMove = (e: PointerEvent) => moveRef.current(e)
    const onUp = () => upRef.current()
    const onCancel = () => cancelRef.current()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cancelRef.current()
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      window.removeEventListener('keydown', onKey)
    }
  }, [])

  // A component unmounted mid-drag must not leave the camera orbit locked.
  useEffect(() => () => {
    if (pendingRef.current || ringPendingRef.current) useSketchEditorStore.getState().setIsPointerDown(false)
    pendingRef.current = null
    ringPendingRef.current = null
  }, [])

  useFrame(() => {
    if (!active) return
    const scale = p2w(camera)
    headRef.current?.scale.setScalar(scale)
    // The rings keep the triad's on-screen size; their local radii are already
    // in gizmo units, so the group scale is one gizmo's worth of pixels.
    pitchRingRef.current?.scale.setScalar(scale * GIZMO_PIXELS)
    yawRingRef.current?.scale.setScalar(scale * GIZMO_PIXELS)
    trackZoom(scale)
  })

  if (!active || !frame || !tilted || !planePoint || capturing || !ringViews) return null

  const color = handleColor(hoveredKey === SECTION_HANDLE_KEY, dragging)
  const ringColor = (key: string) =>
    (hoveredKey === key || ringDrag?.key === key ? TRIAD_COLOR_HOVER : TRIAD_COLOR)

  return (
    <group>
      <SectionOutline
        geometry={outlineGeometry}
        center={outlineRect?.center ?? planePoint}
        quaternion={outlineQuaternion}
        color={OUTLINE_COLOR}
      />
      <group position={planePoint} quaternion={arrowQuaternion}>
        <ScreenArrow color={color} headRef={headRef} pixelsPerWorld={pxToWorld} />
      </group>

      <group ref={pitchRingRef} position={planePoint} quaternion={ringViews.pitch.quaternion}>
        <GizmoRing basis={LOCAL_RING} color={ringColor(SECTION_PITCH_RING_KEY)} />
        {ringDrag?.key === SECTION_PITCH_RING_KEY && (
          <SectionAngleDial drag={ringDrag} />
        )}
      </group>

      <group ref={yawRingRef} position={planePoint} quaternion={ringViews.yaw.quaternion}>
        <GizmoRing basis={LOCAL_RING} color={ringColor(SECTION_YAW_RING_KEY)} />
        {ringDrag?.key === SECTION_YAW_RING_KEY && (
          <SectionAngleDial drag={ringDrag} />
        )}
      </group>
    </group>
  )
}

/**
 * The dial while a ring is held. No counter-rotation: the ring's own group is a
 * fixed protractor frame here, unlike the triad's group, which carries the
 * part's live pose and has to be undone.
 */
function SectionAngleDial({ drag }: { drag: RingDragView }) {
  return (
    <AngleDial
      def={LOCAL_RING}
      datum={drag.datum}
      swing={drag.swing}
      snapped={drag.snapped}
      snapArmed={drag.snapArmed}
      counterRotate={false}
    />
  )
}
