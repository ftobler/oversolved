import { useMemo, useEffect } from 'react'
import * as THREE from 'three'
import type { EdgeData } from '../../types/cad'
import type { BodyRenderItem } from '../Viewport/bodyUtils'
import { buildEdgeSegments } from './Body3D'
import { COLOR_PREVIEW_EDGE, RENDER_ORDER_HIGHLIGHT } from './constants'

interface PreviewEdgeOverlayProps {
  items: BodyRenderItem[]
  pickItems?: BodyRenderItem[]
}

interface PreviewBodyEdgesProps {
  bodyKey: string
  edges: EdgeData[]
  edgeQueries: string[] | undefined
  existingQueries: Set<string> | null
}

function PreviewBodyEdges({ edges, edgeQueries, existingQueries }: PreviewBodyEdgesProps) {
  const filteredEdges = useMemo(() => {
    if (!existingQueries) return edges
    return edges.filter((_, i) => {
      const q = edgeQueries?.[i]
      return !q || !existingQueries.has(q)
    })
  }, [edges, edgeQueries, existingQueries])

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
  const existingQueries = useMemo(() => {
    if (!pickItems) return null
    const set = new Set<string>()
    for (const item of pickItems) {
      for (const q of (item.edgeQueries ?? [])) set.add(q)
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
            edgeQueries={item.edgeQueries}
            existingQueries={existingQueries}
          />
        )
      })}
    </>
  )
}
