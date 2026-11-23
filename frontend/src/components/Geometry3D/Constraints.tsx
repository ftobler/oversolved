import { useState, useEffect, useRef } from 'react'
import { Html } from '@react-three/drei'
import type { Sketch, Constraints, Entity, PlaneTransform, PartConstraint, DroppedSketchConstraint } from '@/types/cad'
import { useSketchEditorStore, useSketchUiStore } from '@/stores/sketchEditorStore'
import { getEntityBounds, ICON_SIZE, ICON_COLS, getIconUrl } from '@/utils/geometry/sketchHelpers'
import { renderDimension } from '@/components/Geometry3D/dimensions/renderDimension'
import { COLOR_SELECTED, COLOR_ERROR_DEEP, LABEL_Z_OFFSET, highlightState } from '@/components/Geometry3D/constants'
import { findEntitiesAtPoint } from '@/utils/geometry/drawGeometry'
import { constraintTileLabel, CONSTRAINT_BY_KIND } from '@/registry/constraintRegistry'
import { computeConstraintRender } from '@/utils/geometry/geometryMapping'
import { ignoredConstraintWarning } from '@/utils/constraintProblems'

function ConstraintTile({ url, title, id, featureId, highlightIds, superfluous, culprit, onContextMenu }: { url: string; title: string; id: string; featureId: string; highlightIds: string[]; superfluous?: boolean; culprit?: boolean; onContextMenu?: (pos: [number, number]) => void }) {
  const [hovered, setHovered] = useState(false)
  const wasHoveredRef = useRef(false)
  const cId = `constraint:${featureId}:${id}`
  const selected = useSketchEditorStore(s => s.normalSelection.has(cId))
  const setHoveredConstraintEntities = useSketchEditorStore(s => s.setHoveredConstraintEntities)

  const selectSelf = () => {
    const s = useSketchEditorStore.getState()
    s.clearNormalSelection()
    s.addToNormalSelection(cId)
  }

  // Clear hover state on unmount so deleting a hovered constraint tile does not
  // leave the geometry stuck in the constraint-highlight color.
  useEffect(() => {
    return () => {
      if (wasHoveredRef.current) setHoveredConstraintEntities(new Set())
    }
  }, [setHoveredConstraintEntities])

  // Idle tiles are see-through so the geometry under them stays visible and
  // pickable by eye; only the transient hover / selected states get a fill.
  const state = highlightState(selected, hovered)
  const bgColor = state === 'selected' ? COLOR_SELECTED
    : state === 'hovered' ? '#4e4e4e'
    : 'transparent'
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
      title={title}
      onMouseEnter={() => { wasHoveredRef.current = true; setHovered(true); setHoveredConstraintEntities(new Set(highlightIds)) }}
      onMouseLeave={() => { wasHoveredRef.current = false; setHovered(false); setHoveredConstraintEntities(new Set()) }}
      onClick={(e) => { e.stopPropagation(); selectSelf() }}
      onContextMenu={(e) => {
        // The tile is a DOM overlay, so the canvas right-click listener never
        // sees this event. Select the tile first, exactly as a click does, and
        // hand the page the picked constraint so the menu can act without a hover.
        e.preventDefault()
        e.stopPropagation()
        selectSelf()
        onContextMenu?.([e.clientX, e.clientY])
      }}
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
  /** The constraints the solve could not use. Each gets a red tile at its first
   *  operand that still resolves locally (or the sketch origin), so the user can
   *  find and delete the dead row instead of hunting the warning text. */
  droppedConstraints?: readonly DroppedSketchConstraint[]
  /** The authored constraint bodies, the only place a dropped constraint's
   *  operands still live; the solved map has no render for it. */
  authoredConstraints?: readonly PartConstraint[]
  /** A tile's own right-click: the page opens its context menu with the picked
   *  constraint, so a projected tile can offer the freeze actions. */
  onSelectionContextMenu?: (selectionId: string, pos: [number, number]) => void
  /** The sketch's geometry has moved out from under the last cold solve: the
   *  drag preview, or the held preview while the post-drag solve is in flight.
   *  The dimensions' geometry and the tile set with its verdicts are the
   *  solve's, so the overlay hides together with the area fill instead of
   *  showing a mix of live and pre-drag positions. */
  geometryStale?: boolean
}

/** One red tile per dropped constraint: the glyph the constraint would have had,
 *  anchored where its surviving operand is. A constraint whose every operand is
 *  gone anchors at the sketch origin, the one place a tile can still be found. */
function droppedConstraintTiles(
  dropped: readonly DroppedSketchConstraint[],
  authored: readonly PartConstraint[] | undefined,
  sketch: Sketch,
): { id: string; at: [number, number]; url: string; title: string; highlightIds: string[] }[] {
  const tiles: { id: string; at: [number, number]; url: string; title: string; highlightIds: string[] }[] = []
  for (const entry of dropped) {
    const part = authored?.find(c => c.id === entry.id)
    if (!part) continue
    const render = computeConstraintRender(part, sketch)
    const at = ('at' in render && render.at ? render.at : [0, 0]) as [number, number]
    const renderKind = typeof render.kind === 'string' ? render.kind : ''
    const defKind = CONSTRAINT_BY_KIND.get(entry.kind)?.renderKind ?? ''
    const url = getIconUrl(renderKind) ?? getIconUrl(defKind) ?? getIconUrl('symbol_unknown')
    if (!url) continue
    const memberIds = [
      ...('entities' in render ? render.entities ?? [] : []),
      ...('points' in render ? render.points ?? [] : []),
    ]
    const highlighted = memberIds.length > 0
      ? memberIds
      : 'entity' in render && typeof render.entity === 'string'
        ? [render.entity]
        : findEntitiesAtPoint(sketch, at)
    tiles.push({
      id: entry.id,
      at,
      url,
      title: ignoredConstraintWarning(entry.id, entry.kind, entry.reason),
      highlightIds: highlighted.length > 0 ? highlighted : [],
    })
  }
  return tiles
}

