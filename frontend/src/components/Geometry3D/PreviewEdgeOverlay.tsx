import { useMemo, useEffect } from 'react'
import * as THREE from 'three'
import type { EdgeData } from '@/types/cad'
import type { BodyRenderItem } from '@/components/Viewport/bodyUtils'
import { buildEdgeSegments } from '@/components/Geometry3D/bodyGeometry'
import { COLOR_PREVIEW_EDGE, RENDER_ORDER_HIGHLIGHT } from '@/components/Geometry3D/constants'
import { TOL_PREVIEW_CELL } from '@/kernel/solverConstants'
import { MARK_CELL_NEIGHBOURS } from '@/picking/markPosition'
import { getSectionClipPlaneList } from '@/viewport/sectionClipping'
import { useSectionActive } from '@/viewport/useSection'

interface PreviewEdgeOverlayProps {
  items: BodyRenderItem[]
  pickItems?: BodyRenderItem[]
}

interface PreviewBodyEdgesProps {
  edges: EdgeData[]
  existingGeom: EdgeCells[] | null
}

/** The lattice cells one edge's sampled polyline occupies: `keys` to look a
 *  cell up, `cells` to walk them, and the cell bounds so a ghost a whole
 *  region away is dismissed before a single point is probed. */
interface EdgeCells {
  keys: Set<string>
  cells: Array<[number, number, number]>
  min: [number, number, number]
  max: [number, number, number]
}

// A position-bearing cell set for one edge, derived from its sampled polyline
// and made independent of the direction and start parameter the kernel happened
// to choose: a rebuild that re-topologizes a body without moving an edge may
// hand back the reversed orientation, and that edge is still redundant with its
// ghost. Keyed on geometry, never on the (position-independent) construction
// query: a rigidly moved edge keeps its query but lands on a different cell
// set, so a transform/mirror preview is not wrongly suppressed.
//
// The lattice is TOL_PREVIEW_CELL (solverConstants): the ladder's coarsest rung,
// four orders above every solver resolution, because what it decides is a
// rendering coincidence (is this violet line redundant with the ghost under it)
// and not geometry.
function cellOf(v: number): number {
  return Math.round(v / TOL_PREVIEW_CELL)
}

function cellKey(x: number, y: number, z: number): string {
  return x + ',' + y + ',' + z
}

function cellsFromSegments(pts: Float32Array): EdgeCells {
  const keys = new Set<string>()
  const cells: Array<[number, number, number]> = []
  const min: [number, number, number] = [Infinity, Infinity, Infinity]
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i + 3 <= pts.length; i += 3) {
    const cell: [number, number, number] = [cellOf(pts[i]), cellOf(pts[i + 1]), cellOf(pts[i + 2])]
    for (let a = 0; a < 3; a++) {
      if (cell[a] < min[a]) min[a] = cell[a]
      if (cell[a] > max[a]) max[a] = cell[a]
    }
    const key = cellKey(cell[0], cell[1], cell[2])
    if (!keys.has(key)) {
      keys.add(key)
      cells.push(cell)
    }
  }
  return { keys, cells, min, max }
}

/** Whether two cell sets can be the same edge at all: their bounds overlap
 *  within the one-cell slack `covers` allows. The overlay compares every
 *  surviving preview edge against every ghost edge, and this is what keeps that
 *  comparison from probing a body's worth of points per distant ghost. */
function boundsOverlap(a: EdgeCells, b: EdgeCells): boolean {
  for (let i = 0; i < 3; i++) {
    if (a.min[i] > b.max[i] + 1 || b.min[i] > a.max[i] + 1) return false
  }
  return true
}

/** Every cell of `a` has a partner in `b` within one lattice step on every
 *  axis, the same 27-cell probe picking's mark position index uses
 *  (picking/markPosition.ts). The own cell is tried first, so two passes over
 *  one unchanged curve -- the case that dominates -- cost one lookup per point.
 *  The neighbour step is what removes the boundary cliff an exact key has:
 *  samples that differ by less than the cell but straddle a boundary are the
 *  same point, and a rigidly moved edge lands hundreds of cells away. */
function covers(a: EdgeCells, b: EdgeCells): boolean {
  for (const [x, y, z] of a.cells) {
    if (b.keys.has(cellKey(x, y, z))) continue
    let hit = false
    for (const [dx, dy, dz] of MARK_CELL_NEIGHBOURS) {
      if (b.keys.has(cellKey(x + dx, y + dy, z + dz))) {
        hit = true
        break
      }
    }
    if (!hit) return false
  }
  return true
}

// Coincidence is coverage both ways. A preview edge that covers only PART of
// its ghost, or is covered only in part by it, is a shortened or split edge:
// geometry the feature really changed, which the overlay must show.
function coincides(a: EdgeCells, b: EdgeCells): boolean {
  return boundsOverlap(a, b) && covers(a, b) && covers(b, a)
}

function PreviewBodyEdges({ edges, existingGeom }: PreviewBodyEdgesProps) {
  // The preview is body geometry: it is cut with the same plane as the solid it
  // previews, or a pending edit would draw through the removed half.
  const sectionActive = useSectionActive()
  // Tessellate each edge once; the point array feeds both the suppression cells
  // and, for the survivors, the merged BufferGeometry.
  const tessellated = useMemo(
    () => edges.map((edge) => {
      const pts = buildEdgeSegments([edge])
      return { pts, cells: cellsFromSegments(pts) }
    }),
    [edges],
  )

  const geo = useMemo(() => {
    const survivors = existingGeom
      ? tessellated.filter(t => t.cells.cells.length === 0 || !existingGeom.some(g => coincides(t.cells, g)))
      : tessellated
    let total = 0
    for (const t of survivors) total += t.pts.length
    if (total === 0) return null
    // buildEdgeSegmentGeometry carries no state across edges, so the batch call
    // over a list is exactly its per-edge buffers joined in order. Splicing the
    // first-pass arrays therefore yields a byte-identical buffer for free.
    const merged = new Float32Array(total)
    let offset = 0
    for (const t of survivors) {
      merged.set(t.pts, offset)
      offset += t.pts.length
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(merged, 3))
    return g
  }, [tessellated, existingGeom])

  useEffect(() => {
    return () => { geo?.dispose() }
  }, [geo])

  if (!geo) return null

  return (
    <lineSegments geometry={geo} renderOrder={RENDER_ORDER_HIGHLIGHT}>
      <lineBasicMaterial color={COLOR_PREVIEW_EDGE} depthTest={false} clippingPlanes={sectionActive ? getSectionClipPlaneList() : null} />
    </lineSegments>
  )
}

export default function PreviewEdgeOverlay({ items, pickItems }: PreviewEdgeOverlayProps) {
  // Geometry of every edge already drawn as a solid ghost (the before-edit pick
  // bodies). A preview edge coincident with one of these is redundant and gets
  // suppressed so the overlay highlights only what the edit actually changed.
  const existingGeom = useMemo(() => {
    if (!pickItems) return null
    const ghosts: EdgeCells[] = []
    for (const item of pickItems) {
      for (const edge of item.edges) {
        const cells = cellsFromSegments(buildEdgeSegments([edge]))
        if (cells.cells.length > 0) ghosts.push(cells)
      }
    }
    return ghosts
  }, [pickItems])

  return (
    <>
      {items.map(item => {
        if (!item.visible || item.edges.length === 0) return null
        return (
          <PreviewBodyEdges
            key={item.key}
            edges={item.edges}
            existingGeom={existingGeom}
          />
        )
      })}
    </>
  )
}
