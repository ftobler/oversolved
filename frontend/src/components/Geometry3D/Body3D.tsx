import { useMemo, useEffect, useState, useCallback, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import type { Mesh3D, EdgeData } from '@/types/cad'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { p2w } from '@/components/sketch_helpers'
import {
  COLOR_BODY_DEFAULT,
  COLOR_BODY_SELECTED,
  COLOR_BODY_EDGE, COLOR_BODY_EDGE_SEL,
  COLOR_SELECTED, COLOR_HOVER,
  blendWhite,
  POINT_HIT_PIXELS, POINT_VIS_PIXELS,
  RENDER_ORDER_DEFAULT,
  RENDER_ORDER_HIGHLIGHT,
} from '@/components/Geometry3D/constants'
import {
  buildBodyGeometry,
  buildFaceBoundarySegments,
  extractFaceGeometry,
  calculateFaceProperties,
  buildEdgeSegments,
  getEdgeSegmentCounts,
  faceCount,
} from '@/components/Geometry3D/bodyGeometry'
import { useFaceIdRegistration, useEdgeIdRegistration, useVertexIdRegistration } from '@/picking'
import { EDGE_DEPTH_BIAS } from '@/picking/EdgeIdLayer'
import { registerBodyCallbacks } from '@/components/Viewport/idDispatch/bodyDispatchCallbacks'

const EDGE_VERT_SHADER = `
  varying vec3 vColor;
  uniform float uDepthBias;
  void main() {
    vec4 clip = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    clip.z += uDepthBias * clip.w;
    vColor = color;
    gl_Position = clip;
  }
`

const EDGE_FRAG_SHADER = `
  varying vec3 vColor;
  void main() {
    gl_FragColor = vec4(vColor, 1.0);
  }
`

function buildEdgeMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: EDGE_VERT_SHADER,
    fragmentShader: EDGE_FRAG_SHADER,
    uniforms: { uDepthBias: { value: EDGE_DEPTH_BIAS } },
    vertexColors: true,
  })
}

interface Body3DProps {
  featureId: string
  bodyId: string
  mesh: Mesh3D
  edges?: EdgeData[]
  edgeQueries?: string[]
  vertices?: [number, number, number][]
  vertexQueries?: string[]
  visible?: boolean
  showDebugHit?: boolean
  color?: string
  transparency?: number  // 0-1 (0 = opaque, 1 = fully transparent)
  metalness?: number     // 0-1 (0 = non-metallic, 1 = fully metallic)
  interactive?: boolean
}

