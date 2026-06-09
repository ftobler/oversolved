import { useState } from 'react'
import { Html } from '@react-three/drei'
import type { Sketch, Constraints, Entity, PlaneTransform } from '@/types/cad'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { getEntityBounds, ICON_SIZE, ICON_COLS, getIconUrl } from '@/components/sketch/sketch_helpers'
import { LinearDimension, RadiusDimension, DiameterDimension, AngleDimension } from '@/components/sketch/sketch_dimensions'
import { COLOR_SELECTED } from '@/components/Geometry3D/constants'
import { findEntitiesAtPoint } from '@/components/Geometry3D/drawGeometry'

function ConstraintTile({ url, id, featureId, highlightIds, superfluous }: { url: string; id: string; featureId: string; highlightIds: string[]; superfluous?: boolean }) {
  const [hovered, setHovered] = useState(false)
  const cId = `constraint:${featureId}:${id}`
  const selected = useSketchEditorStore(s => s.normalSelection.has(cId))
  const toggleNormalSelection = useSketchEditorStore(s => s.toggleNormalSelection)
  const setHoveredConstraintEntities = useSketchEditorStore(s => s.setHoveredConstraintEntities)

  const bg_color = selected ? COLOR_SELECTED : hovered ? '#4e4e4e' : superfluous ? '#2a1f00' : '#1C1C1C'
  const fg_style = (hovered || selected) ? 'invert(1.0)' : superfluous ? 'invert(0.5) sepia(1) saturate(3) hue-rotate(0deg)' : 'invert(0.7)'
  return (
    <div
      key={id}
      onMouseEnter={() => { setHovered(true); setHoveredConstraintEntities(new Set(highlightIds)) }}
      onMouseLeave={() => { setHovered(false); setHoveredConstraintEntities(new Set()) }}
      onClick={(e) => { e.stopPropagation(); toggleNormalSelection(cId) }}
      onPointerDown={(e) => e.stopPropagation()}
      style={{
        width: ICON_SIZE,
        height: ICON_SIZE,
        background: bg_color,
        borderRadius: 2,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        cursor: 'pointer',
        userSelect: 'none',
        WebkitUserSelect: 'none',
        ...(superfluous && { outline: '1px solid #b37400' }),
      }}
    >
      <img
        src={url}
        width={ICON_SIZE - 4}
        height={ICON_SIZE - 4}
        style={{filter: fg_style}}
      />
    </div>
  )
}

interface ConstraintOverlaysProps {
  constraints: Constraints
  sketch: Sketch
  extent: number
  featureId: string
  planeTransform?: PlaneTransform
}

