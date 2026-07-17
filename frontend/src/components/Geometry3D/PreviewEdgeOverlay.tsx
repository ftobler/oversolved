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
  bodyKey: string
  edges: EdgeData[]
  existingGeom: Set<string> | null
}

// A position-bearing key for one edge, derived from its sampled polyline. Two
// edges match iff they are geometrically coincident. This is what the overlay
// must compare on: construction queries are (by design) position-independent
// identity, so an edge that is rigidly moved keeps the same query but a
// different geometry key. Comparing queries would suppress a moved edge as if
// it were unchanged, hiding the whole preview of a transform/mirror that only
// repositions a body (regression from removing geom tokens from queries).
function edgeGeomKey(edge: EdgeData): string {
  const pts = buildEdgeSegments([edge])
  if (pts.length === 0) return ''
  // Quantize to absorb float32 tessellation noise; a moved edge lands in a
  // different cell while a truly-unchanged edge hashes identically.
  let key = ''
  for (let i = 0; i < pts.length; i++) key += Math.round(pts[i] * 1000) + ','
  return key
}

function PreviewBodyEdges({ edges, existingGeom }: PreviewBodyEdgesProps) {
  const filteredEdges = useMemo(() => {
    if (!existingGeom) return edges
    return edges.filter((edge) => {
      const key = edgeGeomKey(edge)
      return !key || !existingGeom.has(key)
    })
  }, [edges, existingGeom])

  const geo = useMemo(() => {
    const pts = buildEdgeSegments(filteredEdges)
    if (pts.length === 0) return null
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(pts, 3))
    return g
  }, [filteredEdges])

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
        const key = edgeGeomKey(edge)
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
            bodyKey={item.key}
            edges={item.edges}
            existingGeom={existingGeom}
          />
        )
      })}
    </>
  )
}
