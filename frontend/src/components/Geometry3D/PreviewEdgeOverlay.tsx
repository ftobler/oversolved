import { useMemo, useEffect } from 'react'
import * as THREE from 'three'
import type { EdgeData } from '@/types/cad'
import type { BodyRenderItem } from '@/components/Viewport/bodyUtils'
import { buildEdgeSegments } from '@/components/Geometry3D/bodyGeometry'
import { COLOR_PREVIEW_EDGE, RENDER_ORDER_HIGHLIGHT } from '@/components/Geometry3D/constants'

interface PreviewEdgeOverlayProps {
  items: BodyRenderItem[]
  pickItems?: BodyRenderItem[]
}

interface PreviewBodyEdgesProps {
  edges: EdgeData[]
  existingGeom: Set<string> | null
}

// A position-bearing key for one edge, derived from its sampled polyline and
// made independent of the direction and start parameter the kernel happened to
// choose. Two edges match iff they occupy the same rounded set of sampled
// points, i.e. they are geometrically coincident however OCC walked them: a
// rebuild that re-topologizes a body without moving an edge may hand back the
// reversed orientation, and that edge is still redundant with its ghost. Keyed
// on geometry, never on the (position-independent) construction query: a
// rigidly moved edge keeps its query but lands on a different point set, so a
// transform/mirror preview is not wrongly suppressed.
function geomKeyFromSegments(pts: Float32Array): string {
  if (pts.length === 0) return ''
  const cells = new Set<string>()
  for (let i = 0; i + 3 <= pts.length; i += 3) {
    // Quantize to absorb float32 tessellation noise; a moved point lands in a
    // different cell, a truly-unchanged point in the same one.
    const x = Math.round(pts[i] * 1000)
    const y = Math.round(pts[i + 1] * 1000)
    const z = Math.round(pts[i + 2] * 1000)
    cells.add(x + ',' + y + ',' + z)
  }
  return Array.from(cells).sort().join(';')
}

function PreviewBodyEdges({ edges, existingGeom }: PreviewBodyEdgesProps) {
  // Tessellate each edge once; the point array feeds both the suppression key
  // and, for the survivors, the merged BufferGeometry.
  const tessellated = useMemo(
    () => edges.map((edge) => {
      const pts = buildEdgeSegments([edge])
      return { pts, key: geomKeyFromSegments(pts) }
    }),
    [edges],
  )

  const geo = useMemo(() => {
    const survivors = existingGeom
      ? tessellated.filter(t => !t.key || !existingGeom.has(t.key))
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
      <lineBasicMaterial color={COLOR_PREVIEW_EDGE} depthTest={false} />
    </lineSegments>
  )
}

export default function PreviewEdgeOverlay({ items, pickItems }: PreviewEdgeOverlayProps) {
  // Geometry of every edge already drawn as a solid ghost (the before-edit pick
  // bodies). A preview edge coincident with one of these is redundant and gets
  // suppressed so the overlay highlights only what the edit actually changed.
  const existingGeom = useMemo(() => {
    if (!pickItems) return null
    const set = new Set<string>()
    for (const item of pickItems) {
      for (const edge of item.edges) {
        const key = geomKeyFromSegments(buildEdgeSegments([edge]))
        if (key) set.add(key)
      }
    }
    return set
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
