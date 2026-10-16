import { useState, useEffect, useRef } from 'react'
import { Html } from '@react-three/drei'
import type { Sketch, Constraints, Entity, PlaneTransform } from '@/types/cad'
import { useSketchEditorStore, useSketchUiStore } from '@/stores/sketchEditorStore'
import { getEntityBounds, ICON_SIZE, ICON_COLS, getIconUrl, groupConstraintsByEntity } from '@/utils/geometry/sketchHelpers'
import { renderDimension } from '@/components/Geometry3D/dimensions/renderDimension'
import { COLOR_SELECTED, COLOR_ERROR_DEEP, LABEL_Z_OFFSET } from '@/components/Geometry3D/constants'
import { findEntitiesAtPoint } from '@/components/Geometry3D/drawGeometry'

function ConstraintTile({ url, id, featureId, highlightIds, superfluous, culprit }: { url: string; id: string; featureId: string; highlightIds: string[]; superfluous?: boolean; culprit?: boolean }) {
  const [hovered, setHovered] = useState(false)
  const wasHoveredRef = useRef(false)
  const cId = `constraint:${featureId}:${id}`
  const selected = useSketchEditorStore(s => s.normalSelection.has(cId))
  const setHoveredConstraintEntities = useSketchEditorStore(s => s.setHoveredConstraintEntities)

  // Clear hover state on unmount so deleting a hovered constraint tile does not
  // leave the geometry stuck in the constraint-highlight color.
  useEffect(() => {
    return () => {
      if (wasHoveredRef.current) setHoveredConstraintEntities(new Set())
    }
  }, [setHoveredConstraintEntities])

  // Idle tiles are see-through so the geometry under them stays visible and
  // pickable by eye; only the transient hover / selected states get a fill.
  const bgColor = selected ? COLOR_SELECTED : hovered ? '#4e4e4e' : 'transparent'
  // A culprit tile is drawn in the deeper error red: the whole sketch already
  // paints red on an unsatisfied solve, and the blamed constraints must stand
  // out inside it. A redundant tile keeps the existing non-driver treatment
  // (dimmed, amber outline), which is also the "measurement, not a driver"
  // reading the user asked for.
  const fgStyle = (hovered || selected) ? 'invert(1.0)'
    : culprit ? 'invert(0.35) sepia(1) saturate(6) hue-rotate(-45deg)'
    : superfluous ? 'invert(0.5) sepia(1) saturate(3) hue-rotate(0deg)'
    : 'invert(0.7)'
  const outline = culprit ? COLOR_ERROR_DEEP : superfluous ? '#b37400' : undefined
  return (
    <div
      key={id}
      onMouseEnter={() => { wasHoveredRef.current = true; setHovered(true); setHoveredConstraintEntities(new Set(highlightIds)) }}
      onMouseLeave={() => { wasHoveredRef.current = false; setHovered(false); setHoveredConstraintEntities(new Set()) }}
      onClick={(e) => { e.stopPropagation(); const s = useSketchEditorStore.getState(); s.clearNormalSelection(); s.addToNormalSelection(cId) }}
      onPointerDown={(e) => e.stopPropagation()}
      style={{
        width: ICON_SIZE,
        height: ICON_SIZE,
        background: bgColor,
        borderRadius: 2,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        cursor: 'pointer',
        // The Html anchor is pointer-events: none so its transparent box cannot
        // shadow the vertex it is anchored on; only the visible tiles opt back in.
        pointerEvents: 'auto',
        userSelect: 'none',
        WebkitUserSelect: 'none',
        ...(outline && { outline: `1px solid ${outline}` }),
      }}
    >
      <img
        src={url}
        width={ICON_SIZE - 4}
        height={ICON_SIZE - 4}
        style={{filter: fgStyle}}
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
  const showConstraintTiles = useSketchUiStore(s => s.showConstraintTiles)
  const dimOffset = extent * 0.1

  const byEntity = groupConstraintsByEntity(constraints)

  const symbolElements: React.ReactNode[] = []
  const dimElements: React.ReactNode[] = []

  for (const [eid, clist] of Object.entries(byEntity)) {
    const entity = sketch[eid] as Entity | undefined
    const bounds = entity ? getEntityBounds(entity) : { minX: 0, maxX: 0, minY: 0, maxY: 0 }

    // Sub-group symbols by their `at` position so each distinct location gets its own Html anchor.
    // Key is a rounded grid string; value holds the canonical position and its icon list.
    const atGroups = new Map<string, { at: [number, number]; icons: { url: string; key: string; highlightIds: string[]; superfluous?: boolean; culprit?: boolean }[] }>()

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
          // Vertex-targeted (e.g. fixed on a specific endpoint), use "entityId:vertexKey" format
          highlightIds = [`${eid}:${r.point}`]
        } else if (r.entities?.length) {
          highlightIds = r.entities
        } else {
          const atEntities = findEntitiesAtPoint(sketch, at)
          highlightIds = atEntities.length > 0 ? atEntities : [eid]
        }
        atGroups.get(atKey)!.icons.push({ url, key: cid, highlightIds, superfluous: c.superfluous, culprit: c.culprit })

      } else {
        // The solve verdicts ride the interaction block so the dimension label
        // can paint itself: culprit deep red, redundant dimmed amber.
        const el = renderDimension(cid, r, dimOffset, {
          featureId, entityId: eid,
          ...(c.superfluous ? { redundant: true } : {}),
          ...(c.culprit ? { culprit: true } : {}),
        }, planeTransform)
        if (el) dimElements.push(el)
      }
    }

    for (const [atKey, { at, icons }] of atGroups) {
      const colWidth = ICON_SIZE + 2
      const groupWidth = Math.min(ICON_COLS, icons.length) * colWidth
      symbolElements.push(
        <Html key={`icons-${eid}-${atKey}`} position={[at[0], at[1], LABEL_Z_OFFSET]} style={{ pointerEvents: 'none' }}>
          <div style={{ marginLeft: 20, marginTop: -8, display: 'flex', flexWrap: 'wrap', width: groupWidth, gap: 2 }}>
            {icons.map(({ url, key, highlightIds, superfluous, culprit }) => (
              <ConstraintTile key={key} url={url} id={key} featureId={featureId} highlightIds={highlightIds} superfluous={superfluous} culprit={culprit} />
            ))}
          </div>
        </Html>
      )
    }
  }

  return <>{[...symbolElements, ...dimElements]}</>
}
