import { useMemo, useEffect, useState, useCallback } from 'react'
import * as THREE from 'three'
import type { Mesh3D, EdgeData } from '../../types/cad'
import { useSketchEditorStore } from '../../stores/sketchEditorStore'
import {
  COLOR_BODY_DEFAULT,
  COLOR_BODY_HOVER, COLOR_BODY_SELECTED,
  COLOR_BODY_EDGE, COLOR_BODY_EDGE_SEL,
  COLOR_SELECTED, COLOR_HOVER,
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

// Get the number of line segments each edge produces.
// Used to map from raycasted segment index back to edge index.
// eslint-disable-next-line react-refresh/only-export-components
export function getEdgeSegmentCounts(edges: EdgeData[]): number[] {
  const counts: number[] = []
  for (const edge of edges) {
    if (edge.kind === 'line') {
      counts.push(1)
    } else if (edge.kind === 'circle' || edge.kind === 'arc') {
      const sweep = edge.angle_end - edge.angle_start
      const segs = Math.max(2, Math.round(ARC_SEGMENTS * Math.abs(sweep) / (2 * Math.PI)))
      counts.push(segs)
    } else if (edge.kind === 'spline') {
      counts.push(Math.max(0, edge.points.length - 1))
    }
  }
  return counts
}

export default function Body3D({ featureId, mesh, edges = [], visible = true }: Body3DProps) {
  const hoveredBodyId = useSketchEditorStore(s => s.hoveredBodyId)
  const normalSelection = useSketchEditorStore(s => s.normalSelection)
  const isRotating = useSketchEditorStore(s => s.isRotating)
  const setHoveredBodyId = useSketchEditorStore(s => s.setHoveredBodyId)
  const toggleNormalSelection = useSketchEditorStore(s => s.toggleNormalSelection)

  const [hoveredFaceIndex, setHoveredFaceIndex] = useState<number | null>(null)
  const [hoveredEdgeIndex, setHoveredEdgeIndex] = useState<number | null>(null)

  const isHovered = hoveredBodyId === featureId
  const isBodySelected = normalSelection.has('@' + featureId)

  // Check if a specific triangle face is selected (resolves to B-rep query when available)
  const getIsFaceSelected = useCallback((triangleIndex: number): boolean => {
    const { triangle_to_face, face_queries } = mesh
    if (triangle_to_face && face_queries) {
      const brepFaceIndex = triangle_to_face[triangleIndex]
      if (brepFaceIndex !== undefined) {
        const query = face_queries[brepFaceIndex]
        if (query !== undefined) return normalSelection.has(query)
      }
    }
    return normalSelection.has(`@${featureId}/face/${triangleIndex}`)
  }, [normalSelection, featureId, mesh])

  // Check if a specific edge is selected
  const getIsEdgeSelected = useCallback((edgeIndex: number): boolean => {
    return normalSelection.has(`@${featureId}/edge/${edgeIndex}`)
  }, [normalSelection, featureId])

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

  // Precompute segment counts for edge index mapping
  const edgeSegmentCounts = useMemo(() => getEdgeSegmentCounts(edges), [edges])

  // Build a map from segment index to edge index for quick lookup
  const segmentToEdgeMap = useMemo(() => {
    const map: number[] = []
    edgeSegmentCounts.forEach((count, edgeIdx) => {
      for (let i = 0; i < count; i++) {
        map.push(edgeIdx)
      }
    })
    return map
  }, [edgeSegmentCounts])

  const bodyColor = isBodySelected
    ? COLOR_BODY_SELECTED
    : isHovered ? COLOR_BODY_HOVER : COLOR_BODY_DEFAULT

  const edgeColor = isBodySelected ? COLOR_BODY_EDGE_SEL : COLOR_BODY_EDGE

  // Resolve a triangle index to a stable B-rep face query, or fall back to triangle-based query.
  const resolveFaceQuery = useCallback((triangleIndex: number): string => {
    const { triangle_to_face, face_queries } = mesh
    if (triangle_to_face && face_queries) {
      const brepFaceIndex = triangle_to_face[triangleIndex]
      if (brepFaceIndex !== undefined) {
        const query = face_queries[brepFaceIndex]
        if (query !== undefined) return query
      }
    }
    return `@${featureId}/face/${triangleIndex}`
  }, [mesh, featureId])

  // Handle face click on the mesh
  const handleMeshClick = useCallback((e: { stopPropagation: () => void; nativeEvent?: Event; faceIndex?: number }) => {
    e.stopPropagation()
    const nativeEvent = e.nativeEvent as MouseEvent | undefined
    const isMultiSelect = nativeEvent?.ctrlKey || nativeEvent?.metaKey

    // Get triangle index from the event - Three.js raycaster provides faceIndex
    const triangleIndex = e.faceIndex
    if (triangleIndex !== undefined && triangleIndex !== null) {
      const query = resolveFaceQuery(triangleIndex)
      if (isMultiSelect) {
        toggleNormalSelection(query)
      } else {
        // Single select: clear other selections and select just this face
        toggleNormalSelection(query)
      }
    } else {
      // Fallback: toggle body selection
      toggleNormalSelection('@' + featureId)
    }
  }, [featureId, resolveFaceQuery, toggleNormalSelection])

  // Handle edge click on line segments
  const handleEdgeClick = useCallback((e: { stopPropagation: () => void; nativeEvent?: Event; intersection?: { index?: number } }) => {
    e.stopPropagation()
    const nativeEvent = e.nativeEvent as MouseEvent | undefined
    const isMultiSelect = nativeEvent?.ctrlKey || nativeEvent?.metaKey

    // For line segments, we need to find which segment was clicked
    // The intersection point can help us determine the closest segment
    const intersection = e.intersection
    const segmentIndex = intersection?.index ?? hoveredEdgeIndex

    if (segmentIndex !== undefined && segmentIndex !== null && segmentIndex >= 0) {
      // Map segment index to edge index
      const edgeIndex = segmentToEdgeMap[segmentIndex]
      if (edgeIndex !== undefined) {
        const query = `@${featureId}/edge/${edgeIndex}`
        if (isMultiSelect) {
          toggleNormalSelection(query)
        } else {
          toggleNormalSelection(query)
        }
      }
    }
  }, [featureId, segmentToEdgeMap, hoveredEdgeIndex, toggleNormalSelection])

  // Compute color attribute for faces if any are selected or hovered
  const faceColors = useMemo(() => {
    const hasSelection = mesh.faces.some((_, i) => getIsFaceSelected(i))
    const hasHover = hoveredFaceIndex !== null
    if (!hasSelection && !hasHover) return null

    const colors = new Float32Array(mesh.faces.length * 3 * 3)  // 3 vertices per face, 3 components per color
    const defaultColor = new THREE.Color(bodyColor)
    const selectedColor = new THREE.Color(COLOR_SELECTED)
    const hoverColor = new THREE.Color(COLOR_HOVER)

    for (let i = 0; i < mesh.faces.length; i++) {
      let color = defaultColor
      if (getIsFaceSelected(i)) {
        color = selectedColor
      } else if (i === hoveredFaceIndex) {
        color = hoverColor
      }

      // Set color for all 3 vertices of this face
      const baseIdx = i * 9
      colors[baseIdx] = color.r
      colors[baseIdx + 1] = color.g
      colors[baseIdx + 2] = color.b
      colors[baseIdx + 3] = color.r
      colors[baseIdx + 4] = color.g
      colors[baseIdx + 5] = color.b
      colors[baseIdx + 6] = color.r
      colors[baseIdx + 7] = color.g
      colors[baseIdx + 8] = color.b
    }
    return colors
  }, [mesh.faces, getIsFaceSelected, hoveredFaceIndex, bodyColor])

  // Build edge colors array for selected/hovered edges
  const edgeColors = useMemo(() => {
    const totalSegments = segmentToEdgeMap.length
    if (totalSegments === 0) return null

    const hasSelection = edges.some((_, i) => getIsEdgeSelected(i))
    const hasHover = hoveredEdgeIndex !== null
    if (!hasSelection && !hasHover) return null

    const colors = new Float32Array(totalSegments * 2 * 3)  // 2 vertices per segment, 3 components per color
    const defaultColor = new THREE.Color(edgeColor)
    const selectedColor = new THREE.Color(COLOR_SELECTED)
    const hoverColor = new THREE.Color(COLOR_HOVER)

    for (let segIdx = 0; segIdx < totalSegments; segIdx++) {
      const edgeIdx = segmentToEdgeMap[segIdx]
      let color = defaultColor
      if (getIsEdgeSelected(edgeIdx)) {
        color = selectedColor
      } else if (edgeIdx === hoveredEdgeIndex) {
        color = hoverColor
      }

      // Set color for both vertices of this segment
      const baseIdx = segIdx * 6
      colors[baseIdx] = color.r
      colors[baseIdx + 1] = color.g
      colors[baseIdx + 2] = color.b
      colors[baseIdx + 3] = color.r
      colors[baseIdx + 4] = color.g
      colors[baseIdx + 5] = color.b
    }
    return colors
  }, [segmentToEdgeMap, edges, getIsEdgeSelected, hoveredEdgeIndex, edgeColor])

  // Apply face colors to geometry when they change
  useEffect(() => {
    if (faceColors) {
      geometry.setAttribute('color', new THREE.BufferAttribute(faceColors, 3))
    } else {
      geometry.deleteAttribute('color')
    }
  }, [geometry, faceColors])

  // Apply edge colors to edge geometry when they change
  useEffect(() => {
    if (edgeColors && edges.length > 0) {
      edgeGeometry.setAttribute('color', new THREE.BufferAttribute(edgeColors, 3))
    } else {
      edgeGeometry.deleteAttribute('color')
    }
  }, [edgeGeometry, edgeColors, edges.length])

  return (
    <group visible={visible} userData={{ featureId }}>
      <mesh
        geometry={geometry}
        onPointerOver={(e) => {
          e.stopPropagation()
          if (isRotating) return
          setHoveredBodyId(featureId)
          // Set hovered face index from intersection
          const faceIndex = (e as unknown as { faceIndex?: number }).faceIndex
          if (faceIndex !== undefined) {
            setHoveredFaceIndex(faceIndex)
          }
        }}
        onPointerMove={(e) => {
          e.stopPropagation()
          // Update hovered face as mouse moves over different faces
          const faceIndex = (e as unknown as { faceIndex?: number }).faceIndex
          if (faceIndex !== undefined) {
            setHoveredFaceIndex(faceIndex)
          }
        }}
        onPointerOut={(e) => {
          e.stopPropagation()
          setHoveredBodyId(current => current === featureId ? null : current)
          setHoveredFaceIndex(null)
        }}
        onClick={handleMeshClick}
      >
        <meshStandardMaterial
          // metallness and roughness of the part material
          color={bodyColor}
          // roughness={0.6}
          // metalness={0.1}
          roughness={0.5}
          metalness={0.1}
          side={THREE.DoubleSide}
          vertexColors={faceColors !== null}
          polygonOffset={true}
          polygonOffsetFactor={1}
          polygonOffsetUnits={1}
        />
      </mesh>
      {edges.length > 0 && (
        <lineSegments
          geometry={edgeGeometry}
          onPointerOver={(e) => {
            e.stopPropagation()
            // Find which segment is being hovered using intersection
            const intersection = (e as unknown as { intersection?: { index?: number } }).intersection
            const index = intersection?.index
            if (index !== undefined && index >= 0) {
              const edgeIndex = segmentToEdgeMap[index]
              if (edgeIndex !== undefined) {
                setHoveredEdgeIndex(edgeIndex)
              }
            }
          }}
          onPointerMove={(e) => {
            e.stopPropagation()
            const intersection = (e as unknown as { intersection?: { index?: number } }).intersection
            const index = intersection?.index
            if (index !== undefined && index >= 0) {
              const edgeIndex = segmentToEdgeMap[index]
              if (edgeIndex !== undefined) {
                setHoveredEdgeIndex(edgeIndex)
              }
            }
          }}
          onPointerOut={(e) => {
            e.stopPropagation()
            setHoveredEdgeIndex(null)
          }}
          onClick={handleEdgeClick}
        >
          <lineBasicMaterial
            color={edgeColor}
            vertexColors={edgeColors !== null}
          />
        </lineSegments>
      )}
    </group>
  )
}
