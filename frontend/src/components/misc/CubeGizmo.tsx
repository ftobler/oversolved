import * as THREE from 'three'
import { GIZMO_STYLE, type Pv, type Hit, computeGizmoHit } from '@/components/misc/CubeGizmo.utils'

// ─── Canvas overlay component ───

interface CubeGizmoCanvasProps {
  canvasRef: React.RefObject<HTMLCanvasElement | null>
  pvRef: React.MutableRefObject<Pv[]>
  hoverRef: React.MutableRefObject<Hit | null>
  snapRef: React.MutableRefObject<THREE.Vector3 | null>
  cameraRef: React.MutableRefObject<THREE.Camera | null>
  // The viewport draws on demand, and this HUD canvas is painted from the
  // render loop (SceneController's useFrame). Hover and snap both change what
  // that frame would draw while touching nothing React can see, so each asks
  // for a frame through here.
  onRequestRender?: () => void
}

export function CubeGizmoCanvas({ canvasRef, pvRef, hoverRef, snapRef, cameraRef, onRequestRender }: CubeGizmoCanvasProps) {
  function coords(e: React.MouseEvent<HTMLCanvasElement>) {
    const el = canvasRef.current
    if (!el) return null
    const rect = el.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  // The drawn hover state is exactly the hit's type and index (drawCubeGizmo's
  // own comparison), so a move that stays on the same face is not a reason to
  // draw a frame: without this, grazing the cube would redraw the whole scene
  // and the pick buffer per pointermove.
  function hoverIdentity(hit: Hit | null): string | null {
    return hit ? `${hit.type}:${hit.index}` : null
  }

  function onMouseMove(e: React.MouseEvent<HTMLCanvasElement>) {
    const pos = coords(e)
    if (!pos || !cameraRef.current || pvRef.current.length === 0) return
    const next = computeGizmoHit(pos.x, pos.y, pvRef.current, cameraRef.current)
    const changed = hoverIdentity(next) !== hoverIdentity(hoverRef.current)
    hoverRef.current = next
    if (canvasRef.current)
      canvasRef.current.style.cursor = next ? 'pointer' : 'default'
    if (changed) onRequestRender?.()
  }

  function onMouseLeave() {
    const hadHover = hoverRef.current !== null
    hoverRef.current = null
    if (canvasRef.current) canvasRef.current.style.cursor = 'default'
    if (hadHover) onRequestRender?.()
  }

  function onClick(e: React.MouseEvent<HTMLCanvasElement>) {
    const pos = coords(e)
    if (!pos || !cameraRef.current || pvRef.current.length === 0) return
    const hit = computeGizmoHit(pos.x, pos.y, pvRef.current, cameraRef.current)
    if (hit) {
      snapRef.current = hit.snapDir
      onRequestRender?.()
    }
  }

  return (
    <canvas
      ref={canvasRef}
      style={GIZMO_STYLE}
      onMouseMove={onMouseMove}
      onMouseLeave={onMouseLeave}
      // This canvas is stacked inside the viewport pane, whose container-level
      // handlers open a rubber band and a click gesture on any left press. A press
      // aimed at the cube belongs to the cube: letting it bubble opens a box drag
      // from under the widget, and (before the capture was deferred) swallowed this
      // canvas's own click outright. Same guard ContextMenuDialog applies.
      onPointerDown={e => e.stopPropagation()}
      onPointerUp={e => e.stopPropagation()}
      onClick={e => { e.stopPropagation(); onClick(e) }}
    />
  )
}
