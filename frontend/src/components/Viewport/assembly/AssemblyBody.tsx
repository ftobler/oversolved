// A part instance's mesh in the assembly scene. Deliberately not Body3D: that
// component registers face/edge/vertex ID layers and reads sketchEditorStore,
// both of which are part-editor concerns. Assembly picking is anchor-based and
// arrives with Stage 7; crisp analytic edges arrive with Stage 6e. Until then a
// body is a shaded mesh that can be grabbed and dragged.

import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import type { ThreeEvent } from '@react-three/fiber'
import type { BodyRenderItem } from '@/components/Viewport/bodyUtils'
import { buildBodyGeometry } from '@/components/Geometry3D/bodyGeometry'
import {
  COLOR_BODY_DEFAULT,
  COLOR_BODY_SELECTED,
  DEFAULT_PART_ROUGHNESS,
} from '@/components/Geometry3D/constants'
import { ENV_MAP_INTENSITY } from '@/components/Viewport/EnvLight'
import type { Vec3 } from '@/utils/transform3d'

interface AssemblyBodyProps {
  item: BodyRenderItem
  selected: boolean
  onGrab: (point: Vec3, event: ThreeEvent<PointerEvent>) => void
}

export default function AssemblyBody({ item, selected, onGrab }: AssemblyBodyProps) {
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

  return (
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
      />
    </mesh>
  )
}
