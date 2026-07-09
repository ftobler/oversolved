// A part instance's mesh + analytic edges in the assembly scene. Deliberately
// not Body3D: that component registers face/edge/vertex ID layers and reads
// sketchEditorStore, both of which are part-editor concerns. Assembly picking is
// anchor-based and arrives with Stage 7; until then a body is a shaded mesh that
// can be grabbed and dragged.
//
// The edges are the "B-rep feeling" (tier 1): sampled from the bundle's analytic
// curves rather than pulled off the tessellation, so a hole's rim stays a circle
// at any zoom while its face is still a facetted mesh.

import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import type { ThreeEvent } from '@react-three/fiber'
import type { BodyRenderItem } from '@/components/Viewport/bodyUtils'
import { buildBodyGeometry } from '@/components/Geometry3D/bodyGeometry'
import {
  COLOR_BODY_DEFAULT,
  COLOR_BODY_EDGE,
  COLOR_BODY_EDGE_SEL,
  COLOR_BODY_SELECTED,
  DEFAULT_PART_ROUGHNESS,
  RENDER_ORDER_DEFAULT,
} from '@/components/Geometry3D/constants'
import { ENV_MAP_INTENSITY } from '@/components/Viewport/EnvLight'
import type { EdgeCurve } from '@/kernel/partBundle'
import { buildCurveSegments } from '@/utils/edgeSampling'
import type { Vec3 } from '@/utils/transform3d'

interface AssemblyBodyProps {
  item: BodyRenderItem
  curves: EdgeCurve[]
  selected: boolean
  onGrab: (point: Vec3, event: ThreeEvent<PointerEvent>) => void
}

export default function AssemblyBody({ item, curves, selected, onGrab }: AssemblyBodyProps) {
  const geometry = useMemo(() => {
    const { positions, indices } = buildBodyGeometry(item.mesh)
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    g.setIndex(new THREE.BufferAttribute(indices, 1))
    // The bundle ships positions only; shading needs normals.
    g.computeVertexNormals()
    return g
  }, [item.mesh])

  useEffect(() => () => geometry.dispose(), [geometry])

  const edgeGeometry = useMemo(() => {
    const pts = buildCurveSegments(curves)
    if (pts.length === 0) return null
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(pts, 3))
    return g
  }, [curves])

  useEffect(() => () => edgeGeometry?.dispose(), [edgeGeometry])

  return (
    <>
      <mesh
        geometry={geometry}
        visible={item.visible}
        userData={{ fitBounds: true }}
        onPointerDown={(e) => {
          if (e.button !== 0) return
          e.stopPropagation()
          onGrab([e.point.x, e.point.y, e.point.z], e)
        }}
      >
        <meshStandardMaterial
          color={selected ? COLOR_BODY_SELECTED : COLOR_BODY_DEFAULT}
          roughness={DEFAULT_PART_ROUGHNESS}
          metalness={0}
          envMapIntensity={ENV_MAP_INTENSITY}
          // Push the surface back so an edge lying exactly on it draws crisp
          // instead of z-fighting, as Body3D does in the part editor.
          polygonOffset
          polygonOffsetFactor={1}
          polygonOffsetUnits={1}
        />
      </mesh>

      {edgeGeometry && (
        <lineSegments geometry={edgeGeometry} visible={item.visible} renderOrder={RENDER_ORDER_DEFAULT}>
          <lineBasicMaterial color={selected ? COLOR_BODY_EDGE_SEL : COLOR_BODY_EDGE} />
        </lineSegments>
      )}
    </>
  )
}
