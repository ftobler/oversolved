import { useMemo, useEffect, useState, useCallback, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import type { Mesh3D, EdgeData } from '../../types/cad'
import { useSketchEditorStore } from '../../stores/sketchEditorStore'
import { p2w } from '../sketch_helpers'
import {
  COLOR_BODY_DEFAULT,
  COLOR_BODY_SELECTED,
  COLOR_BODY_EDGE, COLOR_BODY_EDGE_SEL,
  COLOR_SELECTED, COLOR_HOVER,
  ARC_SEGMENTS,
  HIT_PIXELS, POINT_HIT_PIXELS, POINT_VIS_PIXELS,
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
  color?: string
  interactive?: boolean
  ghost?: boolean
}

// Export for unit testing without a WebGL context.
// eslint-disable-next-line react-refresh/only-export-components
export function buildBodyGeometry(mesh: Mesh3D): {
  positions: Float32Array
  indices: Uint32Array
} {
  // Validate mesh data to catch NaN/undefined early before it reaches WebGL.
  const vertCount = mesh.vertices.length
  for (let i = 0; i < vertCount; i++) {
    const v = mesh.vertices[i]
    if (!Array.isArray(v) || v.length !== 3) {
      throw new Error(`Mesh vertex ${i} is not a 3-element array: ${JSON.stringify(v)}`)
    }
    for (let j = 0; j < 3; j++) {
      const coord = v[j]
      if (typeof coord !== 'number' || Number.isNaN(coord) || !Number.isFinite(coord)) {
        throw new Error(`Mesh vertex ${i} has invalid coordinate [${j}]: ${coord}`)
      }
    }
  }
  for (let i = 0; i < mesh.faces.length; i++) {
    const f = mesh.faces[i]
    if (!Array.isArray(f) || f.length !== 3) {
      throw new Error(`Mesh face ${i} is not a 3-element array: ${JSON.stringify(f)}`)
    }
    for (let j = 0; j < 3; j++) {
      const idx = f[j]
      if (typeof idx !== 'number' || idx < 0 || idx >= vertCount || !Number.isInteger(idx)) {
        throw new Error(`Mesh face ${i} has invalid index [${j}]: ${idx} (vertCount=${vertCount})`)
      }
    }
  }

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

// Return line segment positions for the outer boundary of one B-rep face.
// Uses the original indexed mesh: edges shared by two triangles within the same
// face are interior tessellation edges; edges appearing once are on the boundary.
// eslint-disable-next-line react-refresh/only-export-components
export function buildFaceBoundarySegments(mesh: Mesh3D, brepFaceIndex: number): Float32Array {
  const { faces, vertices, triangle_to_face } = mesh
  if (!triangle_to_face) return new Float32Array(0)

  const edgeCount = new Map<string, number>()
  const edgeVerts = new Map<string, [number, number]>()

  for (let i = 0; i < faces.length; i++) {
    if (triangle_to_face[i] !== brepFaceIndex) continue
    const [a, b, c] = faces[i]
    for (const [v1, v2] of [[a, b], [b, c], [c, a]] as [number, number][]) {
      const key = v1 < v2 ? `${v1}:${v2}` : `${v2}:${v1}`
      edgeCount.set(key, (edgeCount.get(key) ?? 0) + 1)
      if (!edgeVerts.has(key)) edgeVerts.set(key, [v1, v2])
    }
  }

  const pts: number[] = []
  for (const [key, count] of edgeCount) {
    if (count === 1) {
      const [v1, v2] = edgeVerts.get(key)!
      pts.push(...vertices[v1], ...vertices[v2])
    }
  }
  return new Float32Array(pts)
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

export default function Body3D({ featureId, mesh, edges = [], edgeQueries, vertices, vertexQueries, visible = true, showDebugHit = false, color, interactive = true, ghost = false }: Body3DProps) {
  const hoveredSurfaceId = useSketchEditorStore(s => s.hoveredSurfaceId)
  const normalSelection = useSketchEditorStore(s => s.normalSelection)
  const isRotating = useSketchEditorStore(s => s.isRotating)
  const setHoveredBodyId = useSketchEditorStore(s => s.setHoveredBodyId)
  const setHoveredSurface = useSketchEditorStore(s => s.setHoveredSurface)
  const toggleNormalSelection = useSketchEditorStore(s => s.toggleNormalSelection)
  const planeSelectionFeatureId = useSketchEditorStore(s => s.planeSelectionFeatureId)
  const commitPlaneSelection = useSketchEditorStore(s => s.commitPlaneSelection)
  const commitFieldPick = useSketchEditorStore(s => s.commitFieldPick)
  const pendingPickField = useSketchEditorStore(s => s.pendingPickField)

  const [hoveredEdgeIndex, setHoveredEdgeIndex] = useState<number | null>(null)
  const [hoveredVertexIndex, setHoveredVertexIndex] = useState<number | null>(null)

  const noRaycast = useCallback(() => {}, [])

  const isBodySelected = normalSelection.has('@' + featureId)

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
    // Pre-fill color attribute so vertexColors=true doesn't flash black on first render.
    const { r, g, b } = new THREE.Color(COLOR_BODY_DEFAULT)
    const initialColors = new Float32Array(mesh.faces.length * 9)
    for (let i = 0; i < mesh.faces.length * 3; i++) {
      initialColors[i * 3] = r; initialColors[i * 3 + 1] = g; initialColors[i * 3 + 2] = b
    }
    geo.setAttribute('color', new THREE.BufferAttribute(initialColors, 3))
    return geo
  }, [mesh])

  useEffect(() => {
    return () => { geometry.dispose() }
  }, [geometry])

  const edgeGeometry = useMemo(() => {
    const geo = new THREE.BufferGeometry()
    const pts = buildEdgeSegments(edges)
    geo.setAttribute('position', new THREE.BufferAttribute(pts, 3))
    // Pre-fill color attribute so vertexColors=true doesn't flash black on first render.
    const { r, g, b } = new THREE.Color(COLOR_BODY_EDGE)
    const initialColors = new Float32Array(pts.length)
    for (let i = 0; i < pts.length / 3; i++) {
      initialColors[i * 3] = r; initialColors[i * 3 + 1] = g; initialColors[i * 3 + 2] = b
    }
    geo.setAttribute('color', new THREE.BufferAttribute(initialColors, 3))
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

  const bodyColor = isBodySelected ? COLOR_BODY_SELECTED : (color || COLOR_BODY_DEFAULT)

  const edgeColor = isBodySelected ? COLOR_BODY_EDGE_SEL : COLOR_BODY_EDGE

  // Debug: rainbow color per B-rep face -- makes face boundaries immediately visible.
  // Replaces normal face colors when showDebugHit is true.
  const debugFaceColors = useMemo(() => {
    if (!showDebugHit) return null
    const { triangle_to_face, face_queries } = mesh
    if (!triangle_to_face || !face_queries || face_queries.length === 0) return null

    const faceCount = face_queries.length
    const colors = new Float32Array(mesh.faces.length * 3 * 3)
    for (let i = 0; i < mesh.faces.length; i++) {
      const brepFaceIdx = triangle_to_face[i] ?? 0
      const color = new THREE.Color().setHSL(brepFaceIdx / faceCount, 0.9, 0.55)
      const baseIdx = i * 9
      for (let v = 0; v < 9; v += 3) {
        colors[baseIdx + v] = color.r
        colors[baseIdx + v + 1] = color.g
        colors[baseIdx + v + 2] = color.b
      }
    }
    return colors
  }, [showDebugHit, mesh])

  //Debug: wireframe overlay showing every tessellation triangle edge.
  const wireframeGeometry = useMemo(() => {
    if (!showDebugHit) return null
    return new THREE.WireframeGeometry(geometry)
  }, [showDebugHit, geometry])

  useEffect(() => {
    return () => { wireframeGeometry?.dispose() }
  }, [wireframeGeometry])


  // Build segment geometries for every B-rep edge, keyed by edge query.
  // Used to render the overlay of a hovered or selected edge.
  const edgeBoundaryGeos = useMemo(() => {
    if (edges.length === 0) return null
    const geos = new Map<string, THREE.BufferGeometry>()
    edges.forEach((edge, i) => {
      const pts = buildEdgeSegments([edge])
      if (pts.length === 0) return
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.BufferAttribute(pts, 3))
      const query = edgeQueries?.[i] ?? `@${featureId}/edge/${i}`
      geos.set(query, geo)
    })
    return geos
  }, [edges, edgeQueries, featureId])

  useEffect(() => {
    return () => { edgeBoundaryGeos?.forEach(geo => geo.dispose()) }
  }, [edgeBoundaryGeos])

  // Build boundary edge geometries for every B-rep face, keyed by face query.
  // Used to render the outline of a hovered or selected face.
  const faceBoundaryGeos = useMemo(() => {
    const { face_queries } = mesh
    if (!face_queries) return null
    const geos = new Map<string, THREE.BufferGeometry>()
    for (let i = 0; i < face_queries.length; i++) {
      const pts = buildFaceBoundarySegments(mesh, i)
      if (pts.length === 0) continue
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.BufferAttribute(pts, 3))
      geos.set(face_queries[i], geo)
    }
    return geos
  }, [mesh])

  useEffect(() => {
    return () => { faceBoundaryGeos?.forEach(geo => geo.dispose()) }
  }, [faceBoundaryGeos])

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

  // Promote hover to normal-selection. Click never re-searches -- it confirms whatever
  // is already in hoveredSurfaceId so selection and highlight are always the same element.
  // When plane selection mode is active, commit the face as a plane reference instead.
  const handleMeshClick = useCallback((e: { stopPropagation: () => void }) => {
    e.stopPropagation()
    if (!hoveredSurfaceId) return
    if (planeSelectionFeatureId) {
      commitPlaneSelection(hoveredSurfaceId)
    } else {
      toggleNormalSelection(hoveredSurfaceId)
      if (pendingPickField) commitFieldPick()
    }
  }, [hoveredSurfaceId, planeSelectionFeatureId, commitPlaneSelection, toggleNormalSelection, pendingPickField, commitFieldPick])

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
      if (pendingPickField) commitFieldPick()
    }
  }, [featureId, edgeQueries, segmentToEdgeMap, hoveredEdgeIndex, toggleNormalSelection, pendingPickField, commitFieldPick])

  // Always compute face colors -- avoids toggling vertexColors on the material which
  // causes shader recompilation and a black-frame artifact.
  const faceColors = useMemo(() => {
    const colors = new Float32Array(mesh.faces.length * 3 * 3)
    const defaultColor = new THREE.Color(bodyColor)
    const selectedColor = new THREE.Color(COLOR_SELECTED)
    const hoverColor = new THREE.Color(COLOR_HOVER)

    for (let i = 0; i < mesh.faces.length; i++) {
      let color = defaultColor
      if (interactive) {
        const query = resolveFaceQuery(i)
        if (normalSelection.has(query)) {
          color = selectedColor
        } else if (query === hoveredSurfaceId) {
          color = hoverColor
        }
      }

      const baseIdx = i * 9
      for (let v = 0; v < 9; v += 3) {
        colors[baseIdx + v] = color.r
        colors[baseIdx + v + 1] = color.g
        colors[baseIdx + v + 2] = color.b
      }
    }
    return colors
  }, [mesh.faces, normalSelection, hoveredSurfaceId, bodyColor, resolveFaceQuery, interactive])

  // Build edge colors array for selected/hovered edges
  const edgeColors = useMemo(() => {
    const totalSegments = segmentToEdgeMap.length
    if (totalSegments === 0) return null

    const colors = new Float32Array(totalSegments * 2 * 3)  // 2 vertices per segment, 3 components per color
    const defaultColor = new THREE.Color(edgeColor)
    const selectedColor = new THREE.Color(COLOR_SELECTED)
    const hoverColor = new THREE.Color(COLOR_HOVER)

    for (let segIdx = 0; segIdx < totalSegments; segIdx++) {
      const edgeIdx = segmentToEdgeMap[segIdx]
      let color = defaultColor
      if (interactive) {
        if (getIsEdgeSelected(edgeIdx)) {
          color = selectedColor
        } else if (edgeIdx === hoveredEdgeIndex) {
          color = hoverColor
        }
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
  }, [segmentToEdgeMap, getIsEdgeSelected, hoveredEdgeIndex, edgeColor, interactive])

  // debugFaceColors takes precedence when showDebugHit is on.
  const activeColors = debugFaceColors ?? faceColors

  // Always update the color attribute -- faceColors is always non-null so vertexColors
  // stays permanently enabled, avoiding shader recompilation on selection change.
  useEffect(() => {
    const attr = new THREE.BufferAttribute(activeColors, 3)
    geometry.setAttribute('color', attr)
  }, [geometry, activeColors])

  // Always update the color attribute -- edgeColors is always non-null so vertexColors
  // stays permanently enabled, avoiding shader recompilation on selection change.
  useEffect(() => {
    if (edgeColors) {
      edgeGeometry.setAttribute('color', new THREE.BufferAttribute(edgeColors, 3))
    }
  }, [edgeGeometry, edgeColors])

  const vertexMeshRef = useRef<THREE.InstancedMesh>(null)
  const vertexDotRef = useRef<THREE.InstancedMesh>(null)

  // Reusable objects to avoid per-frame allocation
  const _vtxPos = useMemo(() => new THREE.Vector3(), [])
  const _vtxQuat = useMemo(() => new THREE.Quaternion(), [])  // identity
  const _vtxScale = useMemo(() => new THREE.Vector3(), [])
  const _vtxMatrix = useMemo(() => new THREE.Matrix4(), [])
  const _dotScale = useMemo(() => new THREE.Vector3(), [])

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

    const dmesh = vertexDotRef.current
    if (dmesh && vertices?.length) {
      // Only show visual dots when vertex is hovered or selected
      const hasHover = hoveredVertexIndex !== null
      const hasSelection = vertices.some((_, i) => {
        const query = vertexQueries?.[i] ?? `@${featureId}/vertex/${i}`
        return normalSelection.has(query)
      })

      if (!hasHover && !hasSelection) {
        dmesh.visible = false
      } else {
        dmesh.visible = true
        const ds = POINT_VIS_PIXELS * p2w(camera)
        _dotScale.set(ds, ds, ds)

        const hoverColorObj = new THREE.Color(COLOR_HOVER)
        const selectedColorObj = new THREE.Color(COLOR_SELECTED)

        vertices.forEach(([x, y, z], i) => {
          _vtxPos.set(x, y, z)
          _vtxMatrix.compose(_vtxPos, _vtxQuat, _dotScale)
          dmesh.setMatrixAt(i, _vtxMatrix)

          const query = vertexQueries?.[i] ?? `@${featureId}/vertex/${i}`
          let color: THREE.Color
          if (normalSelection.has(query)) {
            color = selectedColorObj
          } else if (i === hoveredVertexIndex) {
            color = hoverColorObj
          } else {
            // Hide non-hovered, non-selected vertices by scaling to 0
            _vtxMatrix.compose(_vtxPos, _vtxQuat, _vtxScale.set(0, 0, 0))
            dmesh.setMatrixAt(i, _vtxMatrix)
            return  // skip setColorAt
          }
          dmesh.setColorAt(i, color)
        })

        dmesh.instanceMatrix.needsUpdate = true
        if (dmesh.instanceColor) dmesh.instanceColor.needsUpdate = true
      }
    }
  })

  return (
    <group visible={visible} userData={{ featureId }}>
      <mesh
        geometry={geometry}
        raycast={interactive ? undefined : noRaycast}
        onPointerOver={interactive ? (e) => {
          e.stopPropagation()
          if (isRotating) return
          setHoveredBodyId(featureId)
          const faceIndex = (e as unknown as { faceIndex?: number }).faceIndex
          if (faceIndex !== undefined) {
            setHoveredSurface(resolveFaceQuery(faceIndex))
          }
        } : undefined}
        onPointerMove={interactive ? (e) => {
          e.stopPropagation()
          const faceIndex = (e as unknown as { faceIndex?: number }).faceIndex
          if (faceIndex !== undefined) {
            setHoveredSurface(resolveFaceQuery(faceIndex))
          }
        } : undefined}
        onPointerOut={interactive ? (e) => {
          e.stopPropagation()
          setHoveredBodyId(current => current === featureId ? null : current)
          setHoveredSurface(null)
        } : undefined}
        onClick={interactive ? handleMeshClick : undefined}
      >
        <meshStandardMaterial
          color="white"
          roughness={0.35}
          metalness={0.3}
          side={THREE.DoubleSide}
          vertexColors={true}
          polygonOffset={true}
          polygonOffsetFactor={ghost ? -1 : 1}
          polygonOffsetUnits={ghost ? -1 : 1}
          transparent={ghost}
          depthWrite={!ghost}
          opacity={ghost ? 0.5 : 1}
          // blendAlpha={ghost ? 0.5 : 1}
          blending={ghost ? THREE.CustomBlending : THREE.NormalBlending}
          blendEquation={ghost ? THREE.AddEquation : THREE.AddEquation}
          // blendEquationAlpha={ghost ? THREE.AddEquation : null}
          blendSrc={ghost ? THREE.SrcAlphaFactor : THREE.SrcAlphaFactor}
          blendDst={ghost ? THREE.OneMinusSrcAlphaFactor : THREE.OneMinusSrcAlphaFactor}
        />
      </mesh>
      {edges.length > 0 && (
        <lineSegments
          geometry={edgeGeometry}
          raycast={interactive ? undefined : noRaycast}
          onPointerOver={interactive ? (e) => {
            e.stopPropagation()
            const index = (e as unknown as { index?: number }).index
            if (index !== undefined && index >= 0) {
              const edgeIndex = segmentToEdgeMap[Math.floor(index / 2)]
              if (edgeIndex !== undefined) {
                setHoveredEdgeIndex(edgeIndex)
              }
            }
          } : undefined}
          onPointerMove={interactive ? (e) => {
            e.stopPropagation()
            const index = (e as unknown as { index?: number }).index
            if (index !== undefined && index >= 0) {
              const edgeIndex = segmentToEdgeMap[Math.floor(index / 2)]
              if (edgeIndex !== undefined) {
                setHoveredEdgeIndex(edgeIndex)
              }
            }
          } : undefined}
          onPointerOut={interactive ? (e) => {
            e.stopPropagation()
            setHoveredEdgeIndex(null)
          } : undefined}
          onClick={interactive ? handleEdgeClick : undefined}
        >
          <lineBasicMaterial
            color="white"
            vertexColors={true}
            transparent={ghost}
            opacity={ghost ? 1.0 : 1}
            depthWrite={!ghost}
            blending={ghost ? THREE.CustomBlending : undefined}
            blendEquation={ghost ? THREE.AddEquation : undefined}
            blendSrc={ghost ? THREE.SrcAlphaFactor : undefined}
            blendDst={ghost ? THREE.SrcAlphaFactor : undefined}
          />
        </lineSegments>
      )}
      {vertices && vertices.length > 0 && (
        <>
          <instancedMesh
            ref={vertexMeshRef}
            args={[undefined, undefined, vertices.length]}
            raycast={interactive ? undefined : noRaycast}
            onPointerOver={interactive ? (e) => {
              e.stopPropagation()
              const idx = e.instanceId
              if (idx !== undefined) setHoveredVertexIndex(idx)
            } : undefined}
            onPointerOut={interactive ? (e) => {
              e.stopPropagation()
              setHoveredVertexIndex(null)
            } : undefined}
            onClick={interactive ? (e) => {
              e.stopPropagation()
              const idx = e.instanceId
              if (idx !== undefined) {
                const query = vertexQueries?.[idx] ?? `@${featureId}/vertex/${idx}`
                toggleNormalSelection(query)
              }
            } : undefined}
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
          <instancedMesh
            ref={vertexDotRef}
            args={[undefined, undefined, vertices.length]}
            visible={false}
            renderOrder={999}
          >
            <sphereGeometry args={[1, 6, 6]} />
            <meshBasicMaterial color="white" depthTest={false} depthWrite={false} />
          </instancedMesh>
        </>
      )}
      {interactive && edgeBoundaryGeos && hoveredEdgeIndex !== null && (() => {
        const query = edgeQueries?.[hoveredEdgeIndex] ?? `@${featureId}/edge/${hoveredEdgeIndex}`
        const geo = edgeBoundaryGeos.get(query)
        return geo ? (
          <lineSegments geometry={geo}>
            <lineBasicMaterial color={COLOR_HOVER} linewidth={2} depthTest={false} />
          </lineSegments>
        ) : null
      })()}
      {interactive && edgeBoundaryGeos && [...normalSelection].map(query => {
        const geo = edgeBoundaryGeos.get(query)
        if (!geo) return null
        return (
          <lineSegments key={query} geometry={geo}>
            <lineBasicMaterial color={COLOR_SELECTED} linewidth={2} depthTest={false} />
          </lineSegments>
        )
      })}
      {interactive && faceBoundaryGeos && hoveredSurfaceId && faceBoundaryGeos.has(hoveredSurfaceId) && (
        <lineSegments geometry={faceBoundaryGeos.get(hoveredSurfaceId)}>
          <lineBasicMaterial color={COLOR_HOVER} linewidth={2} depthTest={false} />
        </lineSegments>
      )}
      {interactive && faceBoundaryGeos && [...normalSelection].map(query => {
        const geo = faceBoundaryGeos.get(query)
        if (!geo) return null
        return (
          <lineSegments key={query} geometry={geo}>
            <lineBasicMaterial color={COLOR_SELECTED} linewidth={2} depthTest={false} />
          </lineSegments>
        )
      })}
    </group>
  )
}
