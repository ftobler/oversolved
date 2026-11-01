import { useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { useFrame, useThree } from '@react-three/fiber'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { useSectionStore } from '@/stores/sectionStore'
import { useFeatureHandleIdRegistration } from '@/picking'
import { registerFeatureHandleCallbacks } from '@/components/Viewport/idDispatch/featureHandleCallbacks'
import { SECTION_HANDLE_FEATURE_ID, SECTION_HANDLE_FIELD, SECTION_HANDLE_KEY } from '@/viewport/sectionHandle'
import { shouldActivateDrag } from '@/utils/geometry/dragLogic'
import { handleColor } from '@/components/Geometry3D/featureHandleMath'
import { p2w } from '@/utils/geometry/sketchHelpers'
import { offsetFramePoint, sectionOffsetFromDrag } from '@/viewport/sectionPlane'
import { useSectionClip } from '@/viewport/useSection'
import ScreenArrow, { TIP } from '@/components/Viewport/ScreenArrow'
import { useAxisDrag } from '@/components/Viewport/useAxisDrag'

// The section's drag arrow. It rides the existing featureHandle pick layer
// under its own key, exactly like an edit handle: the dispatcher routes the
// grab to this component's callback, and hover lights it through
// hoveredSelectionId, so the one pick path is unchanged.

// The faint plane outline is world-sized: it marks a geometric plane, so it
// should grow and shrink with the model rather than with the camera.
const OUTLINE_SIZE = 120
const OUTLINE_COLOR = '#7fa6c9'

interface PendingDrag {
  startClient: [number, number]
  startOffset: number
  axisPoint: [number, number, number]
  axisDir: [number, number, number]
}

function buildOutlineGeometry(size: number): THREE.BufferGeometry {
  const half = size / 2
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
    -half, -half, 0,
     half, -half, 0,
     half,  half, 0,
    -half,  half, 0,
  ]), 3))
  return geometry
}

/** The arrow and outline of the live section plane, plus its offset drag. */
export default function SectionPlaneHandle() {
  const { camera } = useThree()
  const { active, frame, offset } = useSectionClip()
  const capturing = useSectionStore(s => s.capturing)
  const hovered = useSketchEditorStore(s => s.hoveredSelectionId === SECTION_HANDLE_KEY)
  const { pxToWorld, cursorAxisParam, trackZoom } = useAxisDrag()

  const [dragging, setDragging] = useState(false)
  const draggingRef = useRef(false)
  const pendingRef = useRef<PendingDrag | null>(null)
  const startParamRef = useRef<number | null>(null)
  const groupRef = useRef<THREE.Group>(null)

  const outlineGeometry = useMemo(() => buildOutlineGeometry(OUTLINE_SIZE), [])
  useEffect(() => () => { outlineGeometry.dispose() }, [outlineGeometry])

  // The actual plane the user sees: offset applied along the source normal.
  // `flipped` only swaps the kept half, so the drawn plane and the arrow's
  // direction stay where they were.
  const planePoint = useMemo(
    () => (frame ? offsetFramePoint(frame, offset) : null),
    [frame, offset],
  )
  const planeQuaternion = useMemo(() => {
    if (!frame) return new THREE.Quaternion()
    return new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 0, 1),
      new THREE.Vector3(...frame.normal),
    )
  }, [frame])
  const arrowQuaternion = useMemo(() => {
    if (!frame) return new THREE.Quaternion()
    return new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(...frame.normal),
    )
  }, [frame])

  const tipPoint = useMemo<[number, number, number] | null>(() => {
    if (!frame || !planePoint) return null
    const [nx, ny, nz] = frame.normal
    const tip = TIP * pxToWorld
    return [planePoint[0] + nx * tip, planePoint[1] + ny * tip, planePoint[2] + nz * tip]
  }, [frame, planePoint, pxToWorld])

  useFeatureHandleIdRegistration({
    featureId: SECTION_HANDLE_FEATURE_ID,
    field: SECTION_HANDLE_FIELD,
    start: planePoint ?? [0, 0, 0],
    end: tipPoint ?? [0, 0, 0],
    enabled: active && !capturing && !dragging && planePoint !== null && tipPoint !== null,
  })

  // Grab: the dispatcher has already resolved the arrow's pixels in the ID
  // buffer. This records a pending drag; the move listener activates past the
  // click threshold so a click on the arrow does not nudge the plane.
  useEffect(() => {
    if (!active || !frame || capturing) return
    return registerFeatureHandleCallbacks(SECTION_HANDLE_KEY, {
      onPointerDown: (clientX, clientY) => {
        const st = useSketchEditorStore.getState()
        st.setIsPointerDown(true)
        pendingRef.current = {
          startClient: [clientX, clientY],
          startOffset: useSectionStore.getState().offset,
          axisPoint: offsetFramePoint(frame, useSectionStore.getState().offset),
          axisDir: frame.normal,
        }
      },
      onDoubleClick: () => {},
    })
  }, [active, frame, capturing])

  const moveImpl = (e: PointerEvent) => {
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
    const param = cursorAxisParam(e, pending.axisPoint, pending.axisDir)
    if (param === null || startParamRef.current === null) return
    // Only viewer state changes here: no Mutation, no solve request. The store
    // subscription requests the frame and the section effects dirty the pick
    // buffer, so the drag is a pure render update.
    useSectionStore.getState().setOffset(sectionOffsetFromDrag(pending.startOffset, startParamRef.current, param))
  }
  const moveRef = useRef(moveImpl)
  useEffect(() => { moveRef.current = moveImpl })

  const upImpl = () => {
    if (!pendingRef.current) return
    pendingRef.current = null
    startParamRef.current = null
    if (draggingRef.current) {
      draggingRef.current = false
      setDragging(false)
    }
    useSketchEditorStore.getState().setIsPointerDown(false)
  }
  const upRef = useRef(upImpl)
  useEffect(() => { upRef.current = upImpl })

  useEffect(() => {
    const onMove = (e: PointerEvent) => moveRef.current(e)
    const onUp = () => upRef.current()
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [])

  // A component unmounted mid-drag must not leave the camera orbit locked.
  useEffect(() => () => {
    if (pendingRef.current) useSketchEditorStore.getState().setIsPointerDown(false)
    pendingRef.current = null
  }, [])

  useFrame(() => {
    if (!active) return
    const scale = p2w(camera)
    groupRef.current?.scale.setScalar(scale)
    trackZoom(scale)
  })

  if (!active || !frame || !planePoint || capturing) return null

  const color = handleColor(hovered, dragging)

  return (
    <group>
      <group position={planePoint} quaternion={planeQuaternion}>
        <lineLoop geometry={outlineGeometry} renderOrder={1000} raycast={() => undefined}>
          <lineBasicMaterial color={OUTLINE_COLOR} transparent opacity={0.35} depthTest={false} depthWrite={false} />
        </lineLoop>
      </group>
      <group position={planePoint} quaternion={arrowQuaternion}>
        <ScreenArrow color={color} headRef={groupRef} pixelsPerWorld={pxToWorld} />
      </group>
    </group>
  )
}
