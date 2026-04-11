import { useMemo, useEffect } from 'react'
import * as THREE from 'three'
import type { Mesh3D } from '../../types/cad'
import { useSketchEditorStore } from '../../stores/sketchEditorStore'
import {
  COLOR_BODY_DEFAULT, COLOR_BODY_EDGE,
  COLOR_BODY_HOVER, COLOR_BODY_SELECTED, COLOR_BODY_EDGE_SEL,
} from './constants'

interface Body3DProps {
  featureId: string
  mesh: Mesh3D
  visible?: boolean
}

// Export for unit testing without a WebGL context.
// eslint-disable-next-line react-refresh/only-export-components
export function buildBodyGeometry(mesh: Mesh3D): {
  positions: Float32Array
  indices: Uint32Array
} {
  const positions = new Float32Array(mesh.vertices.length * 3)
  mesh.vertices.forEach(([x, y, z], i) => {
    positions[i * 3] = x; positions[i * 3 + 1] = y; positions[i * 3 + 2] = z
  })
  const indices = new Uint32Array(mesh.faces.length * 3)
  mesh.faces.forEach(([a, b, c], i) => {
    indices[i * 3] = a; indices[i * 3 + 1] = b; indices[i * 3 + 2] = c
  })
  return { positions, indices }
}

export default function Body3D({ featureId, mesh, visible = true }: Body3DProps) {
  const hoveredBodyId = useSketchEditorStore(s => s.hoveredBodyId)
  const normalSelection = useSketchEditorStore(s => s.normalSelection)
  const isRotating = useSketchEditorStore(s => s.isRotating)
  const setHoveredBodyId = useSketchEditorStore(s => s.setHoveredBodyId)
  const toggleNormalSelection = useSketchEditorStore(s => s.toggleNormalSelection)

  const isHovered = hoveredBodyId === featureId
  const isSelected = normalSelection.has('@' + featureId)

  const geometry = useMemo(() => {
    const geo = new THREE.BufferGeometry()
    const { positions, indices } = buildBodyGeometry(mesh)
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geo.setIndex(new THREE.BufferAttribute(indices, 1))
    geo.computeVertexNormals()
    return geo
  }, [mesh])

  useEffect(() => {
    return () => { geometry.dispose() }
  }, [geometry])

  const edgeGeo = useMemo(() => new THREE.EdgesGeometry(geometry, 30), [geometry])
  // 30 degree threshold - only render edges between faces meeting at >30 degrees

  useEffect(() => {
    return () => { edgeGeo.dispose() }
  }, [edgeGeo])

  const bodyColor = isSelected
    ? COLOR_BODY_SELECTED
    : isHovered ? COLOR_BODY_HOVER : COLOR_BODY_DEFAULT
  const edgeColor = isSelected ? COLOR_BODY_EDGE_SEL : COLOR_BODY_EDGE

  return (
    <group visible={visible} userData={{ featureId }}>
      <mesh
        geometry={geometry}
        onPointerOver={(e) => {
          e.stopPropagation()
          if (isRotating) return
          setHoveredBodyId(featureId)
        }}
        onPointerOut={(e) => {
          e.stopPropagation()
          // Functional update avoids stale closure over hoveredBodyId.
          setHoveredBodyId(hoveredBodyId === featureId ? null : hoveredBodyId)
        }}
        onClick={(e) => {
          e.stopPropagation()
          toggleNormalSelection('@' + featureId)
        }}
      >
        <meshStandardMaterial
          color={bodyColor}
          roughness={0.6}
          metalness={0.1}
          side={THREE.DoubleSide}
        />
      </mesh>
      <lineSegments geometry={edgeGeo}>
        <lineBasicMaterial color={edgeColor} linewidth={1} />
      </lineSegments>
    </group>
  )
}
