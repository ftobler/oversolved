import { useMemo, useEffect, useCallback, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import type { Mesh3D, EdgeData } from '@/types/cad'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { p2w } from '@/utils/geometry/sketchHelpers'
import {
  COLOR_BODY_DEFAULT,
  COLOR_BODY_SELECTED,
  COLOR_BODY_EDGE, COLOR_BODY_EDGE_SEL,
  COLOR_SELECTED, COLOR_HOVER,
  blendWhite,
  POINT_HIT_PIXELS, POINT_VIS_PIXELS,
  DEFAULT_PART_ROUGHNESS,
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
import { bodyKeyFor } from '@/picking/pickKey'
import { FACE_LAYER_NAME, EDGE_LAYER_NAME, VERTEX_LAYER_NAME } from '@/picking/layerNames'
import { computeHighlight, type ActiveHighlight } from '@/picking/selectionHighlight'
import { selectActiveFrom, hoverActiveFrom } from '@/picking/highlightActive'
import { topoFallbackQuery } from '@/utils/query/selectionId'
import { EDGE_DEPTH_BIAS } from '@/picking/EdgeIdLayer'
import { ENV_MAP_INTENSITY } from '@/components/Viewport/EnvLight'
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

function useDispose<T extends { dispose(): void }>(obj: T | null | undefined): void {
  useEffect(() => { return () => { obj?.dispose() } }, [obj])
}

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
  roughness?: number     // 0-1 (0 = smooth, 1 = rough)
  transmission?: number  // 0-1 (0 = opaque, 1 = fully transmissive / glass-like)
  interactive?: boolean
}

export default function Body3D({ featureId, bodyId, mesh, edges = [], edgeQueries, vertices, vertexQueries, visible = true, showDebugHit: _showDebugHit = false, color, transparency = 0, metalness = 0, roughness = DEFAULT_PART_ROUGHNESS, transmission = 0, interactive = true }: Body3DProps) {
  useFaceIdRegistration({ featureId, bodyId, mesh, enabled: interactive && visible })
  useEdgeIdRegistration({ featureId, bodyId, edges, edgeQueries, enabled: interactive && visible })
  useVertexIdRegistration({ featureId, bodyId, vertices, vertexQueries, enabled: interactive && visible })
  const hoveredSelectionId = useSketchEditorStore(s => s.hoveredSelectionId)
  const hoveredPickKey = useSketchEditorStore(s => s.hoveredPickKey)
  const normalSelection = useSketchEditorStore(s => s.normalSelection)
  const selectedPickKeys = useSketchEditorStore(s => s.selectedPickKeys)
  const setHoveredFaceGeometry = useSketchEditorStore(s => s.setHoveredFaceGeometry)

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
  // (hoveredSelectionId, toggleNormalSelection) are
  // performed by the dispatcher directly.
  useEffect(() => {
    if (!interactive || !visible) return
    const bodyKey = `${featureId}/${bodyId}`
    return registerBodyCallbacks(bodyKey, {
      featureId,
      bodyId,
      mesh,
      edgeQueries,
      edgeKinds: edges.map(e => e.kind),
      vertexQueries,
      updateFaceGeometryForQuery,
      clearFaceGeometry,
    })
  }, [interactive, visible, featureId, bodyId, mesh, edges, edgeQueries, vertexQueries, updateFaceGeometryForQuery, clearFaceGeometry])

  const isBodySelected = normalSelection.has('@' + bodyId)

  const bodyKey = useMemo(() => bodyKeyFor(featureId, bodyId), [featureId, bodyId])

  // The two active-highlight requests. Click and hover differ ONLY in which sets
  // they carry -- never in shape or decision logic. Both are fed to the SAME
  // computeHighlight below, so a hover and a click that resolve to the same
  // primitive produce identical highlight flags (the symmetry this refactor
  // enforces). Hover is just a transient selection of size <= 1.
  const selectActive = useMemo<ActiveHighlight>(
    () => selectActiveFrom(selectedPickKeys, normalSelection),
    [selectedPickKeys, normalSelection],
  )
  const hoverActive = useMemo<ActiveHighlight>(
    () => hoverActiveFrom(hoveredPickKey, hoveredSelectionId),
    [hoveredPickKey, hoveredSelectionId],
  )

  // Resolved query per edge (real query, else a topo fallback). The single
  // primitive list every edge highlight decision indexes into.
  const edgeQueriesResolved = useMemo(() => {
    const numEdges = Math.max(edgeQueries?.length ?? 0, edges.length)
    return Array.from({ length: numEdges }, (_, i) =>
      edgeQueries?.[i] ?? topoFallbackQuery(featureId, 'edge', i))
  }, [featureId, edgeQueries, edges])

  // Edge highlight is decoupled from the raw query set: the exact pointed edge
  // (its pickKey) wins, and a sibling sharing its query does not co-highlight.
  // Persisted picks (no live pickKey after a re-solve) fall back to query
  // membership. See computeHighlight. Hover runs the identical function.
  const edgeSelectionFlags = useMemo(
    () => computeHighlight(bodyKey, EDGE_LAYER_NAME, edgeQueriesResolved, selectActive),
    [bodyKey, edgeQueriesResolved, selectActive],
  )
  const edgeHoverFlags = useMemo(
    () => computeHighlight(bodyKey, EDGE_LAYER_NAME, edgeQueriesResolved, hoverActive),
    [bodyKey, edgeQueriesResolved, hoverActive],
  )

  const getIsEdgeSelected = useCallback(
    (edgeIndex: number): boolean => edgeSelectionFlags[edgeIndex] ?? false,
    [edgeSelectionFlags],
  )

  // Face highlight, decoupled from raw query membership exactly like edges:
  // sibling faces sharing an ancestral query (no minted UUID) must not co-highlight.
  // Indexed by B-rep face index; null when the mesh carries no face queries (the
  // fallback path below keeps the legacy per-triangle query-membership highlight).
  const faceSelectionFlags = useMemo(() => {
    const { face_queries } = mesh
    if (!face_queries || face_queries.length === 0) return null
    return computeHighlight(bodyKey, FACE_LAYER_NAME, face_queries, selectActive)
  }, [bodyKey, mesh, selectActive])

  const faceHoverFlags = useMemo(() => {
    const { face_queries } = mesh
    if (!face_queries || face_queries.length === 0) return null
    return computeHighlight(bodyKey, FACE_LAYER_NAME, face_queries, hoverActive)
  }, [bodyKey, mesh, hoverActive])

  // Resolved query per vertex, mirroring edges.
  const vertexQueriesResolved = useMemo(() => {
    if (!vertices || vertices.length === 0) return null
    return vertices.map((_, i) => vertexQueries?.[i] ?? topoFallbackQuery(featureId, 'vertex', i))
  }, [featureId, vertices, vertexQueries])

  // Vertex highlight, decoupled from raw query membership exactly like faces/edges.
  const vertexSelectionFlags = useMemo(() => {
    if (!vertexQueriesResolved) return null
    return computeHighlight(bodyKey, VERTEX_LAYER_NAME, vertexQueriesResolved, selectActive)
  }, [bodyKey, vertexQueriesResolved, selectActive])

  const vertexHoverFlags = useMemo(() => {
    if (!vertexQueriesResolved) return null
    return computeHighlight(bodyKey, VERTEX_LAYER_NAME, vertexQueriesResolved, hoverActive)
  }, [bodyKey, vertexQueriesResolved, hoverActive])

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

  useDispose(geometry)

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

  useDispose(edgeGeometry)

  const edgeMaterial = useMemo(() => buildEdgeMaterial(), [])
  useDispose(edgeMaterial)

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

  // Build segment geometries for every B-rep edge, keyed by edge index. Used to
  // render the overlay of a hovered or selected edge. Keyed by index (not query)
  // so two edges sharing a query keep distinct overlays instead of one clobbering
  // the other in the map (mirrors faceBoundaryGeos).
  const edgeBoundaryGeos = useMemo(() => {
    if (edges.length === 0) return null
    const geos = new Map<number, THREE.BufferGeometry>()
    edges.forEach((edge, i) => {
      const pts = buildEdgeSegments([edge])
      if (pts.length === 0) return
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.BufferAttribute(pts, 3))
      geos.set(i, geo)
    })
    return geos
  }, [edges])

  useEffect(() => {
    return () => { edgeBoundaryGeos?.forEach(geo => geo.dispose()) }
  }, [edgeBoundaryGeos])

  // Build boundary edge geometries for every B-rep face, keyed by face index.
  // Used to render the outline of a hovered or selected face. Keyed by index (not
  // query) so two faces sharing a query keep distinct outlines instead of one
  // overwriting the other.
  const faceBoundaryGeos = useMemo(() => {
    const { face_queries } = mesh
    if (!face_queries) return null
    const geos = new Map<number, THREE.BufferGeometry>()
    for (let i = 0; i < face_queries.length; i++) {
      const pts = buildFaceBoundarySegments(mesh, i)
      if (pts.length === 0) continue
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.BufferAttribute(pts, 3))
      geos.set(i, geo)
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
    return topoFallbackQuery(featureId, 'face', triangleIndex)
  }, [mesh, featureId])

  // Always compute face colors -- avoids toggling vertexColors on the material which
  // causes shader recompilation and a black-frame artifact.
  const faceColors = useMemo(() => {
    const numTris = faceCount(mesh.faces)
    const colors = new Float32Array(numTris * 3 * 3)
    const defaultColor = new THREE.Color(bodyColor)
    const selectedColor = new THREE.Color(COLOR_SELECTED)
    const hoverColor = new THREE.Color(blendWhite(bodyColor))
    const { triangle_to_face } = mesh

    for (let i = 0; i < numTris; i++) {
      let color = defaultColor
      if (interactive) {
        // With B-rep face metadata, isolate by face index / pick key so shared-query
        // siblings do not co-highlight. Without it, keep the legacy query membership.
        const brepFaceIndex = faceSelectionFlags && triangle_to_face ? (triangle_to_face[i] ?? -1) : -1
        if (brepFaceIndex >= 0) {
          if (faceSelectionFlags![brepFaceIndex]) color = selectedColor
          else if (faceHoverFlags?.[brepFaceIndex]) color = hoverColor
        } else {
          const query = resolveFaceQuery(i)
          if (normalSelection.has(query)) color = selectedColor
          else if (query === hoveredSelectionId) color = hoverColor
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
  }, [mesh, faceSelectionFlags, faceHoverFlags, normalSelection, hoveredSelectionId, bodyColor, resolveFaceQuery, interactive])

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
        // Hover isolates the single hovered edge (edgeHoverFlags resolves by pick
        // key, then query): two edges sharing a query must not co-highlight.
        } else if (edgeHoverFlags[edgeIdx]) {
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
  }, [segmentToEdgeMap, getIsEdgeSelected, edgeHoverFlags, edgeColor, interactive])

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
      // Only show visual dots when a vertex is hovered or selected. Both are
      // resolved by pick key (via vertexSelectionFlags / vertexHoverFlags) so a
      // shared-query sibling does not co-show, mirroring the face path.
      const hasHover = vertexHoverFlags ? vertexHoverFlags.some(Boolean) : false
      const hasSelection = vertexSelectionFlags ? vertexSelectionFlags.some(Boolean) : false

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

          let color: THREE.Color
          if (vertexSelectionFlags && vertexSelectionFlags[i]) {
            color = selectedColorObj
          } else if (vertexHoverFlags && vertexHoverFlags[i]) {
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
        <meshPhysicalMaterial
          color="white"
          roughness={roughness}
          metalness={metalness}
          transmission={transmission}
          envMapIntensity={ENV_MAP_INTENSITY}
          side={THREE.DoubleSide}
          vertexColors={true}
          polygonOffset={true}
          polygonOffsetFactor={1}
          polygonOffsetUnits={1}
          transparent={transparency > 0 || transmission > 0}
          depthWrite={transparency === 0 && transmission === 0}
          opacity={1 - transparency}
          blending={transparency > 0 || transmission > 0 ? THREE.CustomBlending : THREE.NormalBlending}
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
      {interactive && edgeBoundaryGeos && edgeHoverFlags.map((hovered, edgeIdx) => {
        // Selection outranks hover: skip the hover overlay where the selection
        // overlay already draws, so precedence is explicit and not a JSX draw-order
        // accident (mirrors the edgeColors if/else-if).
        if (!hovered || edgeSelectionFlags[edgeIdx]) return null
        const geo = edgeBoundaryGeos.get(edgeIdx)
        if (!geo) return null
        return (
          <lineSegments key={`edge-hover-${edgeIdx}`} geometry={geo}>
            <lineBasicMaterial color={COLOR_HOVER} linewidth={3} depthTest={false} />
          </lineSegments>
        )
      })}
      {interactive && edgeBoundaryGeos && edgeSelectionFlags.map((selected, edgeIdx) => {
        if (!selected) return null
        const geo = edgeBoundaryGeos.get(edgeIdx)
        if (!geo) return null
        return (
          <lineSegments key={edgeIdx} geometry={geo} renderOrder={RENDER_ORDER_HIGHLIGHT}>
            <lineBasicMaterial color={COLOR_SELECTED} linewidth={3} depthTest={false} transparent />
          </lineSegments>
        )
      })}
      {interactive && faceBoundaryGeos && faceHoverFlags && faceHoverFlags.map((hovered, faceIdx) => {
        // Selection outranks hover: skip the hover overlay where the selection
        // overlay already draws (mirrors the faceColors if/else-if precedence).
        if (!hovered || faceSelectionFlags?.[faceIdx]) return null
        const geo = faceBoundaryGeos.get(faceIdx)
        if (!geo) return null
        return (
          <lineSegments key={`face-hover-${faceIdx}`} geometry={geo}>
            <lineBasicMaterial color={COLOR_HOVER} linewidth={3} depthTest={false} />
          </lineSegments>
        )
      })}
      {interactive && faceBoundaryGeos && faceSelectionFlags && faceSelectionFlags.map((selected, faceIdx) => {
        if (!selected) return null
        const geo = faceBoundaryGeos.get(faceIdx)
        if (!geo) return null
        return (
          <lineSegments key={faceIdx} geometry={geo}>
            <lineBasicMaterial color={COLOR_SELECTED} linewidth={3} depthTest={false} transparent />
          </lineSegments>
        )
      })}
    </group>
  )
}
