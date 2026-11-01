import { useCallback, useEffect, useRef } from 'react'
import { Html } from '@react-three/drei'
import { LABEL_Z_OFFSET } from '@/components/Geometry3D/constants'
import { registerDimensionLabelElement } from '@/picking/dimensionLabelDom'

// Hugs the glyphs only, so the geometry between and around them shows through.
const LABEL_HALO = '0 0 2px #111, 0 0 2px #111'

/**
 * The shared `<Html>` text block used by every dimension label (Linear /
 * Radius / Diameter / Angle). The text follows the cursor and stays visible
 * while the label is dragged.
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
  cid, x, y, label, color, enabled = true, isDragged,
}: {
  cid: string
  x: number
  y: number
  label: string
  color: string
  enabled?: boolean
  isDragged: boolean
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
  }, [cid, enabled, isDragged])
  useEffect(() => () => { unregisterRef.current() }, [])

  return (
    <Html position={[x, y, LABEL_Z_OFFSET]} center style={{ pointerEvents: 'none' }}>
      <div
        ref={attachText}
        // No background: the label sits under the cursor while dragging, and
        // an opaque box hid the vertex the user was aiming at. A thin halo in
        // the canvas color keeps the digits legible where they cross a line.
        // userSelect is always off: the text takes no pointer events, so a
        // selectable variant could only ever be a drag artefact.
        style={{ color, fontSize: 14, fontFamily: "'Roboto Mono', monospace", background: 'transparent', textShadow: LABEL_HALO, padding: '0 5px', borderRadius: 2, whiteSpace: 'nowrap', userSelect: 'none', WebkitUserSelect: 'none' }}
      >
        {label}
      </div>
    </Html>
  )
}
