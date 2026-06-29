import { Line } from '@react-three/drei'
import { Arrowhead, ArrowTail } from './primitives'
import { useDimInteraction, useActiveLabelDrag, useDimLabelPointerDown } from './useDimInteraction'
import { DimensionLabel } from './DimensionLabel'
import type { DimInteraction } from './useDimInteraction'
import { useDimensionLabelIdRegistration } from '@/picking/useDimensionLabelIdRegistration'
import { useDimDispatchRegistration } from './useDimDispatchRegistration'
import type { PlaneTransform } from '@/types/cad'
import { LABEL_Z_OFFSET } from '@/components/Geometry3D/constants'

export function RadiusDimension({ cid, dim, interaction, planeTransform }: {
  cid: string
  dim: { kind: string; p1: [number, number]; p2: [number, number]; value: number; pos?: [number, number] }
  interaction?: DimInteraction
  planeTransform?: PlaneTransform
}) {
  const { color, onOver, onOut, onClick, onDoubleClick, resetDragMoved, isDragged   } = useDimInteraction(cid, dim.value, interaction)
  const activeDragPos = useActiveLabelDrag(cid)

  // p1 = center, p2 = edge point; r is the circle/arc radius.
  const [cx, cy] = dim.p1
  const r = Math.hypot(dim.p2[0] - cx, dim.p2[1] - cy)

  const effectivePos: [number, number] | undefined = activeDragPos
    ? [activeDragPos[0] - cx, activeDragPos[1] - cy]
    : dim.pos

  let labelX: number, labelY: number, tipX: number, tipY: number

  if (effectivePos) {
    const [ox, oy] = effectivePos
    labelX = cx + ox; labelY = cy + oy
    // Arrow tip is on the circle boundary in the direction from center toward label.
    const d = Math.hypot(ox, oy)
    if (d > 0) {
      tipX = cx + (ox / d) * r
      tipY = cy + (oy / d) * r
    } else {
      tipX = dim.p2[0]; tipY = dim.p2[1]
    }
  } else {
    // Default: rotate slightly off-axis, label at midpoint.
    const angle = 10 * (Math.PI / 180)
    const dx = dim.p2[0] - cx, dy = dim.p2[1] - cy
    tipX = cx + dx * Math.cos(angle) - dy * Math.sin(angle)
    tipY = cy + dx * Math.sin(angle) + dy * Math.cos(angle)
    labelX = (cx + tipX) / 2; labelY = (cy + tipY) / 2
  }

  // Determine if the label is inside the circle (between center and edge) or outside.
  // ASCII visualizations (center at o, edge at |):
  //   Inside (circle):   o---X--->|
  //     Line from center through label to edge, arrow at edge pointing outward.
  //   Outside (circle):  o----|<---X
  //     Line from center through edge to label, arrow at edge pointing inward.
  //
  // For arc entities, if the label direction falls outside the arc's angular range,
  // the arc should be virtually extended with a thin dashed dimension line to show
  // that the dimension applies to the extended geometry. This would require knowing
  // the arc range (p1, p2 endpoints + center) to detect if label is outside arc span.
  const labelDist = Math.hypot(labelX - cx, labelY - cy)
  const isInside = labelDist <= r

  const label = `R${dim.value % 1 === 0 ? dim.value : dim.value.toFixed(2)}`

  useDimensionLabelIdRegistration({
    constraintId: cid,
    position: [labelX, labelY, LABEL_Z_OFFSET],
    enabled: !!interaction && !isDragged,
    planeTransform,
  })
  const onPointerDown = useDimLabelPointerDown(cid, interaction, resetDragMoved, cx, cy, labelX, labelY)

  useDimDispatchRegistration(cid, { onOver, onOut, onClick: () => {}, onDoubleClick, onPointerDown })

  return (
    <group key={cid}>
      {isInside ? (
        // Inside: line from center to edge, arrow at edge pointing outward.
        <>
          <Line points={[[cx, cy, 0], [tipX, tipY, 0]]} color={color} lineWidth={1} depthTest={false} />
          <Arrowhead tip={[tipX, tipY]} from={[cx, cy]} color={color} />
        </>
      ) : (
        // Outside: line extends from center through edge all the way to label,
        // arrow at edge is inverted (points inward toward center).
        <>
          <Line points={[[cx, cy, 0], [labelX, labelY, 0]]} color={color} lineWidth={1} depthTest={false} />
          <Arrowhead tip={[tipX, tipY]} from={[labelX, labelY]} color={color} />
          {(() => { const td = Math.hypot(tipX - cx, tipY - cy) || 1; return <ArrowTail origin={[tipX, tipY]} dir={[(tipX - cx) / td, (tipY - cy) / td]} color={color} /> })()}
        </>
      )}
      <DimensionLabel
        x={labelX} y={labelY} label={label} color={color}
        interactive={!!interaction} isDragged={isDragged}
        onClick={onClick} onDoubleClick={onDoubleClick} onPointerDown={onPointerDown}
      />
    </group>
  )
}