export function ConstraintOverlays({ constraints, sketch, extent, featureId, planeTransform }: ConstraintOverlaysProps) {
  const drag = useSketchEditorStore(s => s.drag)
  const isDragging = drag !== null
  const showConstraintTiles = useSketchEditorStore(s => s.showConstraintTiles)
  const dimOffset = extent * 0.1

  const byEntity: Record<string, [string, Constraints[string]][]> = {}
  for (const [id, c] of Object.entries(constraints)) {
    const eid = (c.render as { entity?: string }).entity || 'default'
    if (!byEntity[eid]) byEntity[eid] = []
    byEntity[eid].push([id, c])
  }

  const symbolElements: React.ReactNode[] = []
  const dimElements: React.ReactNode[] = []

  for (const [eid, clist] of Object.entries(byEntity)) {
    const entity = sketch[eid] as Entity | undefined
    const bounds = entity ? getEntityBounds(entity) : { minX: 0, maxX: 0, minY: 0, maxY: 0 }

    // Sub-group symbols by their `at` position so each distinct location gets its own Html anchor.
    // Key is a rounded grid string; value holds the canonical position and its icon list.
    const atGroups = new Map<string, { at: [number, number]; icons: { url: string; key: string; highlightIds: string[]; superfluous?: boolean }[] }>()

    for (const [cid, c] of clist) {
      const r = c.render as { kind: string; at?: [number, number]; point?: string; entities?: string[]; [key: string]: unknown }

      if (showConstraintTiles && !isDragging && r.kind.startsWith('symbol_')) {
        const url = getIconUrl(r.kind)
        if (!url) continue
        if (!r.at && !entity) continue  // no position available
        const at: [number, number] = r.at ?? [bounds.maxX, bounds.maxY]
        const atKey = `${Math.round(at[0] * 1000)}_${Math.round(at[1] * 1000)}`
        if (!atGroups.has(atKey)) atGroups.set(atKey, { at, icons: [] })

        // Determine which ids to highlight on hover:
        //   - vertex-targeted constraint (e.g. fixed on $line1start): highlight just that vertex
        //   - multi-entity constraint: highlight all involved entities
        //   - proximity fallback: entities sharing the `at` point
        //   - last resort: the owning entity
        let highlightIds: string[]
        if (r.point != null) {
          // Vertex-targeted (e.g. fixed on a specific endpoint) — use "entityId:vertexKey" format
          highlightIds = [`${eid}:${r.point}`]
        } else if (r.entities?.length) {
          highlightIds = r.entities
        } else {
          const atEntities = findEntitiesAtPoint(sketch, at)
          highlightIds = atEntities.length > 0 ? atEntities : [eid]
        }
        atGroups.get(atKey)!.icons.push({ url, key: cid, highlightIds, superfluous: c.superfluous })

      } else if (r.kind === 'dim_linear') {
        const dim = r as { kind: string; p1: [number, number]; p2: [number, number]; normal: [number, number]; value: number; pos?: [number, number] }
        dimElements.push(<LinearDimension key={cid} cid={cid} dim={dim} dimOffset={dimOffset} interaction={{ featureId, entityId: eid, constraintId: cid, promptLabel: 'dimension' }} planeTransform={planeTransform} />)

      } else if (r.kind === 'dim_radius') {
        const dim = r as { kind: string; p1: [number, number]; p2: [number, number]; value: number; pos?: [number, number] }
        dimElements.push(<RadiusDimension key={cid} cid={cid} dim={dim} interaction={{ featureId, entityId: eid, constraintId: cid, promptLabel: 'radius' }} planeTransform={planeTransform} />)

      } else if (r.kind === 'dim_diameter') {
        const dim = r as { kind: string; p1: [number, number]; p2: [number, number]; value: number; pos?: [number, number] }
        dimElements.push(<DiameterDimension key={cid} cid={cid} dim={dim} interaction={{ featureId, entityId: eid, constraintId: cid, promptLabel: 'diameter' }} planeTransform={planeTransform} />)

      } else if (r.kind === 'dim_angle') {
        const dim = r as { kind: string; p1: [number, number]; p2: [number, number]; p3: [number, number]; p4: [number, number]; value: number; pos?: [number, number] }
        if (!dim.p3 || !dim.p4) continue
        dimElements.push(<AngleDimension key={cid} cid={cid} dim={dim} interaction={{ featureId, entityId: eid, constraintId: cid, promptLabel: 'angle in degrees' }} planeTransform={planeTransform} />)
      }
    }

    for (const [atKey, { at, icons }] of atGroups) {
      const colWidth = ICON_SIZE + 2
      const groupWidth = Math.min(ICON_COLS, icons.length) * colWidth
      symbolElements.push(
        <Html key={`icons-${eid}-${atKey}`} position={[at[0], at[1], 0.001]} style={{ pointerEvents: 'auto' }}>
          <div style={{ marginLeft: 20, marginTop: -8, display: 'flex', flexWrap: 'wrap', width: groupWidth, gap: 2 }}>
            {icons.map(({ url, key, highlightIds, superfluous }) => (
              <ConstraintTile key={key} url={url} id={key} featureId={featureId} highlightIds={highlightIds} superfluous={superfluous} />
            ))}
          </div>
        </Html>
      )
    }
  }

  return <>{[...symbolElements, ...dimElements]}</>
}
