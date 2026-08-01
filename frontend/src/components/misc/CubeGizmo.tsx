import * as THREE from 'three'
import { GIZMO_STYLE, type Pv, type Hit, computeGizmoHit } from '@/components/misc/CubeGizmo.utils'

// ─── Canvas overlay component ───

interface CubeGizmoCanvasProps {
  canvasRef: React.RefObject<HTMLCanvasElement | null>
  pvRef: React.MutableRefObject<Pv[]>
  hoverRef: React.MutableRefObject<Hit | null>
  snapRef: React.MutableRefObject<THREE.Vector3 | null>
  cameraRef: React.MutableRefObject<THREE.Camera | null>
}

export function CubeGizmoCanvas({ canvasRef, pvRef, hoverRef, snapRef, cameraRef }: CubeGizmoCanvasProps) {
  function coords(e: React.MouseEvent<HTMLCanvasElement>) {
    const el = canvasRef.current
    if (!el) return null
    const rect = el.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  function onMouseMove(e: React.MouseEvent<HTMLCanvasElement>) {
    const pos = coords(e)
    if (!pos || !cameraRef.current || pvRef.current.length === 0) return
    hoverRef.current = computeGizmoHit(pos.x, pos.y, pvRef.current, cameraRef.current)
    if (canvasRef.current)
      canvasRef.current.style.cursor = hoverRef.current ? 'pointer' : 'default'
  }

  function onMouseLeave() {
    hoverRef.current = null
    if (canvasRef.current) canvasRef.current.style.cursor = 'default'
  }

  function onClick(e: React.MouseEvent<HTMLCanvasElement>) {
    const pos = coords(e)
    if (!pos || !cameraRef.current || pvRef.current.length === 0) return
    const hit = computeGizmoHit(pos.x, pos.y, pvRef.current, cameraRef.current)
    if (hit) snapRef.current = hit.snapDir
  }

  return (
    <canvas
      ref={canvasRef}
      style={GIZMO_STYLE}
      onMouseMove={onMouseMove}
      onMouseLeave={onMouseLeave}
      onClick={onClick}
    />
  )
}
