import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useFrame, useThree } from '@react-three/fiber'
import { Html } from '@react-three/drei'
import { usePartEditorStore } from '@/stores/partEditorStore'
import {
  useSketchEditorStore, getSketchCallback,
  type FeatureHandleDrag,
} from '@/stores/sketchEditorStore'
import { useFeatureHandleIdRegistration, featureHandleKey } from '@/picking'
import { registerFeatureHandleCallbacks } from '@/components/Viewport/idDispatch/featureHandleCallbacks'
import { closestAxisParam, handleValueFromTravel, roundHandleValue, shouldCommitHandleRelease } from '@/components/Geometry3D/featureHandleMath'
import { shouldActivateDrag } from '@/components/Geometry3D/dragLogic'
import { p2w } from '@/utils/geometry/sketchHelpers'
import { COLOR_HOVER, COLOR_SELECTED } from '@/components/Geometry3D/constants'
import { evalExpr } from '@/kernel/evalExpr'
import type { FeatureHandleData, Mutation, PartFeature, SketchData } from '@/types/cad'

// Arrow proportions in screen pixels; the group is rescaled to p2w(camera)
// every frame so the handle keeps a constant on-screen size at any zoom.
const SHAFT_START = -10  // tail reaches slightly behind the grab point
const SHAFT_END = 26
const SHAFT_RADIUS = 1.6
const CONE_LEN = 16
const CONE_RADIUS = 5.5
const LABEL_OFFSET = SHAFT_END + CONE_LEN + 14

// Stored value must be a plain number for the arrow to be draggable; an
// expression (e.g. "width*2") would be silently destroyed by a drag commit,
// so expressions keep the arrow as a direction indicator + double-click edit.
const PLAIN_NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)$/

function isDraggableValue(raw: unknown): boolean {
  if (raw === undefined || raw === null) return true  // schema default, numeric
  if (typeof raw === 'number') return true
  return typeof raw === 'string' && PLAIN_NUMBER.test(raw.trim())
}

// Exhaustive kind -> mutation-type map so adding a new handle-emitting
// feature kind forces an update here (an unknown kind fails to compile).
// `field` is still cast: handle.field is a plain string, while each mutation
// narrows to keyof XxxFeatureDef -- both sides agree on the same fields.
const FIELD_MUTATION_TYPE = {
  extrude: 'set_extrude_field',
  revolve: 'set_revolve_field',
  fillet: 'set_fillet_field',
  chamfer: 'set_chamfer_field',
} as const

function emitFieldMutation(
  kind: keyof typeof FIELD_MUTATION_TYPE,
  featureId: string,
  field: string,
  value: number | string,
): void {
  getSketchCallback('onMutation')?.({
    type: FIELD_MUTATION_TYPE[kind], featureId, field, value,
  } as Mutation)
}

/**
 * The draggable editing arrow for the feature currently being edited.
 *
 * Everything geometric (anchor, direction, drag-to-value mapping) comes from
 * the kernel's `handle` descriptor in the feature's solve result; this
 * component renders the arrow, registers its grab point in the featureHandle
 * ID layer, owns the window-level drag gesture, and commits the new value as
 * a `set_<kind>_field` mutation on release (rebuild follows, like every
 * other feature edit).
 */
export default function FeatureHandles() {
  const editingFeatureId = usePartEditorStore(s => s.editingFeatureId)
  const doc = usePartEditorStore(s => s.doc)
  const solveResults = usePartEditorStore(s => s.solveResults) as Record<string, SketchData> | undefined

  if (!editingFeatureId) return null
  const handle = solveResults?.[editingFeatureId]?.handle
  const feature = doc?.features?.find(f => f.id === editingFeatureId)
  if (!handle || !feature) return null

  // Key remount on feature/field change so gesture state never leaks across handles.
  return (
    <HandleArrow
      key={featureHandleKey(editingFeatureId, handle.field)}
      featureId={editingFeatureId}
      feature={feature}
      handle={handle}
    />
  )
}

