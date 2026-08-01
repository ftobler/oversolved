import { useMemo, useEffect, useCallback, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import type { Mesh3D, EdgeData } from '@/types/cad'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { p2w } from '@/utils/geometry/sketchHelpers'
import {
  COLOR_BODY_DEFAULT,
  COLOR_BODY_EDGE, COLOR_BODY_EDGE_SEL,
  bodySurfaceLook,
  COLOR_SELECTED, COLOR_HOVER,
  blendWhite,
  POINT_HIT_PIXELS, POINT_VIS_PIXELS,
  DEFAULT_PART_ROUGHNESS,
  RENDER_ORDER_DEFAULT,
  RENDER_ORDER_HIGHLIGHT,
  EDGE_HIGHLIGHT_LINE_WIDTH,
} from '@/components/Geometry3D/constants'
import {
  buildBodyGeometry,
  buildFaceBoundarySegments,
  extractFaceGeometry,
  calculateFaceProperties,
  buildEdgeSegments,
  getEdgeSegmentCounts,
  faceCount,
  lazyFaceTriangles,
} from '@/components/Geometry3D/bodyGeometry'
import { lazyGeometryCache } from '@/components/Geometry3D/lazyGeometryCache'
import { faceRuns, triangleRuns, edgeRuns, type HighlightPalette } from '@/components/Geometry3D/highlightColorPainter'
import { useHighlightColors, paletteRGB } from '@/components/Geometry3D/useHighlightColors'
import { VertexInstancePainter } from '@/components/Geometry3D/vertexInstancePainter'
import { useFaceIdRegistration, useEdgeIdRegistration, useVertexIdRegistration } from '@/picking'
import { bodyKeyFor } from '@/picking/pickKey'
import { FACE_LAYER_NAME, EDGE_LAYER_NAME, VERTEX_LAYER_NAME } from '@/picking/layerNames'
import { HighlightIndex, type ActiveHighlight } from '@/picking/selectionHighlight'
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

// Vertex-dot colours, hoisted out of the frame loop: three.js Color parsing is not
// free and neither of these ever changes.
const DOT_COLOR_HOVER = new THREE.Color(COLOR_HOVER)
const DOT_COLOR_SELECTED = new THREE.Color(COLOR_SELECTED)

// Shared empty default so a body rendered without edges keeps one identity for
// the prop across renders. A fresh `[]` per render would invalidate every memo
// and effect keyed on `edges` -- including the geometry builds and the dispatch
// registration, which now indexes the body's queries when it runs.
const NO_EDGES: EdgeData[] = []

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
  removedByEdit?: boolean  // ghost of a body the previewed edit consumes: drawn "doomed", still pickable
}

