import { useMemo, useEffect } from 'react'
import * as THREE from 'three'
import type { Mesh3D, EdgeData } from '../../types/cad'
import { useSketchEditorStore } from '../../stores/sketchEditorStore'
import {
  COLOR_BODY_DEFAULT,
  COLOR_BODY_HOVER, COLOR_BODY_SELECTED,
  COLOR_BODY_EDGE, COLOR_BODY_EDGE_SEL,
  ARC_SEGMENTS,
} from './constants'

interface Body3DProps {
  featureId: string
  mesh: Mesh3D
  edges?: EdgeData[]
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

// Build a flat Float32Array of line segment endpoints from edge descriptors.
// Each segment contributes 6 floats: [x0,y0,z0, x1,y1,z1].
// eslint-disable-next-line react-refresh/only-export-components
export function buildEdgeSegments(edges: EdgeData[]): Float32Array {
  const parts: number[] = []

  for (const edge of edges) {
    if (edge.kind === 'line') {
      parts.push(...edge.start, ...edge.end)
    } else if (edge.kind === 'circle' || edge.kind === 'arc') {
      const { center, radius, x_axis, axis, angle_start, angle_end } = edge
      const sweep = angle_end - angle_start
      // Proportional segment count, at least 2, max ARC_SEGMENTS for full circle.
      const segs = Math.max(2, Math.round(ARC_SEGMENTS * Math.abs(sweep) / (2 * Math.PI)))

      // Orthonormal basis: u = x_axis, v = axis cross u (right-hand y of the circle plane).
      const ux = x_axis[0], uy = x_axis[1], uz = x_axis[2]
      const ax = axis[0],   ay = axis[1],   az = axis[2]
      // v = axis cross x_axis
      const vx = ay * uz - az * uy
      const vy = az * ux - ax * uz
      const vz = ax * uy - ay * ux

      const cx = center[0], cy = center[1], cz = center[2]

      let prevX = cx + radius * (Math.cos(angle_start) * ux + Math.sin(angle_start) * vx)
      let prevY = cy + radius * (Math.cos(angle_start) * uy + Math.sin(angle_start) * vy)
      let prevZ = cz + radius * (Math.cos(angle_start) * uz + Math.sin(angle_start) * vz)

      for (let i = 1; i <= segs; i++) {
        const t = angle_start + sweep * (i / segs)
        const nx = cx + radius * (Math.cos(t) * ux + Math.sin(t) * vx)
        const ny = cy + radius * (Math.cos(t) * uy + Math.sin(t) * vy)
        const nz = cz + radius * (Math.cos(t) * uz + Math.sin(t) * vz)
        parts.push(prevX, prevY, prevZ, nx, ny, nz)
        prevX = nx; prevY = ny; prevZ = nz
      }
    } else if (edge.kind === 'spline') {
      const pts = edge.points
      for (let i = 0; i < pts.length - 1; i++) {
        parts.push(...pts[i], ...pts[i + 1])
      }
    }
  }

  return new Float32Array(parts)
}

export default function Body3D({ featureId, mesh, edges = [], visible = true }: Body3DProps) {
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

  const edgeGeometry = useMemo(() => {
    const geo = new THREE.BufferGeometry()
    const pts = buildEdgeSegments(edges)
    geo.setAttribute('position', new THREE.BufferAttribute(pts, 3))
    return geo
  }, [edges])

  useEffect(() => {
    return () => { edgeGeometry.dispose() }
  }, [edgeGeometry])

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
          setHoveredBodyId(current => current === featureId ? null : current)
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
      {edges.length > 0 && (
        <lineSegments geometry={edgeGeometry}>
          <lineBasicMaterial color={edgeColor} />
        </lineSegments>
      )}
    </group>
  )
}
