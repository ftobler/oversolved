import { useMemo, useEffect, useState, useCallback, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import type { Mesh3D, EdgeData } from '../../types/cad'
import { useSketchEditorStore } from '../../stores/sketchEditorStore'
import { p2w } from '../sketch_helpers'
import {
  COLOR_BODY_DEFAULT,
  COLOR_BODY_HOVER, COLOR_BODY_SELECTED,
  COLOR_BODY_EDGE, COLOR_BODY_EDGE_SEL,
  COLOR_SELECTED, COLOR_HOVER,
  ARC_SEGMENTS,
  HIT_PIXELS, POINT_HIT_PIXELS,
} from './constants'

interface Body3DProps {
  featureId: string
  mesh: Mesh3D
  edges?: EdgeData[]
  edgeQueries?: string[]
  vertices?: [number, number, number][]
  vertexQueries?: string[]
  visible?: boolean
  showDebugHit?: boolean
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

export default function Body3D({ featureId, mesh, edges = [], edgeQueries, vertices, vertexQueries, visible = true, showDebugHit = false }: Body3DProps) {
  const hoveredBodyId = useSketchEditorStore(s => s.hoveredBodyId)
  const hoveredSurfaceId = useSketchEditorStore(s => s.hoveredSurfaceId)
  const normalSelection = useSketchEditorStore(s => s.normalSelection)
  const isRotating = useSketchEditorStore(s => s.isRotating)
  const setHoveredBodyId = useSketchEditorStore(s => s.setHoveredBodyId)
  const setHoveredSurface = useSketchEditorStore(s => s.setHoveredSurface)
  const toggleNormalSelection = useSketchEditorStore(s => s.toggleNormalSelection)

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

  // Check if a specific edge is selected, using stable query when available
  const getIsEdgeSelected = useCallback((edgeIndex: number): boolean => {
    if (edgeQueries?.[edgeIndex]) return normalSelection.has(edgeQueries[edgeIndex])
    return normalSelection.has(`@${featureId}/edge/${edgeIndex}`)
  }, [normalSelection, featureId, edgeQueries])

  const geometry = useMemo(() => {
    const indexed = new THREE.BufferGeometry()
    const { positions, indices } = buildBodyGeometry(mesh)
    indexed.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    indexed.setIndex(new THREE.BufferAttribute(indices, 1))
    indexed.computeVertexNormals()
    // toNonIndexed gives each triangle its own vertex slots so faceColors[i*9..i*9+8]
    // maps 1:1 to face i without bleeding into shared-vertex neighbors.
    const geo = indexed.toNonIndexed()
    indexed.dispose()
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
  const handleEdgeClick = useCallback((e: { stopPropagation: () => void; nativeEvent?: Event }) => {
    e.stopPropagation()
    const nativeEvent = e.nativeEvent as MouseEvent | undefined
    const isMultiSelect = nativeEvent?.ctrlKey || nativeEvent?.metaKey

    // R3F ThreeEvent spreads THREE.Intersection directly: e.index is the vertex index
    // in the LineSegments buffer. Divide by 2 to get segment index.
    const rawIndex = (e as unknown as { index?: number }).index
    let edgeIndex: number | undefined
    if (rawIndex !== undefined) {
      edgeIndex = segmentToEdgeMap[Math.floor(rawIndex / 2)]
    } else {
      edgeIndex = hoveredEdgeIndex ?? undefined
    }

    if (edgeIndex !== undefined) {
      const query = edgeQueries?.[edgeIndex] ?? `@${featureId}/edge/${edgeIndex}`
      if (isMultiSelect) {
        toggleNormalSelection(query)
      } else {
        toggleNormalSelection(query)
      }
    }
  }, [featureId, edgeQueries, segmentToEdgeMap, hoveredEdgeIndex, toggleNormalSelection])

  // Compute color attribute for faces if any are selected or hovered.
  // Uses hoveredSurfaceId (query string) so all triangles of a B-rep face highlight together.
  const faceColors = useMemo(() => {
    const hasSelection = mesh.faces.some((_, i) => getIsFaceSelected(i))
    const hasHover = hoveredSurfaceId !== null
    if (!hasSelection && !hasHover) return null

    const colors = new Float32Array(mesh.faces.length * 3 * 3)
    const defaultColor = new THREE.Color(bodyColor)
    const selectedColor = new THREE.Color(COLOR_SELECTED)
    const hoverColor = new THREE.Color(COLOR_HOVER)

    for (let i = 0; i < mesh.faces.length; i++) {
      let color = defaultColor
      const query = resolveFaceQuery(i)
      if (normalSelection.has(query)) {
        color = selectedColor
      } else if (query === hoveredSurfaceId) {
        color = hoverColor
      }

      const baseIdx = i * 9
      for (let v = 0; v < 9; v += 3) {
        colors[baseIdx + v] = color.r
        colors[baseIdx + v + 1] = color.g
        colors[baseIdx + v + 2] = color.b
      }
    }
    return colors
  }, [mesh.faces, normalSelection, hoveredSurfaceId, bodyColor, resolveFaceQuery])

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

  const vertexMeshRef = useRef<THREE.InstancedMesh>(null)

  // Reusable objects to avoid per-frame allocation
  const _vtxPos = useMemo(() => new THREE.Vector3(), [])
  const _vtxQuat = useMemo(() => new THREE.Quaternion(), [])  // identity
  const _vtxScale = useMemo(() => new THREE.Vector3(), [])
  const _vtxMatrix = useMemo(() => new THREE.Matrix4(), [])

  useFrame(({ camera, raycaster }) => {
    // Scale Line raycaster threshold to match HIT_PIXELS in screen space.
    // Without this, LineSegments hit detection uses a fixed world-unit threshold
    // that doesn't track camera zoom.
    raycaster.params.Line = { threshold: HIT_PIXELS * p2w(camera) }

    const vmesh = vertexMeshRef.current
    if (!vmesh || !vertices?.length) return

    // Scale vertex spheres to POINT_HIT_PIXELS screen radius (same as 2D vertex dots).
    const s = POINT_HIT_PIXELS * p2w(camera)
    _vtxScale.set(s, s, s)

    vertices.forEach(([x, y, z], i) => {
      _vtxPos.set(x, y, z)
      _vtxMatrix.compose(_vtxPos, _vtxQuat, _vtxScale)
      vmesh.setMatrixAt(i, _vtxMatrix)
    })

    vmesh.instanceMatrix.needsUpdate = true
  })

  return (
    <group visible={visible} userData={{ featureId }}>
      <mesh
        geometry={geometry}
        onPointerOver={(e) => {
          e.stopPropagation()
          if (isRotating) return
          setHoveredBodyId(featureId)
          const faceIndex = (e as unknown as { faceIndex?: number }).faceIndex
          if (faceIndex !== undefined) {
            setHoveredSurface(resolveFaceQuery(faceIndex))
          }
        }}
        onPointerMove={(e) => {
          e.stopPropagation()
          const faceIndex = (e as unknown as { faceIndex?: number }).faceIndex
          if (faceIndex !== undefined) {
            setHoveredSurface(resolveFaceQuery(faceIndex))
          }
        }}
        onPointerOut={(e) => {
          e.stopPropagation()
          setHoveredBodyId(current => current === featureId ? null : current)
          setHoveredSurface(null)
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
            // R3F ThreeEvent spreads THREE.Intersection directly onto e.
            // For LineSegments, e.index is the vertex index of the segment's
            // first vertex (0, 2, 4...). Divide by 2 to get segment index.
            const index = (e as unknown as { index?: number }).index
            if (index !== undefined && index >= 0) {
              const edgeIndex = segmentToEdgeMap[Math.floor(index / 2)]
              if (edgeIndex !== undefined) {
                setHoveredEdgeIndex(edgeIndex)
              }
            }
          }}
          onPointerMove={(e) => {
            e.stopPropagation()
            const index = (e as unknown as { index?: number }).index
            if (index !== undefined && index >= 0) {
              const edgeIndex = segmentToEdgeMap[Math.floor(index / 2)]
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
      {vertices && vertices.length > 0 && (
        <instancedMesh
          ref={vertexMeshRef}
          args={[undefined, undefined, vertices.length]}
          onPointerOver={(e) => { e.stopPropagation() }}
          onPointerOut={(e) => { e.stopPropagation() }}
          onClick={(e) => {
            e.stopPropagation()
            const idx = e.instanceId
            if (idx !== undefined) {
              const query = vertexQueries?.[idx] ?? `@${featureId}/vertex/${idx}`
              toggleNormalSelection(query)
            }
          }}
        >
          {/* Radius 1 — scaled to POINT_HIT_PIXELS screen px by useFrame */}
          <sphereGeometry args={[1, 8, 8]} />
          {/* Invisible normally (opacity 0), orange 25% in debug — matches HitPolyline. */}
          <meshBasicMaterial
            color="#ff6600"
            transparent
            opacity={showDebugHit ? 0.25 : 0}
            depthWrite={false}
          />
        </instancedMesh>
      )}
    </group>
  )
}