export default function Body3D({ featureId, bodyId, mesh, edges = NO_EDGES, edgeQueries, vertices, vertexQueries, visible = true, showDebugHit: _showDebugHit = false, color, transparency = 0, metalness = 0, roughness = DEFAULT_PART_ROUGHNESS, transmission = 0, interactive = true, removedByEdit = false }: Body3DProps) {
  useFaceIdRegistration({ featureId, bodyId, mesh, enabled: interactive && visible })
  useEdgeIdRegistration({ featureId, bodyId, edges, edgeQueries, enabled: interactive && visible })
  useVertexIdRegistration({ featureId, bodyId, vertices, vertexQueries, enabled: interactive && visible })
  const hoveredSelectionId = useSketchEditorStore(s => s.hoveredSelectionId)
  const hoveredPickKey = useSketchEditorStore(s => s.hoveredPickKey)
  const normalSelection = useSketchEditorStore(s => s.normalSelection)
  const selectedPicks = useSketchEditorStore(s => s.selectedPicks)
  const setHoveredFaceGeometry = useSketchEditorStore(s => s.setHoveredFaceGeometry)

  // Triangles-per-face grouping, built on first use and then shared by everything
  // that works face-by-face. Lazy on purpose: a body is meshed and mounted far
  // more often than any of its faces is pointed at, and this must not land in the
  // solve-to-first-frame path.
  const faceTriangles = useMemo(() => lazyFaceTriangles(mesh), [mesh])

  // Takes the B-rep face INDEX, not its query: the dispatcher's reverse index
  // already resolved the query to an index to find this body at all, so taking the
  // query here meant a second `face_queries.indexOf` -- a linear scan of string
  // compares over every face of the body, on every pointer move.
  const updateFaceGeometryForIndex = useCallback((brepFaceIndex: number) => {
    const faceGeo = extractFaceGeometry(mesh, brepFaceIndex, faceTriangles.get(brepFaceIndex))
    if (!faceGeo) return
    const props = calculateFaceProperties(faceGeo)
    if (!props) return
    setHoveredFaceGeometry(props.normal, props.center)
  }, [mesh, faceTriangles, setHoveredFaceGeometry])

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
      updateFaceGeometryForIndex,
      clearFaceGeometry,
    })
  }, [interactive, visible, featureId, bodyId, mesh, edges, edgeQueries, vertexQueries, updateFaceGeometryForIndex, clearFaceGeometry])

  const isBodySelected = normalSelection.has('@' + bodyId)

  const bodyKey = useMemo(() => bodyKeyFor(featureId, bodyId), [featureId, bodyId])

  // The two active-highlight requests. Click and hover differ ONLY in which sets
  // they carry -- never in shape or decision logic. Both are fed to the SAME
  // computeHighlight below, so a hover and a click that resolve to the same
  // primitive produce identical highlight flags (the symmetry this refactor
  // enforces). Hover is just a transient selection of size <= 1.
  const selectActive = useMemo<ActiveHighlight>(
    () => selectActiveFrom(selectedPicks, normalSelection),
    [selectedPicks, normalSelection],
  )
  const hoverActive = useMemo<ActiveHighlight>(
    () => hoverActiveFrom(hoveredPickKey, hoveredSelectionId),
    [hoveredPickKey, hoveredSelectionId],
  )

  // Resolved query per edge (real query, else a topo fallback). The single
  // primitive list every edge highlight decision indexes into. The fallback is
  // keyed on the BODY: this feature's split siblings each index their own edges
  // from 0, so a feature-keyed fallback gave two different edges one query.
  const edgeQueriesResolved = useMemo(() => {
    const numEdges = Math.max(edgeQueries?.length ?? 0, edges.length)
    return Array.from({ length: numEdges }, (_, i) =>
      edgeQueries?.[i] ?? topoFallbackQuery(bodyId, 'edge', i))
  }, [bodyId, edgeQueries, edges])

  // One highlight index per (body, layer). It answers "nothing of mine is
  // active" without touching the primitives and always with the SAME all-false
  // array, so a pointer move elsewhere in the scene leaves every flags array
  // below reference-identical and the colour memos that depend on them never
  // re-run. That is what keeps hover cost independent of how many bodies and
  // faces the model has.
  const edgeHighlightIndex = useMemo(
    () => new HighlightIndex(bodyKey, EDGE_LAYER_NAME, edgeQueriesResolved),
    [bodyKey, edgeQueriesResolved],
  )

  // Edge highlight is decoupled from the raw query set: the exact pointed edge
  // (its pickKey) wins, and a sibling sharing its query does not co-highlight.
  // Persisted picks (no live pickKey after a re-solve) fall back to query
  // membership. See computeHighlight. Hover runs the identical function.
  const edgeSelectionFlags = useMemo(
    () => edgeHighlightIndex.compute(selectActive),
    [edgeHighlightIndex, selectActive],
  )
  const edgeHoverFlags = useMemo(
    () => edgeHighlightIndex.compute(hoverActive),
    [edgeHighlightIndex, hoverActive],
  )

  // Face highlight, decoupled from raw query membership exactly like edges:
  // sibling faces sharing an ancestral query (no minted UUID) must not co-highlight.
  // Indexed by B-rep face index; null when the mesh carries no face queries (the
  // fallback path below keeps the legacy per-triangle query-membership highlight).
  const faceHighlightIndex = useMemo(() => {
    const { face_queries } = mesh
    if (!face_queries || face_queries.length === 0) return null
    return new HighlightIndex(bodyKey, FACE_LAYER_NAME, face_queries)
  }, [bodyKey, mesh])

  const faceSelectionFlags = useMemo(
    () => faceHighlightIndex?.compute(selectActive) ?? null,
    [faceHighlightIndex, selectActive],
  )

  const faceHoverFlags = useMemo(
    () => faceHighlightIndex?.compute(hoverActive) ?? null,
    [faceHighlightIndex, hoverActive],
  )

  // Resolved query per vertex, mirroring edges.
  const vertexQueriesResolved = useMemo(() => {
    if (!vertices || vertices.length === 0) return null
    return vertices.map((_, i) => vertexQueries?.[i] ?? topoFallbackQuery(bodyId, 'vertex', i))
  }, [bodyId, vertices, vertexQueries])

  const vertexHighlightIndex = useMemo(
    () => vertexQueriesResolved && new HighlightIndex(bodyKey, VERTEX_LAYER_NAME, vertexQueriesResolved),
    [bodyKey, vertexQueriesResolved],
  )

  // Vertex highlight, decoupled from raw query membership exactly like faces/edges.
  const vertexSelectionFlags = useMemo(
    () => vertexHighlightIndex?.compute(selectActive) ?? null,
    [vertexHighlightIndex, selectActive],
  )

  const vertexHoverFlags = useMemo(
    () => vertexHighlightIndex?.compute(hoverActive) ?? null,
    [vertexHighlightIndex, hoverActive],
  )

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

  // The whole surface is one decision (see bodySurfaceLook for the precedence).
  const surface = bodySurfaceLook({
    selected: isBodySelected, removedByEdit, color, transparency, metalness, roughness, transmission,
  })
  const bodyColor = surface.color

  const edgeColor = isBodySelected ? COLOR_BODY_EDGE_SEL : COLOR_BODY_EDGE

  // Overlay geometry for a hovered or selected B-rep edge, keyed by edge index
  // (not query) so two edges sharing a query keep distinct overlays instead of
  // one clobbering the other (mirrors faceBoundaryGeos).
  //
  // Built on demand: at most a handful of these are ever drawn, but a body can
  // carry thousands of edges, and minting a BufferGeometry per edge at mount put
  // all of that between the finished solve and the first frame.
  const edgeBoundaryGeos = useMemo(() => {
    if (edges.length === 0) return null
    return lazyGeometryCache(i => (edges[i] ? buildEdgeSegments([edges[i]]) : null))
  }, [edges])

  useEffect(() => {
    return () => { edgeBoundaryGeos?.dispose() }
  }, [edgeBoundaryGeos])

  // Outline geometry for a hovered or selected B-rep face, keyed by face index
  // (not query) so two faces sharing a query keep distinct outlines. On demand
  // for the same reason as the edges above -- and here the eager build was
  // quadratic on top: buildFaceBoundarySegments scans the whole triangle list, so
  // asking it for every face cost O(faces x triangles) per body.
  const faceBoundaryGeos = useMemo(() => {
    if (!mesh.face_queries) return null
    return lazyGeometryCache(i => buildFaceBoundarySegments(mesh, i, faceTriangles.get(i)))
  }, [mesh, faceTriangles])

  useEffect(() => {
    return () => { faceBoundaryGeos?.dispose() }
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
    return topoFallbackQuery(bodyId, 'face', triangleIndex)
  }, [mesh, bodyId])

  // Which primitives the face colour buffer is divided into: B-rep faces when the
  // mesh carries usable per-face metadata, else one primitive per triangle (the
  // legacy query-membership path below). Both feed the same in-place painter, so
  // the two highlight paths differ only in what indexes their flags.
  const facePaintTarget = useMemo(() => {
    const numTris = faceCount(mesh.faces)
    const { triangle_to_face, face_queries } = mesh
    const brep = face_queries !== undefined && face_queries.length > 0
      && triangle_to_face !== undefined && triangle_to_face.length >= numTris
    if (!brep) return { brep: false as const, runs: triangleRuns(numTris) }
    return { brep: true as const, runs: faceRuns(face_queries.length, i => faceTriangles.get(i)) }
  }, [mesh, faceTriangles])

  // Legacy per-triangle highlight, for meshes carrying no usable B-rep face
  // metadata: membership in the raw query sets, triangle by triangle. Returns a
  // stable null on the B-rep path so the painter below need not depend on
  // `normalSelection` / `hoveredSelectionId` -- those change on every pointer move
  // and would otherwise re-diff the colour buffer of every body in the scene.
  const fallbackTriangleFlags = useMemo(() => {
    if (facePaintTarget.brep || !interactive) return null
    const numTris = faceCount(mesh.faces)
    const selected = new Array<boolean>(numTris)
    const hovered = new Array<boolean>(numTris)
    for (let i = 0; i < numTris; i++) {
      const query = resolveFaceQuery(i)
      selected[i] = normalSelection.has(query)
      hovered[i] = query === hoveredSelectionId
    }
    return { selected, hovered }
  }, [mesh, facePaintTarget, normalSelection, hoveredSelectionId, resolveFaceQuery, interactive])

  // The palettes. Only these three colours can move a primitive, and only a
  // change to one of them forces the painter to rewrite the whole buffer -- which
  // is why the body's own selection colour lives here and not in the flags.
  const facePalette = useMemo<HighlightPalette>(() => ({
    base: paletteRGB(bodyColor),
    selected: paletteRGB(COLOR_SELECTED),
    hovered: paletteRGB(blendWhite(bodyColor)),
  }), [bodyColor])

  const edgePalette = useMemo<HighlightPalette>(() => ({
    base: paletteRGB(edgeColor),
    selected: paletteRGB(COLOR_SELECTED),
    hovered: paletteRGB(COLOR_HOVER),
  }), [edgeColor])

  // Face and edge colours are painted IN PLACE on the attribute the geometry was
  // built with: only the primitives whose highlight state changed are rewritten,
  // and only their float ranges are uploaded. Rebuilding the whole buffer (and
  // handing it to a fresh BufferAttribute, which re-allocates the GL buffer) cost
  // O(triangles + segments) plus a full re-upload on EVERY pointer move -- tens of
  // megabytes per move on an imported solid, which is what pinned hover under
  // 1 fps there. vertexColors stays permanently enabled either way, so the
  // material never recompiles.
  useHighlightColors({
    geometry,
    runs: facePaintTarget.runs,
    selected: !interactive ? null
      : facePaintTarget.brep ? faceSelectionFlags : (fallbackTriangleFlags?.selected ?? null),
    hovered: !interactive ? null
      : facePaintTarget.brep ? faceHoverFlags : (fallbackTriangleFlags?.hovered ?? null),
    palette: facePalette,
  })

  const edgePaintRuns = useMemo(() => edgeRuns(edgeSegmentCounts), [edgeSegmentCounts])

  useHighlightColors({
    geometry: edgeGeometry,
    runs: edgePaintRuns,
    // Hover isolates the single hovered edge (edgeHoverFlags resolves by pick
    // key, then query): two edges sharing a query must not co-highlight.
    selected: interactive ? edgeSelectionFlags : null,
    hovered: interactive ? edgeHoverFlags : null,
    palette: edgePalette,
  })

  const vertexMeshRef = useRef<THREE.InstancedMesh>(null)
  const vertexDotRef = useRef<THREE.InstancedMesh>(null)

  // One painter per instanced mesh: each re-writes its instances only when its
  // inputs actually change, instead of once per frame per vertex.
  const hitSpherePainter = useMemo(() => new VertexInstancePainter(), [])
  const dotPainter = useMemo(() => new VertexInstancePainter(), [])

  useFrame(({ camera }) => {
    const vmesh = vertexMeshRef.current
    if (!vmesh || !vertices?.length) return

    // Scale vertex spheres to POINT_HIT_PIXELS screen radius (same as 2D vertex dots).
    hitSpherePainter.sync({ target: vmesh, vertices, scale: POINT_HIT_PIXELS * p2w(camera) })

    const dmesh = vertexDotRef.current
    if (dmesh) {
      // Only show visual dots when a vertex is hovered or selected. Both are
      // resolved by pick key (via vertexSelectionFlags / vertexHoverFlags) so a
      // shared-query sibling does not co-show, mirroring the face path.
      // hasAny short-circuits on the shared all-false answer, so the common
      // "nothing of mine is picked" case costs one identity check per frame
      // instead of a scan per vertex per body.
      const hasHover = vertexHighlightIndex?.hasAny(vertexHoverFlags) ?? false
      const hasSelection = vertexHighlightIndex?.hasAny(vertexSelectionFlags) ?? false

      dmesh.visible = hasHover || hasSelection
      if (dmesh.visible) {
        dotPainter.sync({
          target: dmesh,
          vertices,
          scale: POINT_VIS_PIXELS * p2w(camera),
          // Reference-stable while a pick holds (see HighlightIndex), which is what
          // lets the painter treat identity as the whole change test.
          selected: vertexSelectionFlags,
          hovered: vertexHoverFlags,
          selectedColor: DOT_COLOR_SELECTED,
          hoveredColor: DOT_COLOR_HOVER,
        })
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
          roughness={surface.roughness}
          metalness={surface.metalness}
          transmission={surface.transmission}
          envMapIntensity={ENV_MAP_INTENSITY}
          side={THREE.DoubleSide}
          vertexColors={true}
          polygonOffset={true}
          polygonOffsetFactor={1}
          polygonOffsetUnits={1}
          transparent={surface.transparency > 0 || surface.transmission > 0}
          depthWrite={surface.transparency === 0 && surface.transmission === 0}
          opacity={1 - surface.transparency}
          blending={surface.transparency > 0 || surface.transmission > 0 ? THREE.CustomBlending : THREE.NormalBlending}
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
            {/* Radius 1, scaled to POINT_HIT_PIXELS screen px by useFrame */}
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
      {/* The hasAny guards keep a re-render triggered by someone else's hover
          from walking this body's primitive lists just to emit nothing. */}
      {interactive && edgeBoundaryGeos && edgeHighlightIndex.hasAny(edgeHoverFlags) && edgeHoverFlags.map((hovered, edgeIdx) => {
        // Selection outranks hover: skip the hover overlay where the selection
        // overlay already draws, so precedence is explicit and not a JSX draw-order
        // accident (mirrors the edgeColors if/else-if).
        if (!hovered || edgeSelectionFlags[edgeIdx]) return null
        const geo = edgeBoundaryGeos.get(edgeIdx)
        if (!geo) return null
        return (
          <lineSegments key={`edge-hover-${edgeIdx}`} geometry={geo}>
            <lineBasicMaterial color={COLOR_HOVER} linewidth={EDGE_HIGHLIGHT_LINE_WIDTH} depthTest={false} />
          </lineSegments>
        )
      })}
      {interactive && edgeBoundaryGeos && edgeHighlightIndex.hasAny(edgeSelectionFlags) && edgeSelectionFlags.map((selected, edgeIdx) => {
        if (!selected) return null
        const geo = edgeBoundaryGeos.get(edgeIdx)
        if (!geo) return null
        return (
          <lineSegments key={edgeIdx} geometry={geo} renderOrder={RENDER_ORDER_HIGHLIGHT}>
            <lineBasicMaterial color={COLOR_SELECTED} linewidth={EDGE_HIGHLIGHT_LINE_WIDTH} depthTest={false} transparent />
          </lineSegments>
        )
      })}
      {interactive && faceBoundaryGeos && faceHighlightIndex?.hasAny(faceHoverFlags) && faceHoverFlags!.map((hovered, faceIdx) => {
        // Selection outranks hover: skip the hover overlay where the selection
        // overlay already draws (mirrors the faceColors if/else-if precedence).
        if (!hovered || faceSelectionFlags?.[faceIdx]) return null
        const geo = faceBoundaryGeos.get(faceIdx)
        if (!geo) return null
        return (
          <lineSegments key={`face-hover-${faceIdx}`} geometry={geo}>
            <lineBasicMaterial color={COLOR_HOVER} linewidth={EDGE_HIGHLIGHT_LINE_WIDTH} depthTest={false} />
          </lineSegments>
        )
      })}
      {interactive && faceBoundaryGeos && faceHighlightIndex?.hasAny(faceSelectionFlags) && faceSelectionFlags!.map((selected, faceIdx) => {
        if (!selected) return null
        const geo = faceBoundaryGeos.get(faceIdx)
        if (!geo) return null
        return (
          <lineSegments key={faceIdx} geometry={geo}>
            <lineBasicMaterial color={COLOR_SELECTED} linewidth={EDGE_HIGHLIGHT_LINE_WIDTH} depthTest={false} transparent />
          </lineSegments>
        )
      })}
    </group>
  )
}
