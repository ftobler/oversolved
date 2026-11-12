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
  COLOR_SELECTED, COLOR_HOVER, COLOR_HINT, COLOR_HINT_FAILED,
  blendWhite, blendToward, HINT_BLEND,
  POINT_VIS_PIXELS,
  DEFAULT_PART_ROUGHNESS,
  RENDER_ORDER_DEFAULT,
  RENDER_ORDER_HIGHLIGHT,
} from '@/components/Geometry3D/constants'
import {
  buildBodySurfaceGeometry,
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
import { analysisMaterialName, useBodyAnalysisMaterial } from '@/components/Geometry3D/bodyAnalysisMaterial'
import { applyAoOccluder, isAoActive } from '@/components/Viewport/ambientOcclusion'
import { curvatureForMesh, effectiveCurvatureRange } from '@/components/Geometry3D/curvature'
import { buildThreadAttributes, type ThreadSiteIndex } from '@/components/Geometry3D/threadShading'
import { useViewOptionsStore } from '@/stores/viewOptionsStore'
import { useSectionStore } from '@/stores/sectionStore'
import { lazyGeometryCache } from '@/components/Geometry3D/lazyGeometryCache'
import { faceRuns, triangleRuns, edgeRuns, type HighlightPalette } from '@/components/Geometry3D/highlightColorPainter'
import { useHighlightColors, paletteRGB } from '@/components/Geometry3D/useHighlightColors'
import { VertexInstancePainter } from '@/components/Geometry3D/vertexInstancePainter'
import { HighlightOverlays } from '@/components/Geometry3D/highlightOverlay'
import { useFaceIdRegistration, useEdgeIdRegistration, useVertexIdRegistration } from '@/picking'
import { bodyKeyFor } from '@/picking/pickKey'
import { FACE_LAYER_NAME, EDGE_LAYER_NAME, VERTEX_LAYER_NAME } from '@/picking/layerNames'
import SectionCap from '@/components/Geometry3D/SectionCap'
import { getSectionClipPlaneList } from '@/viewport/sectionClipping'
import {
  useSectionActive,
  useSectionOwnedMaterialClipping,
} from '@/viewport/useSection'
import { HighlightIndex, orFlags, type ActiveHighlight } from '@/picking/selectionHighlight'
import { selectActiveFrom, hoverActiveFrom, EMPTY_CLAIM_MAP } from '@/picking/highlightActive'
import { HintIndex, edgeCreatorsOf, faceCreatorsOf } from '@/picking/relationHint'
import { usePartRelationHints } from '@/hooks/useRelationHint'
import { topoFallbackQuery } from '@/utils/query/selectionId'
import { buildEdgeMaterial } from '@/components/Geometry3D/edgeLineMaterial'
import { ENV_MAP_INTENSITY } from '@/components/Viewport/EnvLight'
import { registerBodyCallbacks } from '@/picking/bodyDispatchCallbacks'

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
  // Per-edge creating feature, aligned with `edgeQueries`. The wireframe hint
  // reads it; a body decoded before the field existed falls back to the query
  // lineage.
  edgeCreatedBy?: string[]
  vertices?: [number, number, number][]
  vertexQueries?: string[]
  // The body's sparse display-only indices (BodyResult.hidden_edges /
  // hidden_vertices): a periodic face's own seam and the vertices that end no
  // visible open edge. Not drawn and not registered in the ID buffer; the
  // hover/selection overlays below still draw one that was picked headlessly.
  hiddenEdges?: readonly number[]
  hiddenVertices?: readonly number[]
  visible?: boolean
  color?: string
  transparency?: number  // 0-1 (0 = opaque, 1 = fully transparent)
  metalness?: number     // 0-1 (0 = non-metallic, 1 = fully metallic)
  roughness?: number     // 0-1 (0 = smooth, 1 = rough)
  transmission?: number  // 0-1 (0 = opaque, 1 = fully transmissive / glass-like)
  interactive?: boolean
  doomed?: boolean  // ghost of a body the previewed edit consumes: drawn "doomed", still pickable
  // The viewer's Shading and Edges rows. A hidden layer is neither drawn nor
  // registered in the ID buffer: what is not drawn must not be pickable, or a
  // wireframe would keep blocking clicks on the edges the user can see.
  showFaces?: boolean
  showEdges?: boolean
  // Stable position in the viewport's body list; owns the section cap's render
  // order band so bodies cannot interleave their stencil passes.
  capBand?: number
  // The part's tapped bores by bore-face UUID (null: none). The body shades
  // the faces of its own mesh that carry one of them.
  threadSites?: ThreadSiteIndex | null
}

