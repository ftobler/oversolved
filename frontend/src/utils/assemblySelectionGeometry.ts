// Highlight buffers for the assembly's B-rep selection, computed without a
// viewport.
//
// The part editor recolours a body's own vertex-colour attribute per face
// (Body3D). The assembly cannot: its render meshes carry no per-triangle face
// ids. But `pickGeometry` (AssemblyPickBody[]) already holds, per body, the
// non-indexed face triangles, the edge segments and the vertex points, each
// keyed by `assemblyEntityKey` and already in solved-pose world coordinates.
// So the overlay is built here by pulling out exactly the triangles/segments/
// points whose key is selected or hovered, and a thin component turns these
// into three.js geometry.
//
// The extraction is driven by the ACTIVE keys, never by a scan of the scene:
// see AssemblySelectionIndex. A pointer move changes `hovered` on every entity
// boundary it crosses, so a scan here would re-walk every triangle, segment and
// vertex of the whole assembly per move -- the shape that made hover unusable on
// an imported model with thousands of pickable entities.
//
// Pure: no three.js, no store. Selection wins over hover for an entity that is
// both, so a hovered-and-selected face draws once, in the selected colour.

import type { AssemblyPickBody } from '@/utils/assemblyPick'
import type { Vec3 } from '@/utils/transform3d'

export interface AssemblySelectionGeometry {
  /** Non-indexed triangle positions (9 floats per triangle). */
  selectedFaces: Float32Array
  hoveredFaces: Float32Array
  /** Line-segment positions (6 floats per segment). */
  selectedEdges: Float32Array
  hoveredEdges: Float32Array
  /** Face boundary-loop line segments (6 floats per segment), same precedence
   *  rule as the tint: a face that is both selected and hovered draws only here. */
  selectedFaceBoundary: Float32Array
  hoveredFaceBoundary: Float32Array
  selectedVertices: Vec3[]
  hoveredVertices: Vec3[]
}

// Shared empty results. Handed back by reference so a buffer that stays empty
// keeps its identity across builds and the component's per-buffer geometry memos
// skip instead of disposing and re-uploading. Never mutated.
const NO_FLOATS = new Float32Array(0)
const NO_POINTS: Vec3[] = []

const EMPTY: AssemblySelectionGeometry = {
  selectedFaces: NO_FLOATS,
  hoveredFaces: NO_FLOATS,
  selectedEdges: NO_FLOATS,
  hoveredEdges: NO_FLOATS,
  selectedFaceBoundary: NO_FLOATS,
  hoveredFaceBoundary: NO_FLOATS,
  selectedVertices: NO_POINTS,
  hoveredVertices: NO_POINTS,
}

function pushTriangle(out: number[], positions: Float32Array, tri: number): void {
  const base = tri * 9
  for (let k = 0; k < 9; k++) out.push(positions[base + k])
}

function pushSegment(out: number[], positions: Float32Array, seg: number): void {
  const base = seg * 6
  for (let k = 0; k < 6; k++) out.push(positions[base + k])
}

/** Appends a whole face's boundary loop (variable segment count, unlike the
 *  fixed-stride edge/vertex layers). */
function pushBoundary(out: number[], segments: Float32Array): void {
  for (let k = 0; k < segments.length; k++) out.push(segments[k])
}

function toFloats(out: number[]): Float32Array {
  return out.length === 0 ? NO_FLOATS : Float32Array.from(out)
}

/**
 * Invert an owner map (`triangle -> face`, `segment -> edge`) into the member
 * list of each owner, indexed by owner id. Counting sort in two passes so each
 * owner gets an exactly-sized Uint32Array instead of a growing JS array: a body
 * can carry hundreds of thousands of triangles and this is retained for as long
 * as its pick geometry lives.
 *
 * Members naming an owner outside `[0, ownerCount)` are dropped, which is the
 * same thing the old scan did when `faceQueries[owner]` came back undefined.
 */
function groupByOwner(owner: Uint32Array, ownerCount: number): (Uint32Array | undefined)[] {
  const counts = new Uint32Array(ownerCount)
  for (let i = 0; i < owner.length; i++) {
    const o = owner[i]
    if (o < ownerCount) counts[o]++
  }
  const slots = new Array<Uint32Array | undefined>(ownerCount)
  for (let o = 0; o < ownerCount; o++) {
    if (counts[o] > 0) slots[o] = new Uint32Array(counts[o])
  }
  const filled = new Uint32Array(ownerCount)
  for (let i = 0; i < owner.length; i++) {
    const o = owner[i]
    if (o >= ownerCount) continue
    slots[o]![filled[o]++] = i
  }
  return slots
}

