// PURE LOGIC -- no Three.js, no React, no WebSocket.
// Produces a live-preview sketch during pointer-down drag without a backend round-trip.
// Only coincidence constraints are honoured; other constraints relax silently.
// This is the "soft solve" path; the backend SciPy "hard solve" runs on pointer-up.
import type { Sketch, LineSegment, Circle, Arc, PointEntity, PartFeature } from '@/types/cad'
import type { DragState } from '@/stores/sketchEditorStore'

// A query string like "$entityIdstart" or "$entityIdend" encodes as:
//   "$" + entityId + vertexKey  (local refs used by coincident constraints).
// We only need to resolve local refs (those starting with "$") for the soft solve,
// since cross-feature coincidences are deferred.
function parseLocalRef(ref: string | undefined): { entityId: string; vertexKey: string } | null {
  if (!ref || !ref.startsWith('$')) return null
  // Local ref format: "$<entityId><vertexKey>"
  // Vertex keys are: start | end | center | xy
  const VERTEX_KEYS = ['start', 'end', 'center', 'xy'] as const
  const bare = ref.slice(1)  // strip leading "$"
  for (const key of VERTEX_KEYS) {
    if (bare.endsWith(key)) {
      const entityId = bare.slice(0, bare.length - key.length)
      if (entityId.length > 0) return { entityId, vertexKey: key }
    }
  }
  return null
}

/** Set the 2-D position of a vertex within a sketch entity (mutates). */
function setVertexPosition(sketch: Sketch, entityId: string, vertexKey: string, pos: [number, number]): void {
  const entity = sketch[entityId]
  if (!entity) return
  if (vertexKey === 'start' && 'start' in entity) {
    (entity as LineSegment | Arc).start = pos
  } else if (vertexKey === 'end' && 'end' in entity) {
    (entity as LineSegment | Arc).end = pos
  } else if (vertexKey === 'center' && 'center' in entity) {
    (entity as Circle | Arc).center = pos
  } else if (vertexKey === 'xy' && 'x' in entity) {
    const p = entity as PointEntity
    p.x = pos[0]
    p.y = pos[1]
  }
}

export interface SoftSolveInput {
  /** The solved sketch from the last hard solve (not mutated). */
  sketch: Sketch
  /** The active drag state (vertex or edge). dim_label drags are passed through unchanged. */
  drag: DragState
  /** Feature definition carrying the constraints list. May be undefined for sketches without constraints. */
  feature: PartFeature | undefined
}

/**
 * Compute a preview sketch for the current drag frame.
 *
 * Rules:
 * - Pure function: does not mutate inputs, does not call the backend.
 * - Coincident constraints: when a dragged vertex has coincident partners, the
 *   partners move to the same position so the sketch stays visually connected.
 * - All other constraints relax silently for now.
 * - dim_label drags: returned unchanged (label position is managed elsewhere).
 */
export function softSolve({ sketch, drag, feature }: SoftSolveInput): Sketch {
  if (drag.type === 'dim_label') return sketch

  const result = structuredClone(sketch)
  const d = drag as Extract<DragState, { type: 'vertex' | 'edge' }>

  if (d.type === 'edge') {
    // Move all vertices of the entity by the drag delta.
    const dx = d.currentWorld[0] - d.startWorld[0]
    const dy = d.currentWorld[1] - d.startWorld[1]
    if (dx === 0 && dy === 0) return sketch
    const entity = result[d.entityId]
    if (!entity) return sketch
    if ('start' in entity && 'end' in entity && 'radius' in entity) {
      const arc = entity as Arc
      arc.start = [arc.start[0] + dx, arc.start[1] + dy]
      arc.end = [arc.end[0] + dx, arc.end[1] + dy]
      arc.center = [arc.center[0] + dx, arc.center[1] + dy]
    } else if ('start' in entity && 'end' in entity) {
      const line = entity as LineSegment
      line.start = [line.start[0] + dx, line.start[1] + dy]
      line.end = [line.end[0] + dx, line.end[1] + dy]
    } else if ('center' in entity) {
      const circ = entity as Circle
      circ.center = [circ.center[0] + dx, circ.center[1] + dy]
    } else if ('x' in entity) {
      const pt = entity as PointEntity
      pt.x += dx; pt.y += dy
    }
    return result
  }

  // Vertex drag: move the dragged vertex to currentWorld.
  setVertexPosition(result, d.entityId, d.vertexKey, d.currentWorld)

  // Honour coincidence: find all vertices coincident to the dragged vertex
  // and move them to the same position.
  const constraints = feature?.constraints ?? []
  const draggedRef = `$${d.entityId}${d.vertexKey}`

  for (const c of constraints) {
    if (c.kind !== 'coincident') continue
    const ra = c.a
    const rb = c.b
    if (!ra || !rb) continue

    // Check if one side matches the dragged vertex and the other is a local ref.
    let partnerRef: string | null = null
    if (ra === draggedRef) partnerRef = rb
    else if (rb === draggedRef) partnerRef = ra

    if (!partnerRef) continue

    const partner = parseLocalRef(partnerRef)
    if (!partner) continue  // cross-feature ref: deferred

    // Move the coincident partner to where the dragged vertex now is.
    setVertexPosition(result, partner.entityId, partner.vertexKey, d.currentWorld)
  }

  return result
}
