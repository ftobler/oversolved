import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useFrame, useThree } from '@react-three/fiber'
import { Html } from '@react-three/drei'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { useEditorState } from '@/hooks/useEditorState'
import { useSketchEditorStore, useSketchUiStore, getSketchCallback, type FeatureHandleDrag } from '@/stores/sketchEditorStore'
import { useFeatureHandleIdRegistration, featureHandleKey } from '@/picking'
import { registerFeatureHandleCallbacks } from '@/components/Viewport/idDispatch/featureHandleCallbacks'
import { handleValueFromTravel, roundHandleValue, shouldCommitHandleRelease, handleTailLength, handleDragTravel, labelOffsetPx, handleColor } from '@/components/Geometry3D/featureHandleMath'
import { createLiveValuePump, type LiveValuePump } from '@/components/Geometry3D/liveValuePump'
import { shouldActivateDrag } from '@/utils/geometry/dragLogic'
import { p2w } from '@/utils/geometry/sketchHelpers'
import { refusalText } from '@/utils/core/statusMark'
import { expressionRefusal, positive } from '@/utils/core/valueRules'
import type { FeatureHandleData, Mutation, PartFeature, SketchData } from '@/types/cad'
import ScreenArrow, { SHAFT_RADIUS, SHAFT_START, TIP } from '@/components/Viewport/ScreenArrow'
import { useAxisDrag } from '@/components/Viewport/useAxisDrag'
import { unitLabel } from '@/utils/fieldUnit'
import { lengthUnitOf } from '@/utils/lengthUnit'
import { variableScopeAt, laterVariablesAt } from '@/kernel/features/variable'

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
): unknown {
  const type = FIELD_MUTATION_TYPE[kind]
  if (!type) return
  return getSketchCallback('onMutation')?.({
    type, featureId, field, value,
  } as Mutation)
}

/**
 * The gesture's own descriptor, for the stretches where a live solve has no
 * handle to publish (a value that fails to build). The drag captured the
 * press-time anchor, direction, scale and value, which is everything the arrow
 * needs to stay drawn and to keep mapping the pointer to the same value.
 */
function dragHandleDescriptor(drag: {
  field: string
  startValue: number
  axisOrigin: [number, number, number]
  axisDir: [number, number, number]
  unitScale: number
  min: number
  max?: number
  handleKind?: 'linear' | 'angular'
}): FeatureHandleData {
  return {
    kind: drag.handleKind ?? 'linear',
    field: drag.field,
    anchor: drag.axisOrigin,
    direction: drag.axisDir,
    value: drag.startValue,
    unit_scale: drag.unitScale,
    min: drag.min,
    ...(drag.max !== undefined && { max: drag.max }),
  }
}

/**
 * The draggable editing arrow for the feature currently being edited.
 *
 * Everything geometric (anchor, direction, drag-to-value mapping) comes from
 * the kernel's `handle` descriptor in the feature's solve result; this
 * component renders the arrow, registers its grab point in the featureHandle
 * ID layer, owns the window-level drag gesture, and sends the new value as a
 * `set_<kind>_field` mutation: live through a newest-value pump while the drag
 * moves, and once more on release (the rebuild follows, like every other
 * feature edit).
 */
export default function FeatureHandles() {
  const editingFeatureId = useEditorState(s => s.editingFeatureId)
  const doc = usePartEditorStore(s => s.doc)
  const solveResults = usePartEditorStore(s => s.solveResults) as Record<string, SketchData> | undefined
  const features = doc?.features

  // The typed-value prompt is a feature expression field like any other, so it
  // resolves the same positional scope the editor hands its widgets. Memoized
  // on the log so the gesture effect does not re-subscribe every render.
  const index = features === undefined || editingFeatureId === null
    ? -1
    : features.findIndex(f => f.id === editingFeatureId)
  const variables = useMemo(
    () => (features === undefined || index < 0 ? {} : variableScopeAt(features, index)),
    [features, index],
  )
  const laterVariables = useMemo(
    () => (features === undefined || index < 0 ? {} : laterVariablesAt(features, index, variables)),
    [features, index, variables],
  )

  const drag = useSketchEditorStore(s => s.drag)

  // A live solve of the edited feature can land without a handle (a failing
  // value). The gesture's own press-time descriptor is kept in the drag state,
  // so the arrow stays mounted and draggable from it until the next good solve
  // installs a fresh one. Only the drag's current value moves during the
  // gesture, so the descriptor is memoized off the fields that do not.
  const solvedHandle = editingFeatureId ? solveResults?.[editingFeatureId]?.handle : undefined
  const liveDrag = drag?.type === 'feature_handle' && drag.featureId === editingFeatureId ? drag : null
  const dragField = liveDrag?.field ?? null
  const dragStartValue = liveDrag?.startValue ?? 0
  const dragAxisOrigin = liveDrag?.axisOrigin
  const dragAxisDir = liveDrag?.axisDir
  const dragUnitScale = liveDrag?.unitScale ?? 1
  const dragMin = liveDrag?.min ?? 0
  const dragMax = liveDrag?.max
  const dragKind = liveDrag?.handleKind
  const liveDescriptor = useMemo(
    () => (dragField === null || !dragAxisOrigin || !dragAxisDir
      ? null
      : dragHandleDescriptor({
        field: dragField,
        startValue: dragStartValue,
        axisOrigin: dragAxisOrigin,
        axisDir: dragAxisDir,
        unitScale: dragUnitScale,
        min: dragMin,
        ...(dragMax !== undefined && { max: dragMax }),
        ...(dragKind !== undefined && { handleKind: dragKind }),
      })),
    [dragField, dragStartValue, dragAxisOrigin, dragAxisDir, dragUnitScale, dragMin, dragMax, dragKind],
  )

  if (!editingFeatureId) return null
  const handle = solvedHandle ?? liveDescriptor ?? undefined
  const feature = features?.find(f => f.id === editingFeatureId)
  if (!handle || !feature) return null

  // Key remount on feature/field change so gesture state never leaks across handles.
  return (
    <HandleArrow
      key={featureHandleKey(editingFeatureId, handle.field)}
      featureId={editingFeatureId}
      feature={feature}
      handle={handle}
      variables={variables}
      laterVariables={laterVariables}
    />
  )
}