/**
 * One body's primitive groupings, built on first use.
 *
 * Lazy on purpose: the grouping costs O(triangles) and is only ever needed for a
 * body the user actually points at or selects. Building it for every body up
 * front would put the very O(scene) pass this index exists to remove back into
 * the solve-to-first-frame path instead of the hover path.
 */
class BodyIndex {
  private faceTriangles: (Uint32Array | undefined)[] | null = null
  private edgeSegments: (Uint32Array | undefined)[] | null = null
  readonly pick: AssemblyPickBody

  constructor(pick: AssemblyPickBody) { this.pick = pick }

  trianglesOf(faceIndex: number): Uint32Array | undefined {
    const faces = this.pick.faces
    if (!faces) return undefined
    if (!this.faceTriangles) {
      this.faceTriangles = groupByOwner(faces.triangleToFace, faces.faceQueries.length)
    }
    return this.faceTriangles[faceIndex]
  }

  segmentsOf(edgeIndex: number): Uint32Array | undefined {
    const edges = this.pick.edges
    if (!edges) return undefined
    if (!this.edgeSegments) {
      this.edgeSegments = groupByOwner(edges.segmentToEdge, edges.edgeQueries.length)
    }
    return this.edgeSegments[edgeIndex]
  }
}

interface PrimitiveSlot {
  body: BodyIndex
  /** Face index or edge index within that body. */
  index: number
}

/** The four buffers one colour's worth of active keys produces. */
interface GatheredParts {
  faces: Float32Array
  faceBoundary: Float32Array
  edges: Float32Array
  vertices: Vec3[]
}

const NO_PARTS: GatheredParts = {
  faces: NO_FLOATS, faceBoundary: NO_FLOATS, edges: NO_FLOATS, vertices: NO_POINTS,
}

/**
 * Key -> geometry index over one `pickGeometry` snapshot.
 *
 * Built once per pick-geometry identity and kept for as long as it lives, so a
 * build costs only the primitives of the keys that are actually highlighted.
 * The maps are keyed on `assemblyEntityKey`, which is positional and therefore
 * unique per (part handle, body, kind, index); a repeated key keeps its first
 * owner, matching IdRegistry, which likewise collapses a duplicate pick key onto
 * one id and so could never have resolved to the second one anyway.
 *
 * The two colours are cached independently: the selected buffers depend only on
 * `selection`, so moving the pointer around hands them back by reference and the
 * component re-uploads the hover buffers alone.
 */
export class AssemblySelectionIndex {
  private readonly faceOwners = new Map<string, PrimitiveSlot>()
  private readonly edgeOwners = new Map<string, PrimitiveSlot>()
  private readonly vertexOwners = new Map<string, Vec3>()

  private selectionKey: ReadonlySet<string> | null = null
  private selectedParts: GatheredParts = NO_PARTS
  private hoverKey: { selection: ReadonlySet<string>; hovered: string | null; mate: ReadonlySet<string> | undefined } | null = null
  private hoveredParts: GatheredParts = NO_PARTS

  constructor(pickBodies: readonly AssemblyPickBody[]) {
    for (const pick of pickBodies) {
      const body = new BodyIndex(pick)
      const { faces, edges, vertices } = pick
      if (faces) {
        faces.faceQueries.forEach((q, index) => {
          if (q !== undefined && !this.faceOwners.has(q)) this.faceOwners.set(q, { body, index })
        })
      }
      if (edges) {
        edges.edgeQueries.forEach((q, index) => {
          if (q !== undefined && !this.edgeOwners.has(q)) this.edgeOwners.set(q, { body, index })
        })
      }
      if (vertices) {
        vertices.vertices.forEach((p, i) => {
          const q = vertices.vertexQueries[i]
          if (q !== undefined && !this.vertexOwners.has(q)) this.vertexOwners.set(q, p)
        })
      }
    }
  }

