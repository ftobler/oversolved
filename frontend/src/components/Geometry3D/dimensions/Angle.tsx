import { useRef, useCallback } from 'react'
import { Line, Html } from '@react-three/drei'
import { useThree, useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { p2w, sampleArc } from '@/components/sketch_helpers'
import { Arrowhead, ArcTail, ExtensionLine } from './primitives'
import { useDimInteraction, useActiveLabelDrag } from './useDimInteraction'
import type { DimInteraction } from './useDimInteraction'
import { useDimensionLabelIdRegistration } from '@/picking/useDimensionLabelIdRegistration'
import { useDimDispatchRegistration } from './useDimDispatchRegistration'
import { computeAngleDimension } from './angleDimensionLogic'
import type { PlaneTransform } from '@/types/cad'

export function AngleDimension({ cid, dim, interaction, planeTransform }: {
  cid: string
  dim: { kind: string; p1: [number, number]; p2: [number, number]; p3: [number, number]; p4: [number, number]; value: number; pos?: [number, number] }
  interaction?: DimInteraction
  planeTransform?: PlaneTransform
}) {
  const { color, onOver, onOut, onClick, onDoubleClick, resetDragMoved, isDragged } = useDimInteraction(cid, dim.value, interaction, false)
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
    vx, vy, arcR, a0deg, a1deg, arcSpan, labelAngleDeg, labelX, labelY, isInside, extendFromStart,
  } = computeAngleDimension(dim.p1, dim.p2, dim.p3, dim.p4, effectivePos)

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

  // Outside: draw a solid arc extension from the nearer arc endpoint to the label.
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
      anchorWorld: [vx, vy],
      startWorld: [labelX, labelY],
    })
  }, [interaction, cid, vx, vy, labelX, labelY, resetDragMoved, setOrbitEnabled, setIsPointerDown, setDragStartClient, setDragPending])

  useDimDispatchRegistration(cid, { onOver, onOut, onClick, onDoubleClick, onPointerDown })

  return (
    <group key={cid}>
      {/* Radial witness lines connecting the measured segments to the arc */}
      {witnessAStart && <ExtensionLine start={witnessAStart} end={[arcStartPt[0], arcStartPt[1]]} color={color} />}
      {witnessBStart && <ExtensionLine start={witnessBStart} end={[arcEndPt[0], arcEndPt[1]]} color={color} />}

      {/* Arc spanning the angle */}
      <Line points={arcPts} color={color} lineWidth={1} depthTest={false} />

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
            <Line points={extArcPts} color={color} lineWidth={1} depthTest={false} />
          )}
          <Arrowhead tip={[arcStartPt[0], arcStartPt[1]]} from={[arcStartPt[0] - tanStartInX, arcStartPt[1] - tanStartInY]} color={color} />
          <ArcTail cx={vx} cy={vy} radius={arcR} startAngleDeg={a0deg} sign={-arcSign} color={color} />
          <Arrowhead tip={[arcEndPt[0],   arcEndPt[1]  ]} from={[arcEndPt[0]   - tanEndInX,   arcEndPt[1]   - tanEndInY  ]} color={color} />
          <ArcTail cx={vx} cy={vy} radius={arcR} startAngleDeg={a1deg} sign={arcSign} color={color} />
        </>
      )}

      {/* Interaction hit area */}
      {!isDragged && (
        <mesh ref={meshRef} position={[labelX, labelY, 0.001]}>
          <circleGeometry args={[1, 8]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
      )}

      {/* Label text */}
      <Html position={[labelX, labelY, 0.001]} center style={{ pointerEvents: 'none' }}>
        <div style={{ color, fontSize: 14, fontFamily: 'monospace', background: '#111', padding: '0 5px', borderRadius: 2, whiteSpace: 'nowrap', userSelect: 'none', WebkitUserSelect: 'none' }}>
          {label}
        </div>
      </Html>
    </group>
  )
}