export default function Body3D({ featureId, bodyId, mesh, edges = NO_EDGES, edgeQueries, edgeCreatedBy, vertices, vertexQueries, hiddenEdges, hiddenVertices, visible = true, color, transparency = 0, metalness = 0, roughness = DEFAULT_PART_ROUGHNESS, transmission = 0, interactive = true, doomed = false, showFaces = true, showEdges = true, capBand = 0, threadSites = null }: Body3DProps) {
  // One Set per list, stable across renders, so the edge geometry memo and both
  // registration hooks only re-run when the body's kernel lists actually change.
  const hiddenEdgeSet = useMemo(
    () => (hiddenEdges && hiddenEdges.length > 0 ? new Set(hiddenEdges) : undefined),
    [hiddenEdges],
  )
  const hiddenVertexSet = useMemo(
    () => (hiddenVertices && hiddenVertices.length > 0 ? new Set(hiddenVertices) : undefined),
    [hiddenVertices],
  )
  useFaceIdRegistration({ featureId, bodyId, mesh, enabled: interactive && visible && showFaces })
  useEdgeIdRegistration({
    featureId, bodyId, edges, edgeQueries,
    hiddenEdges: hiddenEdgeSet,
    enabled: interactive && visible && showEdges,
  })
  useVertexIdRegistration({
    featureId, bodyId, vertices, vertexQueries,
    hiddenVertices: hiddenVertexSet,
    enabled: interactive && visible,
  })
  const hoveredSelectionId = useSketchEditorStore(s => s.hoveredSelectionId)
  const hoveredPickKey = useSketchEditorStore(s => s.hoveredPickKey)
  const normalSelection = useSketchEditorStore(s => s.normalSelection)
  const selectedPicks = useSketchEditorStore(s => s.selectedPicks)
  const setHoveredFaceGeometry = useSketchEditorStore(s => s.setHoveredFaceGeometry)
  // The feature/sketch ids a selected tree row relates to, and the primitive
  // queries a selected or edited modifier picked. Every body reads the same
  // derived sets through the one hook, so two bodies cannot disagree about
  // which of their faces a row tints or which picked edge it draws.
  const relationHints = usePartRelationHints()
  const hintedFeatureIds = relationHints.viewport
  const pickedHintQueries = relationHints.picked
  const failedPickHintQueries = relationHints.failedPicks

  // The curvature row needs an attribute on the geometry, so it is read here
  // rather than at render time only. The auto range is published by the
  // viewport once it has sampled every visible body.
  const curvature = useViewOptionsStore(s => s.curvature)
  const curvatureKind = useViewOptionsStore(s => s.curvature_kind)
  const curvatureManualRange = useViewOptionsStore(s => s.curvature_range)
  const curvatureAutoRange = useViewOptionsStore(s => s.curvatureAutoRange)
  const curvatureActive = showFaces && curvature

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

  // The creator of each face, aligned with the same resolved face list the
  // selection HighlightIndex and the paint runs use. `face_created_by` wins; an
  // older body recovers the creator from the query lineage, then falls back to
  // the body's own creator (picking/relationHint).
  const faceCreators = useMemo(
    () => faceCreatorsOf(mesh, featureId, faceQueriesResolved?.length ?? 0),
    [mesh, featureId, faceQueriesResolved],
  )

  const faceHintIndex = useMemo(
    () => (faceQueriesResolved ? new HintIndex(faceCreators) : null),
    [faceQueriesResolved, faceCreators],
  )

  // A doomed body paints no hint: its removal look is one look for every
  // removal. A body with no hinted creator gets the shared all-false array, so
  // its memos stay identity-stable while another body is hinted.
  const faceHintFlags = useMemo(
    () => (!interactive || doomed ? null : faceHintIndex?.compute(hintedFeatureIds) ?? null),
    [interactive, doomed, faceHintIndex, hintedFeatureIds],
  )

  // The picked-primitive hint answers by query, exactly like the selection
  // highlight: a pick names one primitive, not a creator's output. A pick the
  // last solve refused is the failure tier of the same answer, so it goes to
  // the separate colour the chips already use.
  const facePickedHintFlags = useMemo(
    () => (!interactive || doomed || !faceHighlightIndex ? null
      : faceHighlightIndex.compute({ pickKeys: EMPTY_CLAIM_MAP, queries: pickedHintQueries })),
    [interactive, doomed, faceHighlightIndex, pickedHintQueries],
  )

  const faceFailedPickHintFlags = useMemo(
    () => (!interactive || doomed || !faceHighlightIndex ? null
      : faceHighlightIndex.compute({ pickKeys: EMPTY_CLAIM_MAP, queries: failedPickHintQueries })),
    [interactive, doomed, faceHighlightIndex, failedPickHintQueries],
  )

  // The wireframe hint mirrors the face one; an edge-only body (shading off)
  // still shows which feature made its edges. The legacy per-triangle face path
  // carries no B-rep face creators, so it gets no face hint -- there is no
  // feature attribution to paint.
  const edgeCreators = useMemo(
    () => edgeCreatorsOf({
      id: bodyId,
      created_by: featureId,
      modified_by: [],
      edges,
      edge_queries: edgeQueries,
      edge_created_by: edgeCreatedBy,
    }),
    [bodyId, featureId, edges, edgeQueries, edgeCreatedBy],
  )

  const edgeHintIndex = useMemo(() => new HintIndex(edgeCreators), [edgeCreators])

  const edgeHintFlags = useMemo(
    () => (!interactive || doomed ? null : edgeHintIndex.compute(hintedFeatureIds)),
    [interactive, doomed, edgeHintIndex, hintedFeatureIds],
  )

  const edgePickedHintFlags = useMemo(
    () => (!interactive || doomed ? null
      : edgeHighlightIndex.compute({ pickKeys: EMPTY_CLAIM_MAP, queries: pickedHintQueries })),
    [interactive, doomed, edgeHighlightIndex, pickedHintQueries],
  )

  const edgeFailedPickHintFlags = useMemo(
    () => (!interactive || doomed ? null
      : edgeHighlightIndex.compute({ pickKeys: EMPTY_CLAIM_MAP, queries: failedPickHintQueries })),
    [interactive, doomed, edgeHighlightIndex, failedPickHintQueries],
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

  // Cheap gates for the outline overlays. `hasAny` is O(1) on the shared
  // all-false answer, so an untouched body never walks its primitive lists just
  // to draw nothing.
  const edgeOverlayActive = useMemo(
    () => edgeHighlightIndex.hasAny(edgeSelectionFlags) || edgeHighlightIndex.hasAny(edgeHoverFlags),
    [edgeHighlightIndex, edgeSelectionFlags, edgeHoverFlags],
  )
  const faceOverlayActive = useMemo(
    () => faceHighlightIndex !== null
      && (faceHighlightIndex.hasAny(faceSelectionFlags) || faceHighlightIndex.hasAny(faceHoverFlags)),
    [faceHighlightIndex, faceSelectionFlags, faceHoverFlags],
  )

  // Null for a body with no tapped bore (the common case), so a solve that
  // changes some other hole's thread leaves this body's geometry memo alone.
  const threadAttributes = useMemo(() => buildThreadAttributes(mesh, threadSites), [mesh, threadSites])

  const geometry = useMemo(() => {
    const indexed = buildBodySurfaceGeometry(mesh)
    if (curvatureActive) {
      // The field follows the indexed vertex order, and toNonIndexed below
      // copies this attribute per split vertex exactly like the smooth normals.
      indexed.setAttribute('aCurvature', new THREE.BufferAttribute(curvatureForMesh(mesh).values, 2))
    }
    if (threadAttributes !== null) {
      // Indexed like aCurvature, for the same reason.
      indexed.setAttribute('aThreadCoord', new THREE.BufferAttribute(threadAttributes.coord, 4))
      indexed.setAttribute('aThreadAxis', new THREE.BufferAttribute(threadAttributes.axis, 3))
    }
    // toNonIndexed gives each triangle its own vertex slots so faceColors[i*9..i*9+8]
    // maps 1:1 to face i without bleeding into shared-vertex neighbors. The
    // smooth normals computed on the indexed form are copied per split vertex,
    // which is what zebra keeps continuous across a curved face.
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
  }, [mesh, curvatureActive, threadAttributes])

  useDispose(geometry)

  // Positions AND the per-edge segment counts from ONE traversal, so the
  // painter's run offsets and the colour buffer it writes can never disagree
  // about which edges were skipped (a degenerate edge shifted every later offset
  // before). The hidden seam set is the same one the ID layer uses.
  const edgeSegmentGeometry = useMemo(
    () => buildEdgeSegmentGeometry(edges, hiddenEdgeSet),
    [edges, hiddenEdgeSet],
  )

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

  // The analysis material replaces the surface colour only where faces are
  // drawn; with shading off there is nothing for it to paint.
  const zebra = useViewOptionsStore(s => s.zebra)
  const zebraStripes = useViewOptionsStore(s => s.zebra_stripes)
  const ambientOcclusion = useViewOptionsStore(s => s.ambient_occlusion)
  const aoStrength = useViewOptionsStore(s => s.ao_strength)
  const sectionCapturing = useSectionStore(s => s.capturing)
  // The store keeps the two analysis rows exclusive; the order here only makes
  // the intent readable.
  const analysisMode = !showFaces ? 'none' : curvature ? 'curvature' : zebra ? 'zebra' : 'none'
  const bodyMaterialRef = useRef<THREE.MeshPhysicalMaterial>(null)
  const sectionActive = useSectionActive()
  // A callback ref rather than an effect: the face mesh is unmounted by the
  // Shading row, and an effect keyed on transparency alone would leave every
  // remounted mesh out of the AO pre-pass. The identity follows the surface, so
  // a body that turns to glass while mounted is re-applied too.
  const occluder = surface.transparency === 0 && surface.transmission === 0
  const attachFaceMesh = useCallback((mesh: THREE.Mesh | null) => {
    if (!mesh) return
    applyAoOccluder(mesh.layers, occluder)
  }, [occluder])

  useBodyAnalysisMaterial(bodyMaterialRef, {
    mode: analysisMode,
    // The part editor is the one place with a vertex-colour highlight, so the
    // analysis program mixes it back in instead of overwriting the selection.
    mixVertexColor: true,
    baseColor: bodyColor,
    zebraStripes,
    curvatureKind,
    curvatureRange: effectiveCurvatureRange(curvatureManualRange, curvatureAutoRange),
    threaded: threadAttributes !== null,
    ao: isAoActive({
      option: ambientOcclusion,
      shading: showFaces,
      zebra,
      curvature,
      section: sectionActive,
      capturing: sectionCapturing,
    }),
    aoStrength,
    transparent: surface.transparency > 0 || surface.transmission > 0,
  })

  // The section clips the body's faces and edges, not the reference geometry
  // around them. The cap is the fill of the cut itself, in the body's colour.
  // The face material carries the plane as a JSX prop because the mesh is
  // unmounted and remounted by the Shading row; the edge material is one
  // memo-owned instance for the component's lifetime. Only the active boolean
  // is subscribed here, not the moving plane: the shared plane updates in
  // place, so a drag must not re-render every body.
  useSectionOwnedMaterialClipping(edgeMaterial, sectionActive)

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

  // The palettes. Only these five colours can move a primitive, and only a
  // change to one of them forces the painter to rewrite the whole buffer -- which
  // is why the body's own selection colour lives here and not in the flags. Two
  // slots are hint tiers: the creator/pick hint and the refused-pick mark.
  const facePalette = useMemo<HighlightPalette>(() => ({
    base: paletteRGB(bodyColor),
    selected: paletteRGB(COLOR_SELECTED),
    hovered: paletteRGB(blendWhite(bodyColor)),
    hinted: paletteRGB(blendToward(bodyColor, COLOR_HINT, HINT_BLEND)),
    hintedFailed: paletteRGB(blendToward(bodyColor, COLOR_HINT_FAILED, HINT_BLEND)),
  }), [bodyColor])

  const edgePalette = useMemo<HighlightPalette>(() => ({
    base: paletteRGB(edgeColor),
    selected: paletteRGB(COLOR_SELECTED),
    hovered: paletteRGB(COLOR_HOVER),
    hinted: paletteRGB(COLOR_HINT),
    hintedFailed: paletteRGB(COLOR_HINT_FAILED),
  }), [edgeColor])

  // The two hint answers share one colour tier, so they reach the painter as one
  // array. `orFlags` keeps the single-answer reference, which is what a body
  // with only one kind of hint (most of them) hands the memo.
  const faceHintPaintFlags = useMemo(
    () => (facePaintTarget.brep ? orFlags(faceHintFlags, facePickedHintFlags) : null),
    [facePaintTarget, faceHintFlags, facePickedHintFlags],
  )

  const edgeHintPaintFlags = useMemo(
    () => orFlags(edgeHintFlags, edgePickedHintFlags),
    [edgeHintFlags, edgePickedHintFlags],
  )

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
    hinted: faceHintPaintFlags,
    // A refused pick is painted on the B-rep face path only: the legacy
    // per-triangle path exists for meshes with no face names, and a named pick
    // cannot land on one.
    hintedFailed: facePaintTarget.brep ? faceFailedPickHintFlags : null,
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
    hinted: interactive ? edgeHintPaintFlags : null,
    hintedFailed: interactive ? edgeFailedPickHintFlags : null,
    palette: edgePalette,
  })

  const vertexDotRef = useRef<THREE.InstancedMesh>(null)

  // Re-writes the dot instances only when its inputs actually change, instead
  // of once per frame per vertex.
  const dotPainter = useMemo(() => new VertexInstancePainter(), [])

  useFrame(({ camera }) => {
    // A hidden body (rollback bar, per-body hide) is still mounted as
    // <Body3D visible={false}>; without this every camera move recomposes and
    // re-uploads one matrix per vertex for geometry nobody can see.
    if (!visible || !vertices?.length) return
    const dmesh = vertexDotRef.current
    if (!dmesh) return
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
  })

  // The removal mark is the doomed body's wireframe, and the plan keeps it
  // visible through either row: a consumed body must stay identifiable while
  // the user is still choosing what the edit takes. It is not made pickable by
  // this, though -- the edge ID registration above follows `showEdges` alone.
  const drawEdges = (showEdges || doomed) && edges.length > 0

  return (
    <group visible={visible} userData={{ featureId }}>
      {showFaces && (
        <mesh
          ref={attachFaceMesh}
          geometry={geometry}
          userData={{ orbitPivot: true }}
        >
          <meshPhysicalMaterial
            ref={bodyMaterialRef}
            name={analysisMaterialName(analysisMode)}
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
            clippingPlanes={sectionActive ? getSectionClipPlaneList() : null}
          />
        </mesh>
      )}
      {drawEdges && (
        <lineSegments
          geometry={edgeGeometry}
          material={edgeMaterial}
          renderOrder={RENDER_ORDER_DEFAULT}
        />
      )}
      {vertices && vertices.length > 0 && (
        // The beauty pass draws only the hover/selection dot: B-rep vertices are
        // picked through the offscreen ID buffer (picking/VertexIdLayer), never
        // by raycasting a scene mesh, so the opacity-0 hit sphere this used to
        // carry was invisible work on every frame.
        <instancedMesh
          ref={vertexDotRef}
          args={[undefined, undefined, vertices.length]}
          visible={false}
          frustumCulled={false}
          renderOrder={RENDER_ORDER_HIGHLIGHT}
        >
          {/* Radius 1, scaled to POINT_VIS_PIXELS screen px by useFrame */}
          <sphereGeometry args={[1, 6, 6]} />
          <meshBasicMaterial
            color="white"
            depthTest={false}
            depthWrite={false}
            clippingPlanes={sectionActive ? getSectionClipPlaneList() : null}
          />
        </instancedMesh>
      )}
      {/* One overlay recipe for hover and selection, on both layer kinds: the
          colours differ, the transparency and render order never do. The
          section cap and any transparent body draw in lower bands, so this is
          what keeps a hovered edge or face visible on a sectioned body. */}
      {interactive && showEdges && (
        <HighlightOverlays
          geos={edgeBoundaryGeos}
          selected={edgeSelectionFlags}
          hovered={edgeHoverFlags}
          selectedColor={COLOR_SELECTED}
          hoveredColor={COLOR_HOVER}
          clippingPlanes={sectionActive ? getSectionClipPlaneList() : null}
          active={edgeOverlayActive}
        />
      )}
      {showFaces && sectionActive && (
        <SectionCap geometry={geometry} color={bodyColor} enabled={visible} band={capBand} />
      )}
      {interactive && showFaces && (
        <HighlightOverlays
          geos={faceBoundaryGeos}
          selected={faceSelectionFlags}
          hovered={faceHoverFlags}
          selectedColor={COLOR_SELECTED}
          hoveredColor={COLOR_HOVER}
          clippingPlanes={sectionActive ? getSectionClipPlaneList() : null}
          active={faceOverlayActive}
        />
      )}
    </group>
  )
}