function HandleArrow({ featureId, feature, handle }: {
  featureId: string
  feature: PartFeature
  handle: FeatureHandleData
}) {
  const { camera, gl } = useThree()
  const selectionKey = featureHandleKey(featureId, handle.field)

  const hovered = useSketchEditorStore(s => s.hoveredSelectionId === selectionKey)
  const drag = useSketchEditorStore(s => s.drag)
  const activeDrag = drag?.type === 'feature_handle' && drag.featureId === featureId && drag.field === handle.field
    ? drag
    : null

  // The stored (unevaluated) field value; the sub-def key equals the feature
  // kind for every handle-emitting feature (extrude/revolve/fillet/chamfer).
  const sub = (feature as unknown as Record<string, Record<string, unknown> | undefined>)[feature.kind]
  const rawStored = sub?.[handle.field]
  const draggable = isDraggableValue(rawStored)

  const [ax, ay, az] = handle.anchor
  const [dx, dy, dz] = handle.direction

  // Grab point rides the drag preview: anchor + direction * value-delta * unitScale.
  const travel = activeDrag ? (activeDrag.currentValue - activeDrag.startValue) * activeDrag.unitScale : 0
  const position: [number, number, number] = [ax + dx * travel, ay + dy * travel, az + dz * travel]

  const quaternion = useMemo(
    () => new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(dx, dy, dz).normalize()),
    [dx, dy, dz],
  )

  useFeatureHandleIdRegistration({
    featureId,
    field: handle.field,
    position: [ax, ay, az],
    enabled: !activeDrag,
  })

  // ─── gesture: pointer-down starts a pending drag, dispatched by the id buffer ───
  useEffect(() => {
    return registerFeatureHandleCallbacks(selectionKey, {
      onPointerDown: (clientX, clientY) => {
        if (!draggable) return
        const st = useSketchEditorStore.getState()
        st.setIsPointerDown(true)
        st.setDragStartClient([clientX, clientY])
        st.setDragPending({
          type: 'feature_handle',
          featureId,
          field: handle.field,
          startValue: handle.value,
          axisOrigin: handle.anchor,
          axisDir: handle.direction,
          unitScale: handle.unit_scale,
          min: handle.min,
          ...(handle.max !== undefined && { max: handle.max }),
        })
      },
      onDoubleClick: (clientX, clientY) => {
        useSketchEditorStore.getState().openDialog({
          position: [clientX, clientY],
          label: `${feature.label || feature.kind} ${handle.field}`,
          defaultValue: String(rawStored ?? handle.value),
          validate: (input) => {
            const v = evalExpr(input)
            if (isNaN(v)) return 'Enter a number or expression'
            if (v <= 0) return 'Must be greater than 0'
            return null
          },
          onConfirm: (input) => {
            // Same convention as ExpressionInput: plain numbers store as
            // numbers, anything else as the raw expression string.
            const trimmed = input.trim()
            const value = PLAIN_NUMBER.test(trimmed) ? parseFloat(trimmed) : trimmed
            emitFieldMutation(
              feature.kind as keyof typeof FIELD_MUTATION_TYPE,
              featureId, handle.field, value,
            )
          },
        })
      },
    })
  }, [selectionKey, featureId, feature.label, feature.kind, handle, draggable, rawStored])

  // ─── gesture: window-level move/up (mirrors DragPlane's handler-ref pattern) ───
  const dragPending = useSketchEditorStore(s => s.dragPending)
  const gestureLive = !!activeDrag
    || (dragPending?.type === 'feature_handle' && dragPending.featureId === featureId && dragPending.field === handle.field)

  // Axis param of the cursor at drag activation; travel is measured from here
  // so the value never jumps by the click-threshold distance.
  const startParamRef = useRef<number | null>(null)
  const raycasterRef = useRef(new THREE.Raycaster())

  const cursorAxisParam = (e: PointerEvent, axisOrigin: [number, number, number], axisDir: [number, number, number]): number | null => {
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
    return closestAxisParam([o.x, o.y, o.z], [d.x, d.y, d.z], axisOrigin, axisDir)
  }

  const handleMoveRef = useRef<((e: PointerEvent) => void) | null>(null)
  const moveImpl = (e: PointerEvent) => {
    const st = useSketchEditorStore.getState()
    const { drag, dragPending, dragStartClient, isPointerDown } = st

    // Lazy activation once the pointer travels past the click threshold.
    if (!drag && dragPending?.type === 'feature_handle' && dragPending.featureId === featureId
      && dragStartClient && isPointerDown
      && shouldActivateDrag(dragStartClient, [e.clientX, e.clientY])) {
      startParamRef.current = cursorAxisParam(e, dragPending.axisOrigin, dragPending.axisDir)
      const activated: FeatureHandleDrag = { ...dragPending, currentValue: dragPending.startValue }
      st.setDrag(activated)
    }

    const cur = useSketchEditorStore.getState().drag
    if (cur?.type !== 'feature_handle' || cur.featureId !== featureId) return
    const t = cursorAxisParam(e, cur.axisOrigin, cur.axisDir)
    if (t === null || startParamRef.current === null) return
    const value = handleValueFromTravel(cur.startValue, t - startParamRef.current, cur.unitScale, cur.min, cur.max)
    st.setDrag({ ...cur, currentValue: value })
  }
  useEffect(() => { handleMoveRef.current = moveImpl })

  const handleUpRef = useRef<(() => void) | null>(null)
  const upImpl = () => {
    const st = useSketchEditorStore.getState()
    st.setIsPointerDown(false)
    const { drag, dragPending } = st

    if (!drag && dragPending?.type === 'feature_handle' && dragPending.featureId === featureId) {
      st.setDragPending(null)
      st.setDragStartClient(null)
      return
    }
    if (drag?.type !== 'feature_handle' || drag.featureId !== featureId) return

    const rounded = shouldCommitHandleRelease(drag.startValue, drag.currentValue)
    if (rounded !== null) {
      emitFieldMutation(
        feature.kind as keyof typeof FIELD_MUTATION_TYPE,
        featureId, drag.field, rounded,
      )
    }
    st.setDrag(null)
    st.setDragPending(null)
    st.setDragStartClient(null)
    startParamRef.current = null
  }
  useEffect(() => { handleUpRef.current = upImpl })

  useEffect(() => {
    if (!gestureLive) return
    const onMove = (e: PointerEvent) => handleMoveRef.current?.(e)
    const onUp = () => handleUpRef.current?.()
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [gestureLive])

  // Unmount mid-gesture (feature closed, rebuild replaced the editor state):
  // drop any handle drag so the camera can never stay orbit-locked.
  useEffect(() => () => {
    const st = useSketchEditorStore.getState()
    if (st.drag?.type === 'feature_handle' || st.dragPending?.type === 'feature_handle') {
      st.setDrag(null)
      st.setDragPending(null)
      st.setDragStartClient(null)
    }
  }, [])

  // ─── visuals ───
  const groupRef = useRef<THREE.Group>(null)
  useFrame(() => {
    groupRef.current?.scale.setScalar(p2w(camera))
  })

  const color = activeDrag || hovered ? COLOR_HOVER : COLOR_SELECTED
  const opacity = draggable ? 1 : 0.45
  const displayValue = roundHandleValue(activeDrag ? activeDrag.currentValue : handle.value)
  const showLabel = !!activeDrag || hovered

  return (
    <group position={position} quaternion={quaternion}>
      <group ref={groupRef}>
        <mesh position={[0, (SHAFT_START + SHAFT_END) / 2, 0]} renderOrder={1000}>
          <cylinderGeometry args={[SHAFT_RADIUS, SHAFT_RADIUS, SHAFT_END - SHAFT_START, 12]} />
          <meshBasicMaterial color={color} transparent opacity={opacity} depthTest={false} depthWrite={false} />
        </mesh>
        <mesh position={[0, SHAFT_END + CONE_LEN / 2, 0]} renderOrder={1000}>
          <coneGeometry args={[CONE_RADIUS, CONE_LEN, 16]} />
          <meshBasicMaterial color={color} transparent opacity={opacity} depthTest={false} depthWrite={false} />
        </mesh>
        {showLabel && (
          <Html position={[0, LABEL_OFFSET, 0]} center style={{ pointerEvents: 'none' }} zIndexRange={[100, 0]}>
            <div style={{
              color, fontSize: 14, fontFamily: 'monospace', background: '#111',
              padding: '0 5px', borderRadius: 2, whiteSpace: 'nowrap',
              userSelect: 'none', WebkitUserSelect: 'none',
            }}>
              {`${handle.field} ${displayValue.toFixed(2)}`}
            </div>
          </Html>
        )}
      </group>
    </group>
  )
}