interface SymbolTile {
  url: string
  title: string
  key: string
  highlightIds: string[]
  superfluous?: boolean
  culprit?: boolean
}

export function ConstraintOverlays({ constraints, sketch, extent, featureId, planeTransform, droppedConstraints, authoredConstraints, onSelectionContextMenu, geometryStale = false }: ConstraintOverlaysProps) {
  const showConstraintTiles = useSketchUiStore(s => s.showConstraintTiles)
  const dimOffset = extent * 0.1

  const symbolElements: React.ReactNode[] = []
  const dimElements: React.ReactNode[] = []

  // One anchor per point, sketch-wide. Grouping the anchors by render entity
  // first put two constraints at the same vertex into two Html anchors at the
  // same world position: the upper tile hid the lower one, and the amber
  // outline of a redundant tile underneath showed through the see-through idle
  // tile above it. Every tile of a joint now shares one grid, in authored
  // order, so a redundant twin sits beside the driver it duplicates.
  const atGroups = new Map<string, { at: [number, number]; icons: SymbolTile[] }>()

  for (const [cid, c] of Object.entries(constraints)) {
    // One gate for the whole solve-derived overlay. A dimension's extension
    // lines, arrows and arc are baked into its render block, so they would stay
    // at the pre-drag geometry while the preview moves. A symbol tile usually
    // anchors on a solved `at`; the no-`at` fallback derives its bounds from the
    // live display sketch, but the tile set and its verdicts are still the
    // solve's, so hiding the lot avoids a mixed live/frozen set mid-drag. A
    // dim_label drag does not move geometry and is not stale.
    if (geometryStale) continue
    const r = c.render as { kind: string; at?: [number, number]; point?: string; entities?: string[]; points?: string[]; [key: string]: unknown }
    // The render's entity supplies the fallback anchor and the owning vertex
    // highlight; it is not a grouping key.
    const eid = (r.entity as string | undefined) || 'default'
    const entity = sketch[eid] as Entity | undefined

    if (showConstraintTiles && r.kind.startsWith('symbol_')) {
      const url = getIconUrl(r.kind)
      if (!url) continue
      let at: [number, number]
      if (r.at) at = r.at
      else if (entity) {
        const bounds = getEntityBounds(entity)
        at = [bounds.maxX, bounds.maxY]
      } else continue  // no position available
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
      } else if (r.points?.length || r.entities?.length) {
        highlightIds = [...(r.entities ?? []), ...(r.points ?? [])]
      } else {
        const atEntities = findEntitiesAtPoint(sketch, at)
        highlightIds = atEntities.length > 0 ? atEntities : [eid]
      }
      // A group's whole members and point members are already split by the
      // render, so the counts cannot miscount an entity id containing `:`.
      const title = constraintTileLabel(r.kind, c, r.entities?.length ?? 0, r.points?.length ?? 0)
      atGroups.get(atKey)!.icons.push({ url, title, key: cid, highlightIds, superfluous: c.superfluous, culprit: c.culprit })

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

  // A joint's tiles form an explicit grid, three per row and further rows
  // below, so a busy vertex shows every constraint instead of stacking them.
  for (const [atKey, { at, icons }] of atGroups) {
    const cols = Math.min(icons.length, ICON_COLS)
    symbolElements.push(
      <Html key={`icons-${atKey}`} position={[at[0], at[1], LABEL_Z_OFFSET]} style={{ pointerEvents: 'none' }}>
        <div style={{ marginLeft: 20, marginTop: -8, display: 'grid', gridTemplateColumns: `repeat(${cols}, ${ICON_SIZE}px)`, width: cols * ICON_SIZE + (cols - 1) * 2, gap: 2 }}>
          {icons.map(({ url, title, key, highlightIds, superfluous, culprit }) => (
            <ConstraintTile key={key} url={url} title={title} id={key} featureId={featureId} highlightIds={highlightIds} superfluous={superfluous} culprit={culprit} onContextMenu={onSelectionContextMenu ? pos => onSelectionContextMenu(`constraint:${featureId}:${key}`, pos) : undefined} />
          ))}
        </div>
      </Html>
    )
  }

  // A dropped constraint is an error marker, not decoration: it keeps its red
  // tile even when the user hides the ordinary symbols, because hiding it would
  // leave only the tree's warning text to find a row that cannot be deleted from
  // the canvas. It still goes away while the geometry is stale: its anchor is
  // recomputed by computeConstraintRender against the live display sketch, but
  // the dropped list is the last solve's verdict, so it belongs to the same
  // solve-derived overlay set rather than sitting alone while every other tile
  // and dimension is hidden.
  const droppedElements: React.ReactNode[] = []
  if (!geometryStale) {
    for (const tile of droppedConstraintTiles(droppedConstraints ?? [], authoredConstraints, sketch)) {
      droppedElements.push(
        <Html key={`dropped-${tile.id}`} position={[tile.at[0], tile.at[1], LABEL_Z_OFFSET]} style={{ pointerEvents: 'none' }}>
          <div style={{ marginLeft: 20, marginTop: -8, display: 'flex' }}>
            <ConstraintTile
              url={tile.url}
              title={tile.title}
              id={tile.id}
              featureId={featureId}
              highlightIds={tile.highlightIds}
              culprit
            />
          </div>
        </Html>
      )
    }
  }

  return <>{[...symbolElements, ...dimElements, ...droppedElements]}</>
}
