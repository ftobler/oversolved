import { useCallback, useEffect, useRef } from 'react'
import { OverlayHtml } from '@/components/Geometry3D/OverlayHtml'
import { LABEL_Z_OFFSET } from '@/components/Geometry3D/constants'
import { registerDimensionLabelElement } from '@/picking/dimensionLabelDom'

// Hugs the glyphs only, so the geometry between and around them shows through.
const LABEL_HALO = '0 0 2px #111, 0 0 2px #111'

/**
 * The shared `<Html>` text block used by every dimension label (Linear /
 * Radius / Diameter / Angle). The text follows the cursor and stays visible
 * while the label is dragged.
 *
 * `angleDeg` rotates the glyph block about its centre, which is the anchor
 * `<Html center>` already holds in place, so a linear dimension's value reads
 * along its line. The caller owns the angle because only it knows the line;
 * radius, diameter and angle labels omit it and stay upright. Rotation is a
 * screen-space fact that the camera revises every frame, so the caller may
 * also keep writing the transform to the published element through
 * `onTextElement` (including the rendered width it measures there for the
 * line gap); the prop is the render-time value and the first paint.
 *
 * The text is pointer-events: none, but it publishes its rendered box to the
 * dimensionLabel hit test (see picking/dimensionLabelDom): that box is the only
 * truthful footprint of text whose screen width depends on the formatted value,
 * so hovering or clicking any glyph reaches the label. The gate here matches
 * the ID ring's: only an interactive label, and not while it is being dragged,
 * is pickable at all. There is no separate 3D hit mesh: a fixed-radius circle
 * could only under-cover a long label and would disagree with the box.
 */
export function DimensionLabel({
  cid, x, y, label, color, enabled = true, isDragged, angleDeg, hovered = false, title, onTextElement,
}: {
  cid: string
  x: number
  y: number
  label: string
  color: string
  enabled?: boolean
  isDragged: boolean
  // CSS `rotate()` degrees for the glyph block; unset keeps it horizontal.
  angleDeg?: number
  // The label is hovered through the canvas dispatcher (the glyphs themselves
  // take no pointer events). A `title` is shown as a small tooltip only then:
  // it is a solve sentence, not something to keep on screen permanently.
  hovered?: boolean
  // Hover text for a solve verdict that has a sentence of its own (a weak
  // constraint), beside the usual colour marking.
  title?: string
  // Publishes the glyph block itself, whether or not it is pickable, so a
  // linear dimension can size the gap in its line from the rendered text and
  // keep the rotation current. Must be identity-stable: a changing callback
  // re-attaches the element.
  onTextElement?: (element: HTMLDivElement | null) => void
}) {
  // A callback ref, not a passive effect reading `ref.current`: drei's `<Html>`
  // renders its children into a separate React root (ReactDOM.createRoot in a
  // layout effect), so that subtree commits after this component's effects. A
  // passive effect would run once with a null ref and never again, and the box
  // would only appear after a drag flipped one of its deps. The callback fires
  // when the inner root actually attaches the element.
  const unregisterRef = useRef<() => void>(() => {})
  const attachText = useCallback((element: HTMLDivElement | null) => {
    unregisterRef.current()
    unregisterRef.current = element && enabled && !isDragged
      ? registerDimensionLabelElement(cid, element)
      : () => {}
    onTextElement?.(element)
  }, [cid, enabled, isDragged, onTextElement])
  useEffect(() => () => { unregisterRef.current() }, [])

  return (
    <OverlayHtml position={[x, y, LABEL_Z_OFFSET]} center style={{ pointerEvents: 'none' }}>
      <div
        ref={attachText}
        // No background: the label sits under the cursor while dragging, and
        // an opaque box hid the vertex the user was aiming at. A thin halo in
        // the canvas color keeps the digits legible where they cross a line.
        // userSelect is always off: the text takes no pointer events, so a
        // selectable variant could only ever be a drag artefact.
        style={{ color, fontSize: 14, fontFamily: "'Roboto Mono', monospace", background: 'transparent', textShadow: LABEL_HALO, padding: '0 5px', borderRadius: 2, whiteSpace: 'nowrap', userSelect: 'none', WebkitUserSelect: 'none', transform: angleDeg === undefined ? undefined : `rotate(${angleDeg}deg)` }}
      >
        {label}
      </div>
      {hovered && title && (
        // Out of flow on purpose: the drei wrapper is the containing block, and
        // an in-flow tooltip would grow the centred block, move the glyphs under
        // the cursor and make the hover hit box drop it (the sentence would
        // strobe). Sibling of the glyph block, not part of it, so
        // `onTextElement` still measures the label alone.
        <div style={{ position: 'absolute', top: '100%', left: '50%', transform: 'translateX(-50%)', width: 'max-content', padding: '2px 6px', background: '#1b1b1b', color: '#e8e8e8', fontSize: 11, borderRadius: 3, maxWidth: 260, whiteSpace: 'normal', textAlign: 'left' }}>
          {title}
        </div>
      )}
    </OverlayHtml>
  )
}