export default function Body3D({ featureId, bodyId, mesh, edges = [], edgeQueries, vertices, vertexQueries, visible = true, showDebugHit: _showDebugHit = false, color, transparency = 0, metalness = 0.3, interactive = true }: Body3DProps) {
  useFaceIdRegistration({ featureId, bodyId, mesh, enabled: interactive && visible })
  useEdgeIdRegistration({ featureId, bodyId, edges, edgeQueries, enabled: interactive && visible })
  useVertexIdRegistration({ featureId, bodyId, vertices, vertexQueries, enabled: interactive && visible })
  const hovered3DSurfaceId = useSketchEditorStore(s => s.hovered3DSurfaceId)
  const normalSelection = useSketchEditorStore(s => s.normalSelection)
  const setHoveredFaceGeometry = useSketchEditorStore(s => s.setHoveredFaceGeometry)

  const [hoveredEdgeIndex, setHoveredEdgeIndex] = useState<number | null>(null)
  const [hoveredVertexIndex, setHoveredVertexIndex] = useState<number | null>(null)

  const faceColorAttrRef = useRef<(THREE.BufferAttribute & { dispose?: () => void }) | null>(null)
  const edgeColorAttrRef = useRef<(THREE.BufferAttribute & { dispose?: () => void }) | null>(null)

  const updateFaceGeometryForQuery = useCallback((faceQuery: string) => {
    const { face_queries } = mesh
    if (!face_queries) return
    const brepFaceIndex = face_queries.indexOf(faceQuery)
    if (brepFaceIndex < 0) return
    const faceGeo = extractFaceGeometry(mesh, brepFaceIndex)
    if (!faceGeo) return
    const props = calculateFaceProperties(faceGeo)
    if (!props) return
    setHoveredFaceGeometry(props.normal, props.center)
  }, [mesh, setHoveredFaceGeometry])

  const clearFaceGeometry = useCallback(() => {
    setHoveredFaceGeometry(null, null)
  }, [setHoveredFaceGeometry])

  // Register the per-body dispatch hooks consumed by the id-buffer
  // pointer dispatcher (267.4 cutover). The dispatcher resolves a
  // (layer, entityKey) hit and routes the per-body parts of the
  // hover write (local edge/vertex index, face geometry computation)
  // through this registry. The store-wide writes
  // (hovered3DSurfaceId, hoveredBodyId, toggleNormalSelection) are
  // performed by the dispatcher directly.
  useEffect(() => {
    if (!interactive || !visible) return
    const bodyKey = `${featureId}/${bodyId}`
    return registerBodyCallbacks(bodyKey, {
      featureId,
      bodyId,
      mesh,
      edgeQueries,
      vertexQueries,
      setHoveredEdgeIndex,
      setHoveredVertexIndex,
      updateFaceGeometryForQuery,
      clearFaceGeometry,
    })
  }, [interactive, visible, featureId, bodyId, mesh, edgeQueries, vertexQueries, updateFaceGeometryForQuery, clearFaceGeometry])

  const isBodySelected = normalSelection.has('@' + bodyId)

  const getIsEdgeSelected = useCallback((edgeIndex: number): boolean => {
    const query = edgeQueries?.[edgeIndex] ?? `@${featureId}/edge/${edgeIndex}`
    return normalSelection.has(query)
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
    const numTris = faceCount(mesh.faces)
    const initialColors = new Float32Array(numTris * 9)
    for (let i = 0; i < numTris * 3; i++) {
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

  const edgeMaterial = useMemo(() => buildEdgeMaterial(), [])
  useEffect(() => {
    return () => { edgeMaterial.dispose() }
  }, [edgeMaterial])

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

  // Always compute face colors -- avoids toggling vertexColors on the material which
  // causes shader recompilation and a black-frame artifact.
  const faceColors = useMemo(() => {
    const numTris = faceCount(mesh.faces)
    const colors = new Float32Array(numTris * 3 * 3)
    const defaultColor = new THREE.Color(bodyColor)
    const selectedColor = new THREE.Color(COLOR_SELECTED)
    const hoverColor = new THREE.Color(blendWhite(bodyColor))

    for (let i = 0; i < numTris; i++) {
      let color = defaultColor
      if (interactive) {
        const query = resolveFaceQuery(i)
        if (normalSelection.has(query)) {
          color = selectedColor
        } else if (query === hovered3DSurfaceId) {
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
  }, [mesh.faces, normalSelection, hovered3DSurfaceId, bodyColor, resolveFaceQuery, interactive])

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
      let color: THREE.Color
      if (interactive) {
        if (getIsEdgeSelected(edgeIdx)) {
          color = selectedColor
        } else if (edgeIdx === hoveredEdgeIndex) {
          color = hoverColor
        } else {
          color = defaultColor
        }
      } else {
        color = defaultColor
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

  // Always update the color attribute -- faceColors is always non-null so vertexColors
  // stays permanently enabled, avoiding shader recompilation on selection change.
  // Dispose the previous attribute to avoid leaking GPU memory on each hover/selection change.
  useEffect(() => {
    const oldAttr = faceColorAttrRef.current
    const attr = new THREE.BufferAttribute(faceColors, 3)
    geometry.setAttribute('color', attr)
    faceColorAttrRef.current = attr
    oldAttr?.dispose?.()
  }, [geometry, faceColors])

  // Always update the color attribute -- edgeColors is always non-null so vertexColors
  // stays permanently enabled, avoiding shader recompilation on selection change.
  // Dispose the previous attribute to avoid leaking GPU memory on each hover/selection change.
  useEffect(() => {
    if (edgeColors) {
      const oldAttr = edgeColorAttrRef.current
      const attr = new THREE.BufferAttribute(edgeColors, 3)
      edgeGeometry.setAttribute('color', attr)
      edgeColorAttrRef.current = attr
      oldAttr?.dispose?.()
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

  useFrame(({ camera }) => {
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
      >
        <meshStandardMaterial
          color="white"
          roughness={0.35}
          metalness={metalness}
          side={THREE.DoubleSide}
          vertexColors={true}
          polygonOffset={true}
          polygonOffsetFactor={1}
          polygonOffsetUnits={1}
          transparent={transparency > 0}
          depthWrite={transparency === 0}
          opacity={1 - transparency}
          blending={transparency > 0 ? THREE.CustomBlending : THREE.NormalBlending}
          blendSrc={THREE.SrcAlphaFactor}
          blendDst={THREE.OneMinusSrcAlphaFactor}
        />
      </mesh>
      {edges.length > 0 && (
        <lineSegments
          geometry={edgeGeometry}
          material={edgeMaterial}
          renderOrder={RENDER_ORDER_DEFAULT}
        />
      )}
      {vertices && vertices.length > 0 && (
        <>
          <instancedMesh
            ref={vertexMeshRef}
            args={[undefined, undefined, vertices.length]}
            frustumCulled={false}
          >
            {/* Radius 1 — scaled to POINT_HIT_PIXELS screen px by useFrame */}
            <sphereGeometry args={[1, 8, 8]} />
            <meshBasicMaterial
              transparent
              opacity={0}
              depthWrite={false}
            />
          </instancedMesh>
          <instancedMesh
            ref={vertexDotRef}
            args={[undefined, undefined, vertices.length]}
            visible={false}
            frustumCulled={false}
            renderOrder={RENDER_ORDER_HIGHLIGHT}
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
            <lineBasicMaterial color={COLOR_HOVER} linewidth={3} depthTest={false} />
          </lineSegments>
        ) : null
      })()}
      {interactive && edgeBoundaryGeos && [...normalSelection].map(query => {
        const geo = edgeBoundaryGeos.get(query)
        if (!geo) return null
        return (
          <lineSegments key={query} geometry={geo} renderOrder={RENDER_ORDER_HIGHLIGHT}>
            <lineBasicMaterial color={COLOR_SELECTED} linewidth={3} depthTest={false} transparent />
          </lineSegments>
        )
      })}
      {interactive && faceBoundaryGeos && hovered3DSurfaceId && faceBoundaryGeos.has(hovered3DSurfaceId) && (
        <lineSegments geometry={faceBoundaryGeos.get(hovered3DSurfaceId)}>
          <lineBasicMaterial color={COLOR_HOVER} linewidth={3} depthTest={false} />
        </lineSegments>
      )}
      {interactive && faceBoundaryGeos && [...normalSelection].map(query => {
        const geo = faceBoundaryGeos.get(query)
        if (!geo) return null
        return (
          <lineSegments key={query} geometry={geo}>
            <lineBasicMaterial color={COLOR_SELECTED} linewidth={3} depthTest={false} transparent />
          </lineSegments>
        )
      })}
    </group>
  )
}
