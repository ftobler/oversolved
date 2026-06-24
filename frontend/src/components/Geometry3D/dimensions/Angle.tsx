import { useCallback } from 'react'
import { Line } from '@react-three/drei'
import { useSketchEditorStore, getSketchCallback } from '@/stores/sketchEditorStore'
import { angleDimensionSign } from '@/utils/geometry/dimensionNaturalValue'
import { sampleArc } from '@/components/sketch/sketch_helpers'
import { Arrowhead, ExtensionLine } from './primitives'
import { useDimInteraction, useActiveLabelDrag } from './useDimInteraction'
import { DimensionLabel } from './DimensionLabel'
import type { DimInteraction } from './useDimInteraction'
import { useDimensionLabelIdRegistration } from '@/picking/useDimensionLabelIdRegistration'
import { useDimDispatchRegistration } from './useDimDispatchRegistration'
import { computeAngleDimension } from '@/utils/geometry/angleDimensionLogic'
import type { PlaneTransform } from '@/types/cad'
import { LABEL_Z_OFFSET } from '@/components/Geometry3D/constants'

export function AngleDimension({ cid, dim, interaction, planeTransform }: {
  cid: string
  dim: { kind: string; p1: [number, number]; p2: [number, number]; p3: [number, number]; p4: [number, number]; value: number; pos?: [number, number] }
  interaction?: DimInteraction
  planeTransform?: PlaneTransform
}) {
  // Angle dimensions carry an orientation sign (which handedness the value
  // pins). The edit dialog's Flip side button swaps it; the current handedness
  // is read from the rendered line directions, so flipping just negates it.
  const onFlip = useCallback(() => {
    if (!interaction) return
    const current = angleDimensionSign(dim.p1, dim.p2, dim.p3, dim.p4)
    getSketchCallback('onMutation')?.({
      type: 'set_constraint_sign', featureId: interaction.featureId, constraintId: cid, sign: -current,
    })
  }, [interaction, cid, dim.p1, dim.p2, dim.p3, dim.p4])
  const activeDragPos = useActiveLabelDrag(cid)
  const setIsPointerDown = useSketchEditorStore(s => s.setIsPointerDown)
  const setDragStartClient = useSketchEditorStore(s => s.setDragStartClient)
  const setDragPending = useSketchEditorStore(s => s.setDragPending)

  // Label offset relative to the arc vertex. While dragging, the vertex is the
  // anchor stored at pointer-down; otherwise it is recomputed below, so convert
  // the live drag world position into a vertex-relative offset lazily.
  const draggedPos: [number, number] | undefined = activeDragPos
    ? [activeDragPos[0], activeDragPos[1]]
    : undefined

  // First pass to obtain the vertex, then convert a live drag position into a
  // vertex-relative offset and recompute. (computeAngleDimension is cheap.)
  const base = computeAngleDimension(dim.p1, dim.p2, dim.p3, dim.p4, dim.pos)
  const effectivePos: [number, number] | undefined = draggedPos
    ? [draggedPos[0] - base.vx, draggedPos[1] - base.vy]
    : dim.pos
  const {
    vx, vy, arcR, a0deg, a1deg, arcSpan, labelX, labelY, isSupplement,
  } = computeAngleDimension(dim.p1, dim.p2, dim.p3, dim.p4, effectivePos)

  // The constraint stores the angle between the two lines (theta). When the
  // label sits in a supplement quadrant the arc subtends 180 - theta, so the
  // label shows that and editing it stores 180 - entered. The transform is its
  // own inverse, so the same function serves both directions.
  const supplementOf = useCallback((v: number) => 180 - v, [])
  const displayedValue = isSupplement ? supplementOf(dim.value) : dim.value
  const encodeValue = isSupplement ? supplementOf : undefined

  const { color, onOver, onOut, onClick, onDoubleClick, resetDragMoved, isDragged } =
    useDimInteraction(cid, displayedValue, interaction, false, onFlip, encodeValue)

  // Arc endpoint ray directions (radians) for arrowhead tangents.
  const angle1 = a0deg * (Math.PI / 180)
  const angle2 = a1deg * (Math.PI / 180)

  // Arc from a0 to a1 at arcR.
  const arcPts = sampleArc(vx, vy, arcR, a0deg, a1deg)
  const arcStartPt: [number, number, number] = [vx + arcR * Math.cos(angle1), vy + arcR * Math.sin(angle1), 0]
  const arcEndPt: [number, number, number] = [vx + arcR * Math.cos(angle2), vy + arcR * Math.sin(angle2), 0]

  // Radial witness lines. A measured segment lies along its ray at signed radii
  // [sMin, sMax] from the vertex. When the arc radius falls outside that range
  // the arc no longer touches the segment, so extend the segment along the ray
  // out to the arc endpoint (gap at the geometry, overshoot past the arrow tip).
  // Returns the witness start point on the ray, or null when the arc sits on the
  // segment (no witness needed).
  const radialWitnessStart = (
    px1: number, py1: number, px2: number, py2: number, ang: number,
  ): [number, number] | null => {
    const dx = Math.cos(ang), dy = Math.sin(ang)
    const s1 = (px1 - vx) * dx + (py1 - vy) * dy
    const s2 = (px2 - vx) * dx + (py2 - vy) * dy
    const sMax = Math.max(s1, s2), sMin = Math.min(s1, s2)
    let b: number | null = null
    if (arcR > sMax) b = sMax
    else if (arcR < sMin) b = sMin
    if (b === null) return null
    return [vx + b * dx, vy + b * dy]
  }
  const witnessAStart = radialWitnessStart(dim.p1[0], dim.p1[1], dim.p2[0], dim.p2[1], angle1)
  const witnessBStart = radialWitnessStart(dim.p3[0], dim.p3[1], dim.p4[0], dim.p4[1], angle2)

  // Arc tangent directions at each endpoint (unit tangent in arc travel direction).
  // Forward tangent at angle th: (-sin(th), cos(th)) * sign where sign = +1 CCW, -1 CW.
  const arcSign = arcSpan >= 0 ? 1 : -1
  const a0r = angle1, a1r = angle2
  // Tangent pointing INTO the arc span at each endpoint:
  //   arcStart: forward arc direction (into span)
  //   arcEnd:   backward arc direction (into span from the end)
  const tanStartInX = -Math.sin(a0r) * arcSign, tanStartInY = Math.cos(a0r) * arcSign
  const tanEndInX   =  Math.sin(a1r) * arcSign, tanEndInY   = -Math.cos(a1r) * arcSign

  const label = `${displayedValue % 1 === 0 ? displayedValue : displayedValue.toFixed(1)}°`

  useDimensionLabelIdRegistration({
    constraintId: cid,
    position: [labelX, labelY, LABEL_Z_OFFSET],
    enabled: !!interaction && !isDragged,
    planeTransform,
  })
  const onPointerDown = useCallback((e: { stopPropagation: () => void; clientX: number; clientY: number }) => {
    if (!interaction) return
    e.stopPropagation()
    resetDragMoved()
    setIsPointerDown(true)
    setDragStartClient([e.clientX, e.clientY])
    setDragPending({
      type: 'dim_label',
      constraintId: cid,
      featureId: interaction.featureId,
      anchorWorld: [vx, vy],
      startWorld: [labelX, labelY],
    })
  }, [interaction, cid, vx, vy, labelX, labelY, resetDragMoved, setIsPointerDown, setDragStartClient, setDragPending])

  useDimDispatchRegistration(cid, { onOver, onOut, onClick: () => {}, onDoubleClick, onPointerDown })

  return (
    <group key={cid}>
      {/* Radial witness lines connecting the measured segments to the arc */}
      {witnessAStart && <ExtensionLine start={witnessAStart} end={[arcStartPt[0], arcStartPt[1]]} color={color} />}
      {witnessBStart && <ExtensionLine start={witnessBStart} end={[arcEndPt[0], arcEndPt[1]]} color={color} />}

      {/* Arc spanning the angle */}
      <Line points={arcPts} color={color} lineWidth={1} depthTest={false} />

      {/* Arrows tangent to the arc at its endpoints, pointing OUTWARD (away from
          the span). The label always lands inside its own wedge, so there is no
          off-wedge case to draw a leader for. |<---arc-X-arc--->| */}
      <Arrowhead tip={[arcStartPt[0], arcStartPt[1]]} from={[arcStartPt[0] + tanStartInX, arcStartPt[1] + tanStartInY]} color={color} />
      <Arrowhead tip={[arcEndPt[0],   arcEndPt[1]  ]} from={[arcEndPt[0]   + tanEndInX,   arcEndPt[1]   + tanEndInY  ]} color={color} />

      {/* Interaction hit area and label text */}
      <DimensionLabel
        x={labelX} y={labelY} label={label} color={color}
        interactive={!!interaction} isDragged={isDragged}
        onClick={onClick} onDoubleClick={onDoubleClick} onPointerDown={onPointerDown}
      />
    </group>
  )
}