export function DiameterDimension({ cid, dim, interaction, planeTransform }: {
  cid: string
  dim: { kind: string; p1: [number, number]; p2: [number, number]; value: number; pos?: [number, number] }
  interaction?: DimInteraction
  planeTransform?: PlaneTransform
}) {
  const { color, onOver, onOut, onClick, onDoubleClick, resetDragMoved, isDragged } = useDimInteraction(cid, dim.value, interaction)
  const activeDragPos = useActiveLabelDrag(cid)

  // p1 and p2 are the two endpoints of the diameter; center is their midpoint.
  const anchorX = (dim.p1[0] + dim.p2[0]) / 2, anchorY = (dim.p1[1] + dim.p2[1]) / 2
  const r = Math.hypot(dim.p2[0] - dim.p1[0], dim.p2[1] - dim.p1[1]) / 2

  const effectivePos: [number, number] | undefined = activeDragPos
    ? [activeDragPos[0] - anchorX, activeDragPos[1] - anchorY]
    : dim.pos

  let ep1x: number, ep1y: number, ep2x: number, ep2y: number, labelX: number, labelY: number

  if (effectivePos) {
    const [ox, oy] = effectivePos
    labelX = anchorX + ox; labelY = anchorY + oy
    // Rotate the diameter line to point along the drag direction.
    const angle = Math.atan2(oy, ox)
    ep1x = anchorX - r * Math.cos(angle); ep1y = anchorY - r * Math.sin(angle)
    ep2x = anchorX + r * Math.cos(angle); ep2y = anchorY + r * Math.sin(angle)
  } else {
    ep1x = dim.p1[0]; ep1y = dim.p1[1]
    ep2x = dim.p2[0]; ep2y = dim.p2[1]
    // Place label at 30% along the diameter line
    labelX = dim.p1[0] + (dim.p2[0] - dim.p1[0]) * 0.3
    labelY = dim.p1[1] + (dim.p2[1] - dim.p1[1]) * 0.3
  }

  // Determine if label is inside or outside the circle.
  // ASCII visualizations (center at o, endpoints at |):
  //   Inside (within circle):   |<--X--o---->|
  //     Arrows at endpoints pointing outward (away from center), label within circle bounds.
  //   Outside (beyond circle):  ->|---o----|<--X
  //     Arrows at endpoints pointing inward (toward center), leader line from endpoint to label.
  const labelDist = Math.hypot(labelX - anchorX, labelY - anchorY)
  const isInside = labelDist <= r
  const diamLen = Math.hypot(ep2x - ep1x, ep2y - ep1y)
  const udirX = diamLen > 0 ? (ep2x - ep1x) / diamLen : 1
  const udirY = diamLen > 0 ? (ep2y - ep1y) / diamLen : 0

  const label = `Ø${dim.value % 1 === 0 ? dim.value : dim.value.toFixed(2)}`

  useDimensionLabelIdRegistration({
    constraintId: cid,
    position: [labelX, labelY, LABEL_Z_OFFSET],
    enabled: !!interaction && !isDragged,
    planeTransform,
  })
  const onPointerDown = useDimLabelPointerDown(cid, interaction, resetDragMoved, anchorX, anchorY, labelX, labelY)

  useDimDispatchRegistration(cid, { onOver, onOut, onClick: () => {}, onDoubleClick, onPointerDown })

  return (
    <group key={cid}>
      <Line points={[[ep1x, ep1y, 0], [ep2x, ep2y, 0]]} color={color} lineWidth={1} depthTest={false} />
      {isInside ? (
        // Inside circle: arrows at endpoints pointing outward.
        // |<--X--o---->|
        <>
          <Arrowhead tip={[ep1x, ep1y]} from={[ep2x, ep2y]} color={color} />
          <Arrowhead tip={[ep2x, ep2y]} from={[ep1x, ep1y]} color={color} />
        </>
      ) : (
        // Outside circle: both arrows point inward (toward center).
        // X--->|---o----|<--
        <>
          <Arrowhead tip={[ep1x, ep1y]} from={[ep1x - udirX, ep1y - udirY]} color={color} />
          <ArrowTail origin={[ep1x, ep1y]} dir={[-udirX, -udirY]} color={color} />
          <Arrowhead tip={[ep2x, ep2y]} from={[ep2x + udirX, ep2y + udirY]} color={color} />
          <ArrowTail origin={[ep2x, ep2y]} dir={[udirX, udirY]} color={color} />
          <Line points={[[ep1x, ep1y, 0], [labelX, labelY, 0]]} color={color} lineWidth={1} depthTest={false} />
        </>
      )}
      <DimensionLabel
        x={labelX} y={labelY} label={label} color={color}
        interactive={!!interaction} isDragged={isDragged} selectable={false}
        onClick={onClick} onDoubleClick={onDoubleClick} onPointerDown={onPointerDown}
      />
    </group>
  )
}
