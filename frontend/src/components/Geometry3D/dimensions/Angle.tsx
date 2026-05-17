import { useRef, useCallback } from 'react'
import { Line, Html } from '@react-three/drei'
import { useThree, useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { p2w, sampleArc } from '@/components/sketch_helpers'
import { Arrowhead, ArrowTail } from './primitives'
import { useDimInteraction, useActiveLabelDrag } from './useDimInteraction'
import type { DimInteraction } from './useDimInteraction'
import { useDimensionLabelIdRegistration } from '@/picking/useDimensionLabelIdRegistration'

export function AngleDimension({ cid, dim, interaction }: {
  cid: string
  dim: { kind: string; p1: [number, number]; p2: [number, number]; p3: [number, number]; p4: [number, number]; value: number; pos?: [number, number] }
  interaction?: DimInteraction
}) {
  const { color, onOver, onOut, onClick, resetDragMoved, isDragged } = useDimInteraction(cid, dim.value, interaction, false)
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

  // p1,p2 = line A endpoints; da = p2 - p1 (solver's forward direction of A).
  // p3,p4 = line B endpoints; db = p4 - p3 (solver's forward direction of B).
  // The arc spans from angle_da to angle_db, matching the constrained angle.
  const [ax1, ay1] = dim.p1, [ax2, ay2] = dim.p2  // line A
  const [bx1, by1] = dim.p3, [bx2, by2] = dim.p4  // line B

  const angle1 = Math.atan2(ay2 - ay1, ax2 - ax1)  // direction of da
  const angle2 = Math.atan2(by2 - by1, bx2 - bx1)  // direction of db

  // Find the intersection of the two infinite lines to get the arc origin vertex.
  // Line A: ax1 + t*(ax2-ax1), Line B: bx1 + s*(bx2-bx1)
  // Solve for t using Cramer's rule; fall back to ax2 if lines are parallel.
  const dax = ax2 - ax1, day = ay2 - ay1
  const dbx = bx2 - bx1, dby = by2 - by1
  const cross = dax * dby - day * dbx
  let vx: number, vy: number
  if (Math.abs(cross) > 1e-10) {
    const t = ((bx1 - ax1) * dby - (by1 - ay1) * dbx) / cross
    vx = ax1 + t * dax
    vy = ay1 + t * day
  } else {
    // Parallel lines -- fall back to midpoint of closest endpoints
    vx = (ax2 + bx1) / 2
    vy = (ay2 + by1) / 2
  }

  // For each line, pick the endpoint furthest from the vertex as the extension target.
  const extAx = Math.hypot(ax2 - vx, ay2 - vy) >= Math.hypot(ax1 - vx, ay1 - vy) ? ax2 : ax1
  const extAy = Math.hypot(ax2 - vx, ay2 - vy) >= Math.hypot(ax1 - vx, ay1 - vy) ? ay2 : ay1
  const extBx = Math.hypot(bx2 - vx, by2 - vy) >= Math.hypot(bx1 - vx, by1 - vy) ? bx2 : bx1
  const extBy = Math.hypot(bx2 - vx, by2 - vy) >= Math.hypot(bx1 - vx, by1 - vy) ? by2 : by1

  const effectivePos: [number, number] | undefined = activeDragPos
    ? [activeDragPos[0] - vx, activeDragPos[1] - vy]
    : dim.pos

  const a0deg = angle1 * (180 / Math.PI)
  const a1deg = angle2 * (180 / Math.PI)

  // arcSpan matches sampleArc: always takes the shorter arc path.
  // Positive = CCW, negative = CW.
  let arcSpan = ((a1deg - a0deg) + 360) % 360
  if (arcSpan > 180) arcSpan -= 360

  // arcR is the distance from vertex to label. The label always sits ON the arc circle,
  // either within the angle span (inside) or on the radial extension (outside).
  let arcR: number, labelAngleDeg: number
  if (effectivePos) {
    arcR = Math.hypot(effectivePos[0], effectivePos[1]) || 1e-6
    labelAngleDeg = Math.atan2(effectivePos[1], effectivePos[0]) * (180 / Math.PI)
  } else {
    const rA = Math.hypot(extAx - vx, extAy - vy)
    const rB = Math.hypot(extBx - vx, extBy - vy)
    arcR = Math.min(rA, rB) * 0.4
    // Default: midpoint of the shorter arc span
    labelAngleDeg = a0deg + arcSpan / 2
  }

  // Label position is always on the arc circle at its angle.
  const labelRad = labelAngleDeg * (Math.PI / 180)
  const labelX = vx + arcR * Math.cos(labelRad)
  const labelY = vy + arcR * Math.sin(labelRad)

  // Determine inside/outside: must match sampleArc's shorter-path direction.
  // relLabel is how far CCW the label is from a0.
  // ASCII visualizations (arc between the two lines, vertex at V):
  //   Inside angle:    V---arc--|<---X--->|--arc---V
  //     Label on arc between endpoints; arrows at arc ends point outward (away from vertex).
  //   Outside angle:   X===arc extension===|---arc---|
  //     Label past an arc end on the extension; arrows at arc ends point inward (toward vertex).
  const relLabel = ((labelAngleDeg - a0deg) + 360) % 360
  const isInside = arcSpan >= 0
    ? relLabel <= arcSpan  // CCW arc: inside if label is within [a0, a0+span]
    : relLabel >= (360 + arcSpan)  // CW arc: inside if label is within [a0+span, a0] (wrapping)

  // Arc from a0 to a1 at arcR.
  const arcPts = sampleArc(vx, vy, arcR, a0deg, a1deg)
  const arcStartPt: [number, number, number] = [vx + arcR * Math.cos(angle1), vy + arcR * Math.sin(angle1), 0]
  const arcEndPt: [number, number, number] = [vx + arcR * Math.cos(angle2), vy + arcR * Math.sin(angle2), 0]

  // Outside: find which arc endpoint is angularly closer to the label,
  // then draw a dashed arc extension from that endpoint to the label.
  const angDiff = (a: number, b: number) => { const d = ((a - b) + 360) % 360; return Math.min(d, 360 - d) }
  const extendFromStart = !isInside && angDiff(labelAngleDeg, a0deg) < angDiff(labelAngleDeg, a1deg)
  const extArcPts = isInside ? null : sampleArc(
    vx, vy, arcR,
    extendFromStart ? a0deg : a1deg,
    labelAngleDeg,
  )

  // Arc tangent directions at each endpoint (unit tangent in arc travel direction).
  // Forward tangent at angle th: (-sin(th), cos(th)) * sign where sign = +1 CCW, -1 CW.
  const arcSign = arcSpan >= 0 ? 1 : -1
  const a0r = angle1, a1r = angle2
  // Tangent pointing INTO the arc span at each endpoint:
  //   arcStart: forward arc direction (into span)
  //   arcEnd:   backward arc direction (into span from the end)
  const tanStartInX = -Math.sin(a0r) * arcSign, tanStartInY = Math.cos(a0r) * arcSign
  const tanEndInX   =  Math.sin(a1r) * arcSign, tanEndInY   = -Math.cos(a1r) * arcSign

  const label = `${dim.value % 1 === 0 ? dim.value : dim.value.toFixed(1)}°`

  useDimensionLabelIdRegistration({
    constraintId: cid,
    position: [labelX, labelY, 0.001],
    enabled: !isDragged,
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
      anchorWorld: [vx, vy],
      startWorld: [labelX, labelY],
    })
  }, [interaction, cid, vx, vy, labelX, labelY, resetDragMoved, setOrbitEnabled, setIsPointerDown, setDragStartClient, setDragPending])

  return (
    <group key={cid}>
      {/* Arc spanning the angle */}
      <Line points={arcPts} color={color} lineWidth={1} />

      {isInside ? (
        // Inside: arrows tangent to arc at endpoints, pointing OUTWARD (away from span)
        // |<---arc-X-arc--->|
        <>
          <Arrowhead tip={[arcStartPt[0], arcStartPt[1]]} from={[arcStartPt[0] + tanStartInX, arcStartPt[1] + tanStartInY]} color={color} />
          <Arrowhead tip={[arcEndPt[0],   arcEndPt[1]  ]} from={[arcEndPt[0]   + tanEndInX,   arcEndPt[1]   + tanEndInY  ]} color={color} />
        </>
      ) : (
        // Outside: solid arc extension from nearest endpoint to label,
        // arrows tangent to arc at endpoints pointing INTO the span
        // X---arc extension---|---arc---|
        <>
          {extArcPts && extArcPts.length >= 2 && (
            <Line points={extArcPts} color={color} lineWidth={1} />
          )}
          <Arrowhead tip={[arcStartPt[0], arcStartPt[1]]} from={[arcStartPt[0] - tanStartInX, arcStartPt[1] - tanStartInY]} color={color} />
          <ArrowTail origin={[arcStartPt[0], arcStartPt[1]]} dir={[-tanStartInX, -tanStartInY]} color={color} />
          <Arrowhead tip={[arcEndPt[0],   arcEndPt[1]  ]} from={[arcEndPt[0]   - tanEndInX,   arcEndPt[1]   - tanEndInY  ]} color={color} />
          <ArrowTail origin={[arcEndPt[0], arcEndPt[1]]} dir={[-tanEndInX, -tanEndInY]} color={color} />
        </>
      )}

      {/* Interaction hit area */}
      {!isDragged && (
        <mesh ref={meshRef} position={[labelX, labelY, 0.001]} onPointerOver={onOver} onPointerOut={onOut} onClick={onClick} onPointerDown={onPointerDown}>
          <circleGeometry args={[1, 8]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
      )}

      {/* Label text */}
      <Html position={[labelX, labelY, 0.001]} center style={{ pointerEvents: 'none' }}>
        <div style={{ color, fontSize: 18, fontFamily: 'monospace', background: '#111', padding: '0 6px', borderRadius: 2, whiteSpace: 'nowrap' }}>
          {label}
        </div>
      </Html>
    </group>
  )
}
