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

import { Suspense, useMemo } from 'react'
import { Billboard, Line, Text } from '@react-three/drei'
import * as THREE from 'three'
import { LABEL_CHARACTERS, LABEL_FONT } from '@/components/Viewport/labelFont'
import {
  DIAL_READOUT_RADIUS, dialCounterRotation, dialReadoutPosition, dialSpoke, dialSweepVertices,
  dialTicks, formatSwingDegrees, nearestTickIndex,
} from '@/utils/angleDialGeometry'
import type { GizmoAxisDef } from '@/utils/gizmoPickGeometry'

const DATUM_COLOR = '#9aa0a6'
const LIVE_COLOR = '#ffffff'
// Amber, and deliberately not the triad's hover white: snap engagement is a
// different signal from "the cursor is on this handle" and has to stay readable
// as its own thing.
const SNAP_COLOR = '#ffd24a'
const TICK_COLOR = '#9aa0a6'
const SWEEP_OPACITY = 0.22

// Disarmed, the ticks are still drawn but faded almost out: removing them
// entirely would make the dial jump every time the cursor crosses the ring,
// while leaving them lit would advertise bearings the drag can no longer reach.
// Fading says "still there, not in play", which is exactly the state.
const TICK_OPACITY = 1
const TICK_OPACITY_DISARMED = 0.18

const RENDER_ORDER = 1001
const READOUT_SIZE = DIAL_READOUT_RADIUS * 0.2

interface AngleDialProps {
  def: GizmoAxisDef
  /** Bearing the sweep is read from, a quarter turn, measured from `def.u`. */
  datum: number
  /** The snapped swing the part is receiving, unwrapped and unbounded. */
  swing: number
  snapped: boolean
  /**
   * Whether snapping is in play at all: false once the cursor is pulled outside
   * the ring. Distinct from `snapped`, which is only this frame's outcome.
   */
  snapArmed: boolean
}

export default function AngleDial({ def, datum, swing, snapped, snapArmed }: AngleDialProps) {
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
          opacity={snapArmed ? TICK_OPACITY : TICK_OPACITY_DISARMED}
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
        {/* The readout suspends on its font, and R3F gives the whole Canvas a
            single Suspense boundary, so without a local one a cold font would
            blank the entire viewport in the middle of a rotation drag. The
            font args must be the shared ones: they are the suspend key drei
            looks the warm-up up under, and a mismatch here puts this <Text>
            back on a cold entry. See labelFont.ts. */}
        <Suspense fallback={null}>
          <Text
            font={LABEL_FONT}
            characters={LABEL_CHARACTERS}
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
        </Suspense>
      </Billboard>
    </group>
  )
}
