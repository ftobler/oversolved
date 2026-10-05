import { useMemo, useEffect, useCallback, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import type { Mesh3D, EdgeData } from '@/types/cad'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { p2w } from '@/utils/geometry/sketchHelpers'
import {
  COLOR_BODY_DEFAULT,
  COLOR_BODY_EDGE, COLOR_BODY_EDGE_SEL, COLOR_BODY_REMOVED,
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
  planarFaceFrame,
  buildEdgeSegments,
  buildEdgeSegmentGeometry,
  faceCount,
  lazyFaceTriangles,
  resolveFaceQueries,
  resolveEdgeQueries,
  resolveVertexQueries,
} from '@/components/Geometry3D/bodyGeometry'
import { lazyGeometryCache } from '@/components/Geometry3D/lazyGeometryCache'
import { faceRuns, triangleRuns, edgeRuns, type HighlightPalette } from '@/components/Geometry3D/highlightColorPainter'
import { useHighlightColors, paletteRGB } from '@/components/Geometry3D/useHighlightColors'
import { VertexInstancePainter } from '@/components/Geometry3D/vertexInstancePainter'
import { useFaceIdRegistration, useEdgeIdRegistration, useVertexIdRegistration } from '@/picking'
import { bodyKeyFor } from '@/picking/pickKey'
import { FACE_LAYER_NAME, EDGE_LAYER_NAME, VERTEX_LAYER_NAME } from '@/picking/layerNames'
import { HighlightIndex, type ActiveHighlight } from '@/picking/selectionHighlight'
import { selectActiveFrom, hoverActiveFrom, EMPTY_CLAIM_MAP } from '@/picking/highlightActive'
import { topoFallbackQuery } from '@/utils/query/selectionId'
import { buildEdgeMaterial } from '@/components/Geometry3D/edgeLineMaterial'
import { ENV_MAP_INTENSITY } from '@/components/Viewport/EnvLight'
import { registerBodyCallbacks } from '@/components/Viewport/idDispatch/bodyDispatchCallbacks'

function useDispose<T extends { dispose(): void }>(obj: T | null | undefined): void {
  useEffect(() => { return () => { obj?.dispose() } }, [obj])
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

// Shared empty resolved-query list so a body with no edges keeps one identity
// for the edge HighlightIndex memo dep across renders.
const NO_QUERIES: string[] = []

interface Body3DProps {
  featureId: string
  bodyId: string
  mesh: Mesh3D
  edges?: EdgeData[]
  edgeQueries?: string[]
  vertices?: [number, number, number][]
  vertexQueries?: string[]
  visible?: boolean
  color?: string
  transparency?: number  // 0-1 (0 = opaque, 1 = fully transparent)
  metalness?: number     // 0-1 (0 = non-metallic, 1 = fully metallic)
  roughness?: number     // 0-1 (0 = smooth, 1 = rough)
  transmission?: number  // 0-1 (0 = opaque, 1 = fully transmissive / glass-like)
  interactive?: boolean
  doomed?: boolean  // ghost of a body the previewed edit consumes: drawn "doomed", still pickable
}

export default function Body3D({ featureId, bodyId, mesh, edges = NO_EDGES, edgeQueries, vertices, vertexQueries, visible = true, color, transparency = 0, metalness = 0, roughness = DEFAULT_PART_ROUGHNESS, transmission = 0, interactive = true, doomed = false }: Body3DProps) {
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
  // A face with no frame (curved, or untessellated) clears the fields rather than
  // leaving the previous face's frame behind for "Normal to" to aim at.
  const updateFaceGeometryForIndex = useCallback((brepFaceIndex: number) => {
    const frame = planarFaceFrame(mesh, brepFaceIndex, faceTriangles.get(brepFaceIndex))
    setHoveredFaceGeometry(frame?.normal ?? null, frame?.center ?? null)
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
    const bodyKey = bodyKeyFor(featureId, bodyId)
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
  // primitive list every edge highlight decision indexes into, and the SAME
  // list the edge ID layer registers from (see useEdgeIdRegistration) so a
  // padded tail edge is pickable exactly when it is highlightable. The fallback
  // is keyed on the BODY: this feature's split siblings each index their own
  // edges from 0, so a feature-keyed fallback gave two different edges one query.
  const edgeQueriesResolved = useMemo(
    () => resolveEdgeQueries(edges, edgeQueries, bodyId) ?? NO_QUERIES,
    [bodyId, edgeQueries, edges],
  )

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

  // Resolved query per B-rep face (real query, else a topo fallback), padded to
  // the rendered face count. The single list both the face HighlightIndex and
  // the painter's face runs count from, so a kernel that returns fewer face
  // queries than the tessellation contains still leaves every face highlightable
  // -- and the two consumers can never disagree about how many faces there are.
  const faceQueriesResolved = useMemo(
    () => resolveFaceQueries(mesh, bodyId),
    [mesh, bodyId],
  )

  // Face highlight, decoupled from raw query membership exactly like edges:
  // sibling faces sharing an ancestral query (no minted UUID) must not co-highlight.
  // Indexed by B-rep face index; null when the mesh carries no face queries, or
  // when triangle_to_face is absent or does not cover the triangles (the
  // fallback path below keeps the legacy per-triangle query-membership highlight).
  const faceHighlightIndex = useMemo(
    () => faceQueriesResolved && new HighlightIndex(bodyKey, FACE_LAYER_NAME, faceQueriesResolved),
    [bodyKey, faceQueriesResolved],
  )

  const faceSelectionFlags = useMemo(
    () => faceHighlightIndex?.compute(selectActive) ?? null,
    [faceHighlightIndex, selectActive],
  )

  const faceHoverFlags = useMemo(
    () => faceHighlightIndex?.compute(hoverActive) ?? null,
    [faceHighlightIndex, hoverActive],
  )

  // Resolved query per vertex, mirroring edges: the same padded list the vertex
  // ID layer registers from, so a fallback vertex picks where it highlights.
  const vertexQueriesResolved = useMemo(
    () => resolveVertexQueries(vertices, vertexQueries, bodyId),
    [bodyId, vertices, vertexQueries],
  )

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

  // hasAny is O(1) for the shared all-false answer but O(vertices) otherwise, and
  // useFrame asks it twice a frame. Cache it next to the flags it reads so a
  // picked body pays the scan once per pick, not once per frame.
  const hasVertexSelection = useMemo(
    () => vertexHighlightIndex?.hasAny(vertexSelectionFlags) ?? false,
    [vertexHighlightIndex, vertexSelectionFlags],
  )
  const hasVertexHover = useMemo(
    () => vertexHighlightIndex?.hasAny(vertexHoverFlags) ?? false,
    [vertexHighlightIndex, vertexHoverFlags],
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

  // Positions AND the per-edge segment counts from ONE traversal, so the
  // painter's run offsets and the colour buffer it writes can never disagree
  // about which edges were skipped (a degenerate edge shifted every later offset
  // before).
  const edgeSegmentGeometry = useMemo(() => buildEdgeSegmentGeometry(edges), [edges])

  const edgeGeometry = useMemo(() => {
    const geo = new THREE.BufferGeometry()
    const pts = edgeSegmentGeometry.positions
    geo.setAttribute('position', new THREE.BufferAttribute(pts, 3))
    // Pre-fill color attribute so vertexColors=true doesn't flash black on first render.
    const { r, g, b } = new THREE.Color(COLOR_BODY_EDGE)
    const initialColors = new Float32Array(pts.length)
    for (let i = 0; i < pts.length / 3; i++) {
      initialColors[i * 3] = r; initialColors[i * 3 + 1] = g; initialColors[i * 3 + 2] = b
    }
    geo.setAttribute('color', new THREE.BufferAttribute(initialColors, 3))
    return geo
  }, [edgeSegmentGeometry])

  useDispose(edgeGeometry)

  const edgeMaterial = useMemo(() => buildEdgeMaterial(), [])
  useDispose(edgeMaterial)

  // The whole surface is one decision (see bodySurfaceLook for the precedence).
  const surface = bodySurfaceLook({
    selected: isBodySelected, doomed, color, transparency, metalness, roughness, transmission,
  })
  const bodyColor = surface.color

  // The wireframe is where the removal mark lives now the doomed face is
  // see-through: a consumed body's edges turn pink so the mark shows WHICH
  // body is leaving. Selection still outranks removal, mirroring the face
  // precedence in bodySurfaceLook -- the re-click affordance needs the change
  // to be visible while the user points at it.
  const edgeColor = isBodySelected
    ? COLOR_BODY_EDGE_SEL
    : doomed ? COLOR_BODY_REMOVED : COLOR_BODY_EDGE

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
    return topoFallbackQuery(bodyId, 'tri', triangleIndex)
  }, [mesh, bodyId])

  // Which primitives the face colour buffer is divided into: B-rep faces when the
  // mesh carries usable per-face metadata, else one primitive per triangle (the
  // legacy query-membership path below). The face runs count from the SAME
  // resolved query list as the HighlightIndex above, so a padded tail face is a
  // paint primitive exactly when it is a highlight primitive.
  const facePaintTarget = useMemo(() => {
    const numTris = faceCount(mesh.faces)
    if (!faceQueriesResolved) return { brep: false as const, runs: triangleRuns(numTris) }
    return { brep: true as const, runs: faceRuns(faceQueriesResolved.length, i => faceTriangles.get(i)) }
  }, [faceQueriesResolved, faceTriangles, mesh])

  // Legacy per-triangle highlight, for meshes carrying no usable B-rep face
  // metadata. The per-triangle queries are materialized ONCE per body and then
  // driven through the same HighlightIndex as the face-query path, so a hover
  // that does not touch the body is gated by `intersects` onto the shared
  // all-false `none` array -- instead of rebuilding two O(numTris) boolean
  // arrays on every pointer move for every legacy body in the scene. The old
  // direct scan keyed on `normalSelection` / `hoveredSelectionId` made every
  // such body allocate on every hover; the flags memos below now run the index
  // and skip on the identity of its answer.
  //
  // The retained cost is the string array itself: one `@body/tri/<tri>` query
  // per triangle, plus the index's query Set, held for the body's lifetime. On
  // a very large imported legacy mesh that is O(triangles) of strings, the same
  // order as the triangle data the mesh already holds, and is the price of
  // giving the fallback a stable cache instead of rebuilding per hover.
  const legacyFaceQueries = useMemo(() => {
    if (facePaintTarget.brep || !interactive) return null
    const numTris = faceCount(mesh.faces)
    const queries = new Array<string>(numTris)
    for (let i = 0; i < numTris; i++) queries[i] = resolveFaceQuery(i)
    return queries
  }, [mesh, facePaintTarget, resolveFaceQuery, interactive])

  const legacyFaceHighlightIndex = useMemo(
    () => legacyFaceQueries && new HighlightIndex(bodyKey, FACE_LAYER_NAME, legacyFaceQueries),
    [bodyKey, legacyFaceQueries],
  )

  // The legacy index is keyed by TRIANGLE index, but the id layer only ever
  // mints face pick keys keyed by the B-rep FACE index (FaceIdLayer registers
  // per face, even for the mapped-but-short meshes that land on this path). A
  // live per-face pick key parsed as a triangle index would claim the wrong
  // primitive and split a whole-face highlight. So the legacy path drops the
  // pick keys and decides by query membership alone -- exactly what the
  // pre-index fallback did -- while still letting `intersects` gate the
  // uninvolved-body answer onto the shared all-false array.
  const legacyFaceSelectionFlags = useMemo(
    () => legacyFaceHighlightIndex?.compute({ pickKeys: EMPTY_CLAIM_MAP, queries: selectActive.queries }) ?? null,
    [legacyFaceHighlightIndex, selectActive],
  )

  const legacyFaceHoverFlags = useMemo(
    () => legacyFaceHighlightIndex?.compute({ pickKeys: EMPTY_CLAIM_MAP, queries: hoverActive.queries }) ?? null,
    [legacyFaceHighlightIndex, hoverActive],
  )

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
      : facePaintTarget.brep ? faceSelectionFlags : (legacyFaceSelectionFlags ?? null),
    hovered: !interactive ? null
      : facePaintTarget.brep ? faceHoverFlags : (legacyFaceHoverFlags ?? null),
    palette: facePalette,
  })

  const edgePaintRuns = useMemo(() => edgeRuns(edgeSegmentGeometry.edgeSegmentCounts), [edgeSegmentGeometry])

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
    // A hidden body (rollback bar, per-body hide) is still mounted as
    // <Body3D visible={false}>; without this every camera move recomposes and
    // re-uploads one matrix per vertex for geometry nobody can see.
    if (!visible) return
    const vmesh = vertexMeshRef.current
    if (!vmesh || !vertices?.length) return

    // Scale vertex spheres to POINT_HIT_PIXELS screen radius (same as 2D vertex dots).
    hitSpherePainter.sync({ target: vmesh, vertices, scale: POINT_HIT_PIXELS * p2w(camera) })

    const dmesh = vertexDotRef.current
    if (dmesh) {
      // Only show visual dots when a vertex is hovered or selected. Both are
      // resolved by pick key (via vertexSelectionFlags / vertexHoverFlags) so a
      // shared-query sibling does not co-show, mirroring the face path. The
      // hasAny results are memoized above so a resting frame costs nothing.
      dmesh.visible = hasVertexHover || hasVertexSelection
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
