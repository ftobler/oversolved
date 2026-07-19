import { Html } from '@react-three/drei'
import { useDimLabelScale } from './useDimLabelScale'
import { LABEL_Z_OFFSET } from '@/components/Geometry3D/constants'

type DimEvent = { stopPropagation: () => void; clientX: number; clientY: number }

/**
 * The shared invisible hit mesh plus the `<Html>` text block used by every
 * dimension label (Linear / Radius / Diameter / Angle). The mesh keeps a
 * constant on-screen size and only renders when the label is not being dragged
 * (the drag preview owns the visual while dragging). Diameter omits the
 * `userSelect: none` the others set, so `selectable` toggles it.
 */
export function DimensionLabel({
  x, y, label, color, interactive, isDragged, selectable = true,
  onClick, onDoubleClick, onPointerDown,
}: {
  x: number
  y: number
  label: string
  color: string
  interactive: boolean
  isDragged: boolean
  selectable?: boolean
  onClick: (e: { stopPropagation: () => void }) => void
  onDoubleClick: (e: DimEvent) => void
  onPointerDown: (e: DimEvent) => void
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
      <Html position={[x, y, LABEL_Z_OFFSET]} center style={{ pointerEvents: interactive ? 'auto' : 'none' }}>
        <div
          onClick={(e) => { if (interactive) { e.stopPropagation(); onClick({ stopPropagation: () => {} }) } }}
          onDoubleClick={(e) => { if (interactive) { e.stopPropagation(); onDoubleClick({ stopPropagation: () => {}, clientX: e.clientX, clientY: e.clientY }) } }}
          onPointerDown={(e) => { if (interactive) { e.stopPropagation(); onPointerDown({ stopPropagation: () => {}, clientX: e.clientX, clientY: e.clientY }) } }}
          style={{ color, fontSize: 14, fontFamily: "'Roboto Mono', monospace", background: '#111', padding: '0 5px', borderRadius: 2, whiteSpace: 'nowrap', ...(selectable ? { userSelect: 'none', WebkitUserSelect: 'none' } : {}), cursor: interactive ? 'pointer' : undefined }}
        >
          {label}
        </div>
      </Html>
    </>
  )
}
