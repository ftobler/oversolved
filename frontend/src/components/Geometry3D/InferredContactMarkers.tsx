import { useRef } from 'react'
import { Line } from '@react-three/drei'
import { useThree, useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import type { Sketch, PartConstraint, Topology } from '@/types/cad'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { p2w } from '@/components/sketch/sketch_helpers'
import { COLOR_SNAP, COLOR_HOVER, COLOR_SELECTED } from '@/components/Geometry3D/constants'
import { applyWorldBillboard } from '@/components/Geometry3D/billboard'
import { inferredContactCandidates } from '@/components/Geometry3D/snapDetection'

// A hollow ring drawn at constant pixel size, billboarded to face the camera.
// Hollow (not a filled dot) signals "inferred, not yet a real point" -- it is a
// dock contact you can hover/snap to, materialized only when constrained.
const RING_PTS: [number, number, number][] = Array.from({ length: 17 }, (_, i) => {
  const t = (i / 16) * Math.PI * 2
  return [Math.cos(t), Math.sin(t), 0]
})

function DockRing({ x, y, px, id }: { x: number; y: number; px: number; id: string }) {
  const groupRef = useRef<THREE.Group>(null)
  const { camera } = useThree()
  // The contact picks via the vertex ID layer, so hover lands on hoveredVertexId
  // and click toggles the handle into normalSelection (see useSketchIdRegistration).
  const hovered = useSketchEditorStore(s => s.hoveredVertexId === id)
  const selected = useSketchEditorStore(s => s.normalSelection.has(id))
  const color = hovered ? COLOR_HOVER : selected ? COLOR_SELECTED : COLOR_SNAP
  useFrame(() => {
    if (!groupRef.current) return
    groupRef.current.scale.setScalar((hovered ? px + 1 : px) * p2w(camera))
    applyWorldBillboard(groupRef.current, camera)
  })
  return (
    <group ref={groupRef} position={[x, y, 0]}>
      <Line points={RING_PTS} color={color} lineWidth={hovered || selected ? 2 : 1.5} />
    </group>
  )
}

/** Persistent markers for the inferred-point set: dockable-host contacts
 *  (tangencies) UNION free curve-curve intersections. Visual-only: a contact is
 *  "just there to hover, snap to, and pick out of the soup" and stays inferred
 *  until constrained (lazy inferred materialization). Each marker disappears once
 *  materialized -- `dockHostsOf` omits docked hosts and `sketchToIntersectionCandidates`
 *  omits intersections that coincide with a real point, the materialized point's
 *  VertexDot standing in. Picking is via the vertex ID layer
 *  (`useSketchIdRegistration`), which carries the same `dock:`/`isect:` handles. */
export function InferredContactMarkers({ sketch, featureId, constraints, topology }: {
  sketch?: Sketch
  featureId: string
  constraints?: PartConstraint[]
  topology?: Topology
}) {
  if (!sketch) return null
  const candidates = inferredContactCandidates(sketch, featureId, constraints ?? [], topology, 'active_sketch')
  if (candidates.length === 0) return null
  return (
    <>
      {candidates.map(c => (
        <DockRing key={c.id} id={c.id} x={c.position[0]} y={c.position[1]} px={4} />
      ))}
    </>
  )
}