function HandleArrow({ featureId, feature, handle, variables, laterVariables }: {
  featureId: string
  feature: PartFeature
  handle: FeatureHandleData
  variables: Record<string, number>
  laterVariables: Record<string, number>
}) {
  const { camera, size } = useThree()
  const selectionKey = featureHandleKey(featureId, handle.field)
  // The handle's own kind is the quantity: a sweep is a length in the
  // document's unit, a revolve is degrees.
  const quantity = handle.kind === 'angular' ? 'angle' : 'length'
  const lengthUnit = lengthUnitOf(usePartEditorStore(s => s.doc)?.length_unit)

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

  // Grab point rides the drag preview. The solved anchor may already have moved
  // to the value the live solve landed on, so the pointer travel is measured
  // from the press-time anchor and reduced by that movement, never added on top
  // of it twice.
  const travel = activeDrag
    ? handleDragTravel(
      handle.anchor, handle.direction, activeDrag.axisOrigin,
      activeDrag.currentValue - activeDrag.startValue, activeDrag.unitScale,
    )
    : 0
  const position: [number, number, number] = [ax + dx * travel, ay + dy * travel, az + dz * travel]

  const quaternion = useMemo(
    () => new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(dx, dy, dz).normalize()),
    [dx, dy, dz],
  )

  // World-sized tail behind the grab point (feature origin to grab point),
  // sized from the value the pointer shows: a live solve makes the solved value
  // the anchor of that travel, so sizing it from the solved value plus the
  // travel would count a moved anchor twice.
  const tailValue = activeDrag ? activeDrag.currentValue : handle.value
  const tailLen = handleTailLength(handle.kind, tailValue, handle.unit_scale)

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
          handleKind: handle.kind,
          ...(handle.max !== undefined && { max: handle.max }),
        })
      },
      onDoubleClick: (clientX, clientY) => {
        useSketchUiStore.getState().openDialog({
          position: [clientX, clientY],
          label: `${feature.label || feature.kind} ${handle.field}`,
          defaultValue: String(rawStored ?? handle.value),
          quantity,
          validate: (input) => refusalText('Value', expressionRefusal(input, positive, variables, laterVariables)),
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
  }, [selectionKey, featureId, feature.label, feature.kind, handle, quantity, draggable, rawStored, variables, laterVariables])

  // ─── gesture: window-level move/up (mirrors DragPlane's handler-ref pattern) ───
  const dragPending = useSketchEditorStore(s => s.dragPending)
  const gestureLive = !!activeDrag
    || (dragPending?.type === 'feature_handle' && dragPending.featureId === featureId && dragPending.field === handle.field)

  // Axis param of the cursor at drag activation; travel is measured from here
  // so the value never jumps by the click-threshold distance.
  const startParamRef = useRef<number | null>(null)

  // The live rebuild pump for this gesture, created on the first value that
  // differs from the start, and the gesture's start so an abandoned drag can
  // put the field back.
  const pumpRef = useRef<LiveValuePump | null>(null)
  const dragStartValueRef = useRef<number | null>(null)
  // The authored field value at press: a net-zero drag or an abandon must put
  // back exactly what the document held, so a stored "5" stays a string and a
  // value with more than 0.01 decimals keeps its digits.
  const authoredStartRef = useRef<number | string | null>(null)

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
      dragStartValueRef.current = activated.startValue
      authoredStartRef.current = typeof rawStored === 'number' || typeof rawStored === 'string'
        ? rawStored
        : null
      st.setDrag(activated)
    }

    const cur = useSketchEditorStore.getState().drag
    if (cur?.type !== 'feature_handle' || cur.featureId !== featureId) return
    const t = cursorAxisParam(e, cur.axisOrigin, cur.axisDir)
    if (t === null || startParamRef.current === null) return
    const value = handleValueFromTravel(cur.startValue, t - startParamRef.current, cur.unitScale, cur.min, cur.max)
    st.setDrag({ ...cur, currentValue: value })

    // The pump appears on the first value that rounds to a new step, so the
    // activation move itself changes nothing. Once it exists every move feeds
    // it, including the trip back to the start: the preview must follow the
    // arrow, not stop at the last step it happened to send. The pump keeps one
    // solve in flight and drops a jitter inside one 0.01 step.
    const rounded = roundHandleValue(value)
    if (!pumpRef.current && rounded !== roundHandleValue(cur.startValue)) {
      pumpRef.current = createLiveValuePump(v =>
        emitFieldMutation(feature.kind as keyof typeof FIELD_MUTATION_TYPE, featureId, cur.field, v))
    }
    pumpRef.current?.offer(rounded)
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
    const pump = pumpRef.current
    const authored = authoredStartRef.current
    pumpRef.current = null
    dragStartValueRef.current = null
    authoredStartRef.current = null
    if (pump) {
      pump.cancel()
      // The release must land inside the edit session that is still open, so
      // the final value is sent now rather than when the in-flight solve
      // settles: OK or Cancel can close the session before that settle, which
      // would apply the release outside the one undo entry. A release back on
      // the start value sends the authored value, restoring a document moved by
      // live mutations exactly (not its 0.01 rounding).
      emitFieldMutation(
        feature.kind as keyof typeof FIELD_MUTATION_TYPE,
        featureId, drag.field, rounded ?? authored ?? drag.startValue,
      )
    } else if (rounded !== null) {
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

  // A lost pointer (pointercancel, window blur) ends the gesture as an abandon:
  // live mutations are already in the document, so they are restored, but only
  // while the edit session is still open. A missed pointerup must not turn the
  // restore into a second edit after OK or Cancel closed the session.
  const handleAbandonRef = useRef<(() => void) | null>(null)
  const abandonImpl = () => {
    const st = useSketchEditorStore.getState()
    const drag = st.drag?.type === 'feature_handle' ? st.drag : null
    const pending = st.dragPending?.type === 'feature_handle' ? st.dragPending : null
    if (drag?.featureId !== featureId && pending?.featureId !== featureId) return

    const field = drag?.field ?? pending?.field ?? handle.field
    const pump = pumpRef.current
    const authored = authoredStartRef.current
    const start = dragStartValueRef.current
    pumpRef.current = null
    dragStartValueRef.current = null
    authoredStartRef.current = null
    pump?.cancel()

    // Only a headless use can lack the port, and a restore without a session
    // would be a new edit: default to closed.
    const sessionOpen = getSketchCallback('isEditSessionOpen')?.() ?? false
    if (pump && start !== null && sessionOpen) {
      emitFieldMutation(
        feature.kind as keyof typeof FIELD_MUTATION_TYPE,
        featureId, field, authored ?? start,
      )
    }
    st.setIsPointerDown(false)
    st.setDrag(null)
    st.setDragPending(null)
    st.setDragStartClient(null)
    startParamRef.current = null
  }
  useEffect(() => { handleAbandonRef.current = abandonImpl })

  useEffect(() => {
    if (!gestureLive) return
    const onMove = (e: PointerEvent) => handleMoveRef.current?.(e)
    const onUp = () => handleUpRef.current?.()
    const onAbandon = () => handleAbandonRef.current?.()
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onAbandon)
    window.addEventListener('blur', onAbandon)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onAbandon)
      window.removeEventListener('blur', onAbandon)
    }
  }, [gestureLive])

  // Unmount mid-gesture (feature closed, rebuild replaced the editor state):
  // drop any handle drag so the camera can never stay orbit-locked, and let the
  // abandon path put the field back when the edit session is still open.
  useEffect(() => () => {
    handleAbandonRef.current?.()
  }, [feature.kind, featureId, handle.field])

  // ─── visuals ───
  const groupRef = useRef<THREE.Group>(null)
  const tailRef = useRef<THREE.Mesh>(null)
  useFrame(() => {
    const f = p2w(camera)
    groupRef.current?.scale.setScalar(f)
    // The tail's radius is screen-constant but its length is world-sized, so
    // it cannot live in the uniformly rescaled head group.
    tailRef.current?.scale.set(SHAFT_RADIUS * f, tailLen, SHAFT_RADIUS * f)
    trackZoom(f)
  })

  const color = handleColor(hovered, !!activeDrag)
  const opacity = draggable ? 1 : 0.45
  const displayValue = roundHandleValue(activeDrag ? activeDrag.currentValue : handle.value)
  const showLabel = !!activeDrag || hovered
  const unit = unitLabel(quantity, lengthUnit)
  const labelText = `${handle.field} ${displayValue.toFixed(2)}${unit === null ? '' : ` ${unit}`}`

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
        tailLength={tailLen}
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
