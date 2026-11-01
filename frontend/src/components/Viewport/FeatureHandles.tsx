import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useFrame, useThree } from '@react-three/fiber'
import { Html } from '@react-three/drei'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { useEditorState } from '@/hooks/useEditorState'
import { useSketchEditorStore, useSketchUiStore, getSketchCallback, type FeatureHandleDrag } from '@/stores/sketchEditorStore'
import { useFeatureHandleIdRegistration, featureHandleKey } from '@/picking'
import { registerFeatureHandleCallbacks } from '@/components/Viewport/idDispatch/featureHandleCallbacks'
import { handleValueFromTravel, roundHandleValue, shouldCommitHandleRelease, handleTailLength, labelOffsetPx, handleColor } from '@/components/Geometry3D/featureHandleMath'
import { shouldActivateDrag } from '@/utils/geometry/dragLogic'
import { p2w } from '@/utils/geometry/sketchHelpers'
import { refusalText } from '@/utils/core/statusMark'
import { expressionRefusal, positive } from '@/utils/core/valueRules'
import type { FeatureHandleData, Mutation, PartFeature, SketchData } from '@/types/cad'
import ScreenArrow, { SHAFT_RADIUS, SHAFT_START, TIP } from '@/components/Viewport/ScreenArrow'
import { useAxisDrag } from '@/components/Viewport/useAxisDrag'

// The tail behind the grab point is world-sized (it spans the whole feature,
// extrude origin to end face); only its radius is pixels. The screen-sized head
// lives in ScreenArrow.

// Value-label metrics (px). The label is offset from the arrow tip in screen
// space (see labelOffsetPx), so it needs its own approximate half-extents:
// monospace 11px is ~6.6px per character plus the 5px horizontal padding.
const LABEL_FONT_PX = 11
const LABEL_CHAR_W = 6.6
const LABEL_HALF_H = 9
const LABEL_GAP = 8

// Stored value must be a plain number for the arrow to be draggable; an
// expression (e.g. "width*2") would be silently destroyed by a drag commit,
// so expressions keep the arrow as a direction indicator + double-click edit.
const PLAIN_NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)$/

function isDraggableValue(raw: unknown): boolean {
  if (raw === undefined || raw === null) return true  // schema default, numeric
  if (typeof raw === 'number') return true
  return typeof raw === 'string' && PLAIN_NUMBER.test(raw.trim())
}

// Handle-emitting feature kind -> its field-mutation type. `PartFeature.kind` is
// a plain string, so the lookup is cast rather than checked; a kind missing from
// the map is guarded at the call site (emitFieldMutation returns early).
// `field` is cast for the same reason: handle.field is a plain string, while
// each mutation narrows to keyof XxxFeatureDef -- both sides agree on the same
// fields.
const FIELD_MUTATION_TYPE = {
  extrude: 'set_extrude_field',
  revolve: 'set_revolve_field',
  fillet: 'set_fillet_field',
  chamfer: 'set_chamfer_field',
  move_face: 'set_move_face_field',
} as const

function emitFieldMutation(
  kind: keyof typeof FIELD_MUTATION_TYPE,
  featureId: string,
  field: string,
  value: number | string,
): void {
  const type = FIELD_MUTATION_TYPE[kind]
  if (!type) return
  getSketchCallback('onMutation')?.({
    type, featureId, field, value,
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
  const editingFeatureId = useEditorState(s => s.editingFeatureId)
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
  const { camera, size } = useThree()
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

  // World-sized tail behind the grab point (feature origin to grab point);
  // the drag preview stretches it live so the tail always ends at the origin.
  const tailLen = handleTailLength(handle.kind, handle.value, handle.unit_scale)
  const tailWorldLen = tailLen + travel

  const { pxToWorld, cursorAxisParam, trackZoom } = useAxisDrag()

  // The pick segment spans the visible arrow: tail start (world-sized part)
  // through the screen-sized head to the cone tip.
  const headStartPx = tailLen > 0 ? 0 : SHAFT_START
  const tipWorld = TIP * pxToWorld
  useFeatureHandleIdRegistration({
    featureId,
    field: handle.field,
    start: [ax - dx * tailLen, ay - dy * tailLen, az - dz * tailLen],
    end: [ax + dx * tipWorld, ay + dy * tipWorld, az + dz * tipWorld],
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
        useSketchUiStore.getState().openDialog({
          position: [clientX, clientY],
          label: `${feature.label || feature.kind} ${handle.field}`,
          defaultValue: String(rawStored ?? handle.value),
          validate: (input) => refusalText('Value', expressionRefusal(input, positive)),
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
  const tailRef = useRef<THREE.Mesh>(null)
  useFrame(() => {
    const f = p2w(camera)
    groupRef.current?.scale.setScalar(f)
    // The tail's radius is screen-constant but its length is world-sized, so
    // it cannot live in the uniformly rescaled head group.
    tailRef.current?.scale.set(SHAFT_RADIUS * f, tailWorldLen, SHAFT_RADIUS * f)
    trackZoom(f)
  })

  const color = handleColor(hovered, !!activeDrag)
  const opacity = draggable ? 1 : 0.45
  const displayValue = roundHandleValue(activeDrag ? activeDrag.currentValue : handle.value)
  const showLabel = !!activeDrag || hovered
  const labelText = `${handle.field} ${displayValue.toFixed(2)}`

  // Label placement: offset from the cone tip in SCREEN space, along the
  // arrow's projected direction. An offset along the 3D axis foreshortens to
  // zero when the arrow points at the camera, parking the label on the cone;
  // the screen-space offset (with an end-on fallback) never does.
  const screenDir = ((): [number, number] => {
    const a = new THREE.Vector3(ax, ay, az).project(camera)
    const b = new THREE.Vector3(ax + dx, ay + dy, az + dz).project(camera)
    return [(b.x - a.x) * size.width / 2, -((b.y - a.y) * size.height / 2)]
  })()
  const labelHalfW = labelText.length * LABEL_CHAR_W / 2 + 5
  const [labelDx, labelDy] = labelOffsetPx(screenDir, labelHalfW, LABEL_HALF_H, LABEL_GAP)

  return (
    <group position={position} quaternion={quaternion}>
      <ScreenArrow
        color={color}
        opacity={opacity}
        tailLength={tailWorldLen}
        tailRef={tailRef}
        headStartPx={headStartPx}
        headRef={groupRef}
        pixelsPerWorld={pxToWorld}
      >
        {showLabel && (
          <Html position={[0, TIP, 0]} center style={{ pointerEvents: 'none' }} zIndexRange={[100, 0]}>
            <div style={{
              color, fontSize: LABEL_FONT_PX, fontFamily: "'Roboto Mono', monospace", background: '#111',
              padding: '0 5px', borderRadius: 2, whiteSpace: 'nowrap',
              transform: `translate(${labelDx}px, ${labelDy}px)`,
              userSelect: 'none', WebkitUserSelect: 'none',
            }}>
              {labelText}
            </div>
          </Html>
        )}
      </ScreenArrow>
    </group>
  )
}
