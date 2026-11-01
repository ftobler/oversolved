import type { Plane } from 'three'
import { highlightState, overlayLineMaterialProps, RENDER_ORDER_HIGHLIGHT } from './constants'
import type { LazyGeometryCache } from './lazyGeometryCache'

/**
 * The overlay that marks a hovered or selected B-rep primitive (an edge, or a
 * face's outline). Hover and selection are ONE drawing recipe fed by two flag
 * arrays: they differ only in colour, never in layer or blending.
 *
 * That matters because the rest of the scene sorts around them. The body fill
 * and the section cap own opaque orders up to 150+, so an overlay at order 0 is
 * drawn in the opaque pass first and a transparent body or the cap paints over
 * it -- which is exactly how a hover used to vanish on a sectioned body while
 * the selection beside it stayed visible. Hover therefore has to be as
 * transparent and as late as the selection always was; the material half of
 * that recipe is overlayLineMaterialProps in constants.
 */

export interface HighlightOverlaysProps {
  // Index-keyed geometry of the primitives, built on demand. A primitive with
  // no drawn segments yields null and is skipped.
  geos: LazyGeometryCache | null
  selected: readonly boolean[] | null
  hovered: readonly boolean[] | null
  selectedColor: string
  hoveredColor: string
  clippingPlanes: Plane[] | null
  // Cheap caller-side gate (HighlightIndex.hasAny): false means no primitive of
  // this layer is active, so the primitive list is never walked.
  active: boolean
}

export function HighlightOverlays({
  geos, selected, hovered, selectedColor, hoveredColor, clippingPlanes, active,
}: HighlightOverlaysProps) {
  if (!active || !geos) return null
  const count = Math.max(selected?.length ?? 0, hovered?.length ?? 0)
  const overlays = []
  for (let i = 0; i < count; i++) {
    // Selection outranks hover here exactly as it does in the colour buffers:
    // one primitive, one overlay, the selection colour.
    const state = highlightState(selected?.[i] === true, hovered?.[i] === true)
    if (state === null) continue
    const geo = geos.get(i)
    if (!geo) continue
    overlays.push(
      <lineSegments key={`${state}-${i}`} geometry={geo} renderOrder={RENDER_ORDER_HIGHLIGHT}>
        <lineBasicMaterial
          {...overlayLineMaterialProps(state === 'selected' ? selectedColor : hoveredColor)}
          clippingPlanes={clippingPlanes}
        />
      </lineSegments>,
    )
  }
  return <>{overlays}</>
}
