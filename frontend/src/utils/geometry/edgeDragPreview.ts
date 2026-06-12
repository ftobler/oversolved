// PURE LOGIC -- no Three.js, no React, no WebSocket.
// Produces a live-preview sketch during an edge (whole-entity) drag.
// The dragged entity's vertices are translated by the drag delta.
// No constraint resolution -- the real solver handles that on pointer-up.
import type { Sketch } from '@/types/cad'
import type { VertexOrEdgeDrag } from '@/stores/sketchEditorStore'

function translateEntity(
  sketch: Sketch,
  entityId: string,
  dx: number,
  dy: number,
): void {
  const entity = sketch[entityId]
  if (!entity) return
  if ('start' in entity && 'end' in entity && 'radius' in entity) {
    const arc = entity as { start: [number, number]; end: [number, number]; center: [number, number] }
    arc.start = [arc.start[0] + dx, arc.start[1] + dy]
    arc.end = [arc.end[0] + dx, arc.end[1] + dy]
    arc.center = [arc.center[0] + dx, arc.center[1] + dy]
  } else if ('start' in entity && 'end' in entity) {
    const line = entity as { start: [number, number]; end: [number, number] }
    line.start = [line.start[0] + dx, line.start[1] + dy]
    line.end = [line.end[0] + dx, line.end[1] + dy]
  } else if ('p1' in entity) {
    const sp = entity as { p1: [number, number]; p2: [number, number]; p3: [number, number]; p4: [number, number] }
    sp.p1 = [sp.p1[0] + dx, sp.p1[1] + dy]
    sp.p2 = [sp.p2[0] + dx, sp.p2[1] + dy]
    sp.p3 = [sp.p3[0] + dx, sp.p3[1] + dy]
    sp.p4 = [sp.p4[0] + dx, sp.p4[1] + dy]
  } else if ('center' in entity) {
    const circ = entity as { center: [number, number] }
    circ.center = [circ.center[0] + dx, circ.center[1] + dy]
  } else if ('x' in entity) {
    const pt = entity as { x: number; y: number }
    pt.x += dx
    pt.y += dy
  }
}

export function edgeDragPreview(
  sketch: Sketch,
  drag: VertexOrEdgeDrag & { type: 'edge' },
): Sketch {
  const dx = drag.currentWorld[0] - drag.startWorld[0]
  const dy = drag.currentWorld[1] - drag.startWorld[1]
  if (dx === 0 && dy === 0) return sketch

  const result = structuredClone(sketch)
  translateEntity(result, drag.entityId, dx, dy)
  return result
}