  build(
    selection: ReadonlySet<string>,
    hovered: string | null,
    mateHighlighted?: ReadonlySet<string>,
  ): AssemblySelectionGeometry {
    const hasMateHighlight = mateHighlighted !== undefined && mateHighlighted.size > 0
    if (selection.size === 0 && hovered === null && !hasMateHighlight) return EMPTY

    const selected = this.gatherSelected(selection)
    const hover = this.gatherHovered(selection, hovered, mateHighlighted)
    return {
      selectedFaces: selected.faces,
      hoveredFaces: hover.faces,
      selectedEdges: selected.edges,
      hoveredEdges: hover.edges,
      selectedFaceBoundary: selected.faceBoundary,
      hoveredFaceBoundary: hover.faceBoundary,
      selectedVertices: selected.vertices,
      hoveredVertices: hover.vertices,
    }
  }

  private gatherSelected(selection: ReadonlySet<string>): GatheredParts {
    if (this.selectionKey === selection) return this.selectedParts
    this.selectedParts = this.gather(selection)
    this.selectionKey = selection
    return this.selectedParts
  }

  private gatherHovered(
    selection: ReadonlySet<string>,
    hovered: string | null,
    mate: ReadonlySet<string> | undefined,
  ): GatheredParts {
    const k = this.hoverKey
    if (k && k.selection === selection && k.hovered === hovered && k.mate === mate) return this.hoveredParts
    // Selection wins: a key that is both draws in the selected colour only, and
    // the two sources of hover colour are unioned so a key that is hovered AND
    // mate-highlighted still draws once.
    const keys = new Set<string>()
    if (hovered !== null && !selection.has(hovered)) keys.add(hovered)
    if (mate) for (const q of mate) if (!selection.has(q)) keys.add(q)
    this.hoveredParts = this.gather(keys)
    this.hoverKey = { selection, hovered, mate }
    return this.hoveredParts
  }

  /**
   * The whole hot path: touches only the primitives the named keys own. A key
   * is looked up in all three maps rather than the first that hits, so a body
   * that (illegally) reuses one key across kinds still draws what the old scan
   * drew.
   */
  private gather(keys: ReadonlySet<string>): GatheredParts {
    if (keys.size === 0) return NO_PARTS
    const faceOut: number[] = []
    const boundaryOut: number[] = []
    const edgeOut: number[] = []
    const vertOut: Vec3[] = []

    for (const key of keys) {
      const face = this.faceOwners.get(key)
      if (face) {
        const positions = face.body.pick.faces?.positions
        const tris = face.body.trianglesOf(face.index)
        if (positions && tris) for (const tri of tris) pushTriangle(faceOut, positions, tri)
        const boundary = face.body.pick.faceBoundaries?.get(face.index)
        if (boundary) pushBoundary(boundaryOut, boundary)
      }
      const edge = this.edgeOwners.get(key)
      if (edge) {
        const positions = edge.body.pick.edges?.segmentPositions
        const segments = edge.body.segmentsOf(edge.index)
        if (positions && segments) for (const seg of segments) pushSegment(edgeOut, positions, seg)
      }
      const vertex = this.vertexOwners.get(key)
      if (vertex) vertOut.push(vertex)
    }

    return {
      faces: toFloats(faceOut),
      faceBoundary: toFloats(boundaryOut),
      edges: toFloats(edgeOut),
      vertices: vertOut.length === 0 ? NO_POINTS : vertOut,
    }
  }
}

/**
 * One-shot form: build a throwaway index and extract. Convenient for tests and
 * any caller holding no pick-geometry identity to key a cache on; the viewport
 * keeps an `AssemblySelectionIndex` instead, because rebuilding the maps on
 * every pointer move would put an O(entities) pass back into the hover path.
 *
 * `mateHighlighted` draws in the same hover colour as `hovered`, for a mate
 * selected in the feature tree: its referenced geometry should read exactly
 * like the mouse is resting on it, without a second colour to invent. An
 * entity named by both `selection` and `mateHighlighted` still draws only
 * once, in the selected colour.
 */
export function buildAssemblySelectionGeometry(
  pickBodies: readonly AssemblyPickBody[],
  selection: ReadonlySet<string>,
  hovered: string | null,
  mateHighlighted?: ReadonlySet<string>,
): AssemblySelectionGeometry {
  return new AssemblySelectionIndex(pickBodies).build(selection, hovered, mateHighlighted)
}
