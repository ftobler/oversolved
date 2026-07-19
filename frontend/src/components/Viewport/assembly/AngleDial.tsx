// The protractor the triad grows while a rotation ring is being dragged: ticks
// every snap step, a datum line where the drag started, a live line where it is
// now, the wedge between them and a numeric readout.
//
// A thin renderer. Every position, the dial's own counter-rotation, the wrapping
// decision for sweeps past a full turn and the readout's wording live in
// utils/angleDialGeometry.ts, so the dial stays testable without a viewport.
//
// Drawn with `depthTest: false` and a renderOrder above the triad's, matching
// the gizmo it annotates: the dial sits at the part's origin, usually inside the
// solid, and would otherwise be swallowed by the body it is measuring.

import { useMemo } from 'react'
import { Billboard, Line, Text } from '@react-three/drei'
import * as THREE from 'three'
import {
  DIAL_READOUT_RADIUS, dialCounterRotation, dialReadoutPosition, dialSpoke, dialSweepVertices,
  dialTicks, formatSwingDegrees, nearestTickIndex,
} from '@/utils/angleDialGeometry'
import type { GizmoAxisDef } from '@/utils/gizmoPickGeometry'

const DATUM_COLOR = '#9aa0a6'
const LIVE_COLOR = '#ffffff'
const SNAP_COLOR = '#ffd24a'
const TICK_COLOR = '#9aa0a6'
const SWEEP_OPACITY = 0.22

const RENDER_ORDER = 1001
const READOUT_SIZE = DIAL_READOUT_RADIUS * 0.2

interface AngleDialProps {
  def: GizmoAxisDef
  /** Bearing the sweep is read from, a quarter turn, measured from `def.u`. */
  datum: number
  /** The snapped swing the part is receiving, unwrapped and unbounded. */
  swing: number
  snapped: boolean
}

export default function AngleDial({ def, datum, swing, snapped }: AngleDialProps) {
  const ticks = useMemo(() => dialTicks(def), [def])
  const sweep = useMemo(() => dialSweepVertices(def, datum, swing), [def, datum, swing])
  const datumLine = useMemo(() => dialSpoke(def, datum), [def, datum])
  const liveLine = useMemo(() => dialSpoke(def, datum + swing), [def, datum, swing])
  const readoutAt = dialReadoutPosition(def, datum, swing)
  // The group TriadGizmo nests this in carries the live drag, so without taking
  // that swing back out the dial would ride round with the part it is measuring:
  // see dialCounterRotation. This is what makes the dial a protractor.
  const counterRotation = useMemo(() => dialCounterRotation(def, swing), [def, swing])

  // While snapped the live line lands exactly on a tick, so lighting that tick
  // up as well makes the click visible even when the line covers it.
  const litTick = snapped ? nearestTickIndex(datum + swing) : -1

  return (
    <group renderOrder={RENDER_ORDER} quaternion={counterRotation}>
      <mesh renderOrder={RENDER_ORDER}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[sweep, 3]} />
        </bufferGeometry>
        <meshBasicMaterial
          color={snapped ? SNAP_COLOR : LIVE_COLOR}
          transparent
          opacity={SWEEP_OPACITY}
          side={THREE.DoubleSide}
          depthTest={false}
          depthWrite={false}
        />
      </mesh>

      {ticks.map((tick, i) => (
        <Line
          key={tick.angle}
          points={[tick.start, tick.end]}
          color={i === litTick ? SNAP_COLOR : TICK_COLOR}
          lineWidth={tick.major ? 2 : 1}
          depthTest={false}
          transparent
          renderOrder={RENDER_ORDER}
        />
      ))}

      <Line
        points={datumLine}
        color={DATUM_COLOR}
        lineWidth={1.5}
        dashed
        dashSize={0.05}
        gapSize={0.04}
        depthTest={false}
        transparent
        renderOrder={RENDER_ORDER}
      />
      <Line
        points={liveLine}
        color={snapped ? SNAP_COLOR : LIVE_COLOR}
        lineWidth={snapped ? 3 : 2}
        depthTest={false}
        transparent
        renderOrder={RENDER_ORDER}
      />

      {/* Billboarded because the dial lies in the ring's plane, which the user
          is often looking at edge-on; the readout has to stay legible there. */}
      <Billboard position={readoutAt}>
        <Text
          fontSize={READOUT_SIZE}
          anchorX="center"
          anchorY="middle"
          renderOrder={RENDER_ORDER}
        >
          {formatSwingDegrees(swing)}
          <meshBasicMaterial
            color={snapped ? SNAP_COLOR : LIVE_COLOR}
            depthTest={false}
            transparent
            toneMapped={false}
          />
        </Text>
      </Billboard>
    </group>
  )
}
