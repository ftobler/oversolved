import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { useFrame, useThree } from '@react-three/fiber'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { useSectionStore } from '@/stores/sectionStore'
import { useFeatureHandleIdRegistration } from '@/picking'
import { registerFeatureHandleCallbacks } from '@/components/Viewport/idDispatch/featureHandleCallbacks'
import { SECTION_HANDLE_FEATURE_ID, SECTION_HANDLE_FIELD, SECTION_HANDLE_KEY } from '@/viewport/sectionHandle'
import { closestParamOnAxis } from '@/utils/gizmoMath'
import { shouldActivateDrag } from '@/components/Geometry3D/dragLogic'
import { handleColor } from '@/components/Geometry3D/featureHandleMath'
import { p2w } from '@/utils/geometry/sketchHelpers'
import { offsetFramePoint, sectionOffsetFromDrag } from '@/viewport/sectionPlane'
import { useSectionClip } from '@/viewport/useSection'

// The section's drag arrow. It rides the existing featureHandle pick layer
// under its own key, exactly like an edit handle: the dispatcher routes the
// grab to this component's callback, and hover lights it through
// hoveredSelectionId, so the one pick path is unchanged.

// Arrow proportions in screen pixels, the same convention as FeatureHandles.
const SHAFT_START = -10
const SHAFT_END = 26
const SHAFT_RADIUS = 1.6
const CONE_LEN = 16
const CONE_RADIUS = 5.5
const TIP = SHAFT_END + CONE_LEN

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
  const { camera, gl } = useThree()
  const { active, frame, offset } = useSectionClip()
  const hovered = useSketchEditorStore(s => s.hoveredSelectionId === SECTION_HANDLE_KEY)

  const [dragging, setDragging] = useState(false)
  const draggingRef = useRef(false)
  const pendingRef = useRef<PendingDrag | null>(null)
  const startParamRef = useRef<number | null>(null)
  const raycasterRef = useRef(new THREE.Raycaster())

  const [pxToWorld, setPxToWorld] = useState(() => {
    const ortho = camera as THREE.OrthographicCamera
    return ortho.isOrthographicCamera ? p2w(camera) : 1
  })
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
    enabled: active && !dragging && planePoint !== null && tipPoint !== null,
  })

  const cursorAxisParam = useCallback((
    e: PointerEvent,
    axisPoint: [number, number, number],
    axisDir: [number, number, number],
  ): number | null => {
    const rect = gl.domElement.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return null
    const ndc = {
      x: ((e.clientX - rect.left) / rect.width) * 2 - 1,
      y: -((e.clientY - rect.top) / rect.height) * 2 + 1,
    }
    const rc = raycasterRef.current
    rc.setFromCamera(new THREE.Vector2(ndc.x, ndc.y), camera)
    const o = rc.ray.origin
    const d = rc.ray.direction
    return closestParamOnAxis({ origin: [o.x, o.y, o.z], direction: [d.x, d.y, d.z] }, axisPoint, axisDir)
  }, [camera, gl])

  // Grab: the dispatcher has already resolved the arrow's pixels in the ID
  // buffer. This records a pending drag; the move listener activates past the
  // click threshold so a click on the arrow does not nudge the plane.
  useEffect(() => {
    if (!active || !frame) return
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
  }, [active, frame])

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
    // Re-registering the pick segment on every zoom tick would rebuild the
    // buffer continuously; only ~25% steps propagate, as FeatureHandles does.
    if (scale > pxToWorld * 1.25 || scale < pxToWorld * 0.8) setPxToWorld(scale)
  })

  if (!active || !frame || !planePoint) return null

  const color = handleColor(hovered, dragging)

  return (
    <group>
      <group position={planePoint} quaternion={planeQuaternion}>
        <lineLoop geometry={outlineGeometry} renderOrder={1000} raycast={() => undefined}>
          <lineBasicMaterial color={OUTLINE_COLOR} transparent opacity={0.35} depthTest={false} depthWrite={false} />
        </lineLoop>
      </group>
      <group position={planePoint} quaternion={arrowQuaternion}>
        <group ref={groupRef}>
          <mesh position={[0, (SHAFT_START + SHAFT_END) / 2, 0]} renderOrder={1000}>
            <cylinderGeometry args={[SHAFT_RADIUS, SHAFT_RADIUS, SHAFT_END - SHAFT_START, 12]} />
            <meshBasicMaterial color={color} transparent opacity={1} depthTest={false} depthWrite={false} />
          </mesh>
          <mesh position={[0, SHAFT_END + CONE_LEN / 2, 0]} renderOrder={1000}>
            <coneGeometry args={[CONE_RADIUS, CONE_LEN, 16]} />
            <meshBasicMaterial color={color} transparent opacity={1} depthTest={false} depthWrite={false} />
          </mesh>
        </group>
      </group>
    </group>
  )
}
