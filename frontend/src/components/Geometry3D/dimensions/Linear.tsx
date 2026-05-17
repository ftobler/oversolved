import { useRef, useCallback } from 'react'
import { Line, Html } from '@react-three/drei'
import { useThree, useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { p2w } from '@/components/sketch_helpers'
import { Arrowhead, ArrowTail } from './primitives'
import { useDimInteraction, useActiveLabelDrag } from './useDimInteraction'
import type { DimInteraction } from './useDimInteraction'
import { useDimensionLabelIdRegistration } from '@/picking/useDimensionLabelIdRegistration'
import { useDimDispatchRegistration } from './useDimDispatchRegistration'

export function LinearDimension({ cid, dim, dimOffset, interaction }: {
  cid: string
  dim: { kind: string; p1: [number, number]; p2: [number, number]; normal: [number, number]; value: number; pos?: [number, number] }
  dimOffset: number
  interaction?: DimInteraction
}) {
  const { color, onOver, onOut, onClick, resetDragMoved, isDragged } = useDimInteraction(cid, dim.value, interaction)
  const activeDragPos = useActiveLabelDrag(cid)
  const meshRef = useRef<THREE.Mesh>(null)
  const setOrbitEnabled = useSketchEditorStore(s => s.setOrbitEnabled)
  const setIsPointerDown = useSketchEditorStore(s => s.setIsPointerDown)
  const setDragStartClient = useSketchEditorStore(s => s.setDragStartClient)
  const setDragPending = useSketchEditorStore(s => s.setDragPending)
  const { camera } = useThree()
  useFrame(() => {
    if (meshRef.current) meshRef.current.scale.setScalar(30 * p2w(camera))
  })

  const [x1, y1] = dim.p1, [x2, y2] = dim.p2
  const nx = dim.normal[0], ny = dim.normal[1]
  const nlen = Math.sqrt(nx * nx + ny * ny) || 1
  const unx = nx / nlen, uny = ny / nlen

  // Anchor = midpoint of the two measured points.
  const anchorX = (x1 + x2) / 2, anchorY = (y1 + y2) / 2

  // Effective label offset: active drag overrides stored pos, which overrides default.
  const effectivePos: [number, number] | undefined = activeDragPos
    ? [activeDragPos[0] - anchorX, activeDragPos[1] - anchorY]
    : dim.pos

  let labelX: number, labelY: number, d1x: number, d1y: number, d2x: number, d2y: number

  if (effectivePos) {
    const [ox, oy] = effectivePos
    labelX = anchorX + ox
    labelY = anchorY + oy
    // Project pos onto normal direction to get the dimension-line perpendicular offset.
    const perpOff = ox * unx + oy * uny
    d1x = x1 + unx * perpOff; d1y = y1 + uny * perpOff
    d2x = x2 + unx * perpOff; d2y = y2 + uny * perpOff
  } else {
    d1x = x1 + unx * dimOffset; d1y = y1 + uny * dimOffset
    d2x = x2 + unx * dimOffset; d2y = y2 + uny * dimOffset
    labelX = (d1x + d2x) / 2; labelY = (d1y + d2y) / 2
  }

  // Determine if the label is inside the dimension line (between d1 and d2).
  // ASCII visualizations (in world coordinates, with d1 on the left, d2 on the right):
  //   Inside:        |<---X--->|
  //     Arrows at boundaries pointing outward, label sits between them.
  //   Outside near d1:   X--->|----|<-
  //     Both arrows point inward, leader line from d1 to label.
  //   Outside near d2:   |---->|<----X
  //     Both arrows point inward, leader line from d2 to label.
  //
  // Note: For parallel lines, the arrows should remain aligned with the dimension line,
  // not skewed or offset. The dimension line (d1->d2) is parallel to the measured line (x1->x2),
  // so arrows should point along the dimension line direction only.
  const dimLen = Math.hypot(d2x - d1x, d2y - d1y)
  const udirX = dimLen > 0 ? (d2x - d1x) / dimLen : 1
  const udirY = dimLen > 0 ? (d2y - d1y) / dimLen : 0
  // Project label onto the d1->d2 axis.
  const tLabel = (labelX - d1x) * udirX + (labelY - d1y) * udirY
  const isInside = tLabel >= 0 && tLabel <= dimLen

  const label = dim.value % 1 === 0 ? String(dim.value) : dim.value.toFixed(2)

  useDimensionLabelIdRegistration({
    constraintId: cid,
    position: [labelX, labelY, 0.001],
    enabled: !isDragged,
  })
  useDimDispatchRegistration(cid, { onOver, onOut, onClick })

  const onPointerDown = useCallback((e: { stopPropagation: () => void; clientX: number; clientY: number }) => {
    if (!interaction) return
    e.stopPropagation()
    resetDragMoved()
    setOrbitEnabled(false)
    setIsPointerDown(true)
    setDragStartClient([e.clientX, e.clientY])
    setDragPending({
      type: 'dim_label',
      constraintId: cid,
      featureId: interaction.featureId,
      anchorWorld: [anchorX, anchorY],
      startWorld: [labelX, labelY],
    })
  }, [interaction, cid, anchorX, anchorY, labelX, labelY, resetDragMoved, setOrbitEnabled, setIsPointerDown, setDragStartClient, setDragPending])

  return (
    <group key={cid}>
      <Line points={[[x1, y1, 0], [d1x, d1y, 0]]} color={color} lineWidth={1} />
      <Line points={[[x2, y2, 0], [d2x, d2y, 0]]} color={color} lineWidth={1} />
      <Line points={[[d1x, d1y, 0], [d2x, d2y, 0]]} color={color} lineWidth={1} />
      {isInside ? (
        // Inside: arrows at boundaries pointing outward.
        // |<---X--->|
        <>
          <Arrowhead tip={[d1x, d1y]} from={[d2x, d2y]} color={color} />
          <Arrowhead tip={[d2x, d2y]} from={[d1x, d1y]} color={color} />
        </>
      ) : tLabel < 0 ? (
        // Outside near d1: both arrows point inward (into the dimension line), leader from d1 to label.
        // X--->|----|<-
        <>
          <Arrowhead tip={[d1x, d1y]} from={[d1x - udirX, d1y - udirY]} color={color} />
          <ArrowTail origin={[d1x, d1y]} dir={[-udirX, -udirY]} color={color} />
          <Arrowhead tip={[d2x, d2y]} from={[d2x + udirX, d2y + udirY]} color={color} />
          <ArrowTail origin={[d2x, d2y]} dir={[udirX, udirY]} color={color} />
          <Line points={[[d1x, d1y, 0], [labelX, labelY, 0]]} color={color} lineWidth={1} />
        </>
      ) : (
        // Outside near d2: both arrows point inward (into the dimension line), leader from d2 to label.
        // Same arrow config as outside near d1, but different leader line.
        // |---->|<----X
        <>
          <Arrowhead tip={[d1x, d1y]} from={[d1x - udirX, d1y - udirY]} color={color} />
          <ArrowTail origin={[d1x, d1y]} dir={[-udirX, -udirY]} color={color} />
          <Arrowhead tip={[d2x, d2y]} from={[d2x + udirX, d2y + udirY]} color={color} />
          <ArrowTail origin={[d2x, d2y]} dir={[udirX, udirY]} color={color} />
          <Line points={[[d2x, d2y, 0], [labelX, labelY, 0]]} color={color} lineWidth={1} />
        </>
      )}
      {!isDragged && (
        <mesh ref={meshRef} position={[labelX, labelY, 0.001]} onPointerOver={onOver} onPointerOut={onOut} onClick={onClick} onPointerDown={onPointerDown}>
          <circleGeometry args={[1, 8]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
      )}
      <Html position={[labelX, labelY, 0.001]} center style={{ pointerEvents: 'none' }}>
        <div style={{ color, fontSize: 14, fontFamily: 'monospace', background: '#111', padding: '0 5px', borderRadius: 2, whiteSpace: 'nowrap' }}>
          {label}
        </div>
      </Html>
    </group>
  )
}
