import { useRef, useCallback } from 'react'
import { Line, Html } from '@react-three/drei'
import { useThree, useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { p2w } from '@/components/sketch_helpers'
import { Arrowhead, ArrowTail, ExtensionLine } from './primitives'
import { useDimInteraction, useActiveLabelDrag } from './useDimInteraction'
import type { DimInteraction } from './useDimInteraction'
import { useDimensionLabelIdRegistration } from '@/picking/useDimensionLabelIdRegistration'
import { useDimDispatchRegistration } from './useDimDispatchRegistration'
import type { PlaneTransform } from '@/types/cad'

export function LinearDimension({ cid, dim, dimOffset, interaction, planeTransform }: {
  cid: string
  dim: { kind: string; p1: [number, number]; p2: [number, number]; normal: [number, number]; value: number; pos?: [number, number]; ext1_line?: [number, number, number, number]; ext2_line?: [number, number, number, number] }
  dimOffset: number
  interaction?: DimInteraction
  planeTransform?: PlaneTransform
}) {
  const { color, onOver, onOut, onClick, onDoubleClick, resetDragMoved, isDragged } = useDimInteraction(cid, dim.value, interaction)
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

  // Extension-line evaluation: each side is evaluated independently.
  // When an entity segment is provided (ext1_line / ext2_line) the extension
  // line is skipped if the dimension-line endpoint projects inside the segment
  // (the dim already touches the entity). Otherwise the line runs from the
  // nearest segment point to the dimension-line endpoint.
  const extEval = (lx1: number, ly1: number, lx2: number, ly2: number, dx: number, dy: number) => {
    const edx = lx2 - lx1, edy = ly2 - ly1
    const elen2 = edx * edx + edy * edy
    if (elen2 < 1e-12) return { skip: true, touchX: lx1, touchY: ly1 } as const
    let t = ((dx - lx1) * edx + (dy - ly1) * edy) / elen2
    t = Math.max(0, Math.min(1, t))
    const nx = lx1 + t * edx, ny = ly1 + t * edy
    const d2 = (dx - nx) * (dx - nx) + (dy - ny) * (dy - ny)
    // If the dim line endpoint projects onto the segment (within fp tolerance),
    // the dimension already crosses the entity -- no extension line needed.
    return d2 < 0.001
      ? { skip: true, touchX: nx, touchY: ny } as const
      : { skip: false, touchX: nx, touchY: ny } as const
  }

  const ext1 = dim.ext1_line ? extEval(dim.ext1_line[0], dim.ext1_line[1], dim.ext1_line[2], dim.ext1_line[3], d1x, d1y) : { skip: false, touchX: x1, touchY: y1 } as const
  const ext2 = dim.ext2_line ? extEval(dim.ext2_line[0], dim.ext2_line[1], dim.ext2_line[2], dim.ext2_line[3], d2x, d2y) : { skip: false, touchX: x2, touchY: y2 } as const

  useDimensionLabelIdRegistration({
    constraintId: cid,
    position: [labelX, labelY, 0.001],
    enabled: !!interaction && !isDragged,
    planeTransform,
  })

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

  useDimDispatchRegistration(cid, { onOver, onOut, onClick: () => {}, onDoubleClick, onPointerDown })

  const handleLabelClick = useCallback((e: React.MouseEvent) => {
    if (!interaction) return
    e.stopPropagation()
    onClick({ stopPropagation: () => {} })
  }, [interaction, onClick])

  return (
    <group key={cid}>
      {!ext1.skip && <ExtensionLine start={[ext1.touchX, ext1.touchY]} end={[d1x, d1y]} color={color} />}
      {!ext2.skip && <ExtensionLine start={[ext2.touchX, ext2.touchY]} end={[d2x, d2y]} color={color} />}
      <Line points={[[d1x, d1y, 0], [d2x, d2y, 0]]} color={color} lineWidth={1} depthTest={false} />
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
          <Line points={[[d1x, d1y, 0], [labelX, labelY, 0]]} color={color} lineWidth={1} depthTest={false} />
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
          <Line points={[[d2x, d2y, 0], [labelX, labelY, 0]]} color={color} lineWidth={1} depthTest={false} />
        </>
      )}
      {!isDragged && (
        <mesh ref={meshRef} position={[labelX, labelY, 0.001]}>
          <circleGeometry args={[1, 8]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
      )}
      <Html position={[labelX, labelY, 0.001]} center style={{ pointerEvents: interaction ? 'auto' : 'none' }}>
        <div
          onClick={handleLabelClick}
          onDoubleClick={(e) => { if (interaction) { e.stopPropagation(); onDoubleClick({ stopPropagation: () => {}, clientX: e.clientX, clientY: e.clientY }) } }}
          onPointerDown={(e) => { if (interaction) { e.stopPropagation(); onPointerDown({ stopPropagation: () => {}, clientX: e.clientX, clientY: e.clientY }) } }}
          style={{ color, fontSize: 14, fontFamily: 'monospace', background: '#111', padding: '0 5px', borderRadius: 2, whiteSpace: 'nowrap', userSelect: 'none', WebkitUserSelect: 'none', cursor: interaction ? 'pointer' : undefined }}
        >
          {label}
        </div>
      </Html>
    </group>
  )
}
