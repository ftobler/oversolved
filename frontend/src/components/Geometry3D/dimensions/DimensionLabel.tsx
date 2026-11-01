import { Html } from '@react-three/drei'
import { useDimLabelScale } from './useDimLabelScale'
import { LABEL_Z_OFFSET } from '@/components/Geometry3D/constants'

// Hugs the glyphs only, so the geometry between and around them shows through.
const LABEL_HALO = '0 0 2px #111, 0 0 2px #111'

/**
 * The shared invisible hit mesh plus the `<Html>` text block used by every
 * dimension label (Linear / Radius / Diameter / Angle). The mesh keeps a
 * constant on-screen size and only renders when the label is not being dragged,
 * so the hit halo stays quiet mid-drag; the text keeps rendering and follows
 * the cursor. Diameter omits the `userSelect: none` the others set, so
 * `selectable` toggles it.
 *
 * The text itself is pointer-events: none. It portals next to the canvas, so
 * letting it take the pointer had two costs the ring does not: moving onto the
 * glyphs fired the canvas pointerleave and cleared the hover, and the DOM click
 * replaced the whole selection instead of toggling the dimension. The ID ring
 * below is registered in the pick buffer, and the dispatcher owns hover, click,
 * double-click and drag for the label.
 */
export function DimensionLabel({
  x, y, label, color, isDragged, selectable = true,
}: {
  x: number
  y: number
  label: string
  color: string
  isDragged: boolean
  selectable?: boolean
}) {
  const meshRef = useDimLabelScale()
  return (
    <>
      {!isDragged && (
        <mesh ref={meshRef} position={[x, y, LABEL_Z_OFFSET]}>
          <circleGeometry args={[1, 8]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
      )}
      <Html position={[x, y, LABEL_Z_OFFSET]} center style={{ pointerEvents: 'none' }}>
        <div
          // No background: the label sits under the cursor while dragging, and
          // an opaque box hid the vertex the user was aiming at. A thin halo in
          // the canvas color keeps the digits legible where they cross a line.
          style={{ color, fontSize: 14, fontFamily: "'Roboto Mono', monospace", background: 'transparent', textShadow: LABEL_HALO, padding: '0 5px', borderRadius: 2, whiteSpace: 'nowrap', ...(selectable ? { userSelect: 'none', WebkitUserSelect: 'none' } : {}) }}
        >
          {label}
        </div>
      </Html>
    </>
  )
}
