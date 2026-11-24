// PURE LOGIC -- no Three.js, no React, no WebSocket.
// Produces a live-preview sketch during an edge (whole-entity) drag or a group
// drag. Every moved member's points are translated by the drag delta.
// No constraint resolution -- the real solver handles that on pointer-up.
import type { Sketch } from '@/types/cad'
import type { VertexOrEdgeDrag } from '@/types/drag'

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
  } else if ('points' in entity) {
    // A fit spline's handles are absolute points (D2), so they translate with
    // the fit points, exactly like the Bezier control points above.
    const fit = entity as {
      points: [number, number][]
      handleStart?: [number, number]
      handleEnd?: [number, number]
    }
    fit.points = fit.points.map(([x, y]) => [x + dx, y + dy])
    if (fit.handleStart) fit.handleStart = [fit.handleStart[0] + dx, fit.handleStart[1] + dy]
    if (fit.handleEnd) fit.handleEnd = [fit.handleEnd[0] + dx, fit.handleEnd[1] + dy]
  } else if ('center' in entity) {
    const circ = entity as { center: [number, number] }
    circ.center = [circ.center[0] + dx, circ.center[1] + dy]
  } else if ('x' in entity) {
    const pt = entity as { x: number; y: number }
    pt.x += dx
    pt.y += dy
  }
}

/** Translate one named point of an entity. Returns false when the point is
 *  derived rather than stored (an arc end from radius/angle, an ellipse axis
 *  end from a/b/theta): the caller then moves the whole entity, matching the
 *  group preview rule that an unmapped member translates as a unit. */
function translateVertex(
  sketch: Sketch,
  entityId: string,
  vertexKey: string,
  dx: number,
  dy: number,
): boolean {
  const entity = sketch[entityId]
  if (!entity) return false
  const move = (pair: [number, number]): [number, number] => [pair[0] + dx, pair[1] + dy]
  if ('start' in entity && 'end' in entity && 'radius' in entity) return false
  if ('start' in entity && 'end' in entity) {
    const line = entity as unknown as { start: [number, number]; end: [number, number] }
    if (vertexKey === 'start') line.start = move(line.start)
    else if (vertexKey === 'end') line.end = move(line.end)
    else return false
    return true
  }
  if ('p1' in entity) {
    const sp = entity as unknown as { p1: [number, number]; p2: [number, number]; p3: [number, number]; p4: [number, number] }
    const key = vertexKey === 'start' ? 'p1' : vertexKey === 'c1' ? 'p2' : vertexKey === 'c2' ? 'p3' : vertexKey === 'end' ? 'p4' : null
    if (key === null) return false
    sp[key] = move(sp[key])
    return true
  }
  if ('points' in entity) {
    const fit = entity as unknown as {
      points: [number, number][]
      handleStart?: [number, number]
      handleEnd?: [number, number]
    }
    if (vertexKey === 'c1' && fit.handleStart) fit.handleStart = move(fit.handleStart)
    else if (vertexKey === 'c2' && fit.handleEnd) fit.handleEnd = move(fit.handleEnd)
    else if (vertexKey === 'start') fit.points[0] = move(fit.points[0])
    else if (vertexKey === 'end') fit.points[fit.points.length - 1] = move(fit.points[fit.points.length - 1])
    else {
      const k = /^fit(\d+)$/.exec(vertexKey)
      const index = k === null ? NaN : Number(k[1])
      // fit<k> names the k-th interior fit point, which is points[k].
      if (!Number.isInteger(index) || index < 1 || index >= fit.points.length - 1) return false
      fit.points[index] = move(fit.points[index])
    }
    return true
  }
  if ('center' in entity) {
    if (vertexKey !== 'center') return false
    const circ = entity as unknown as { center: [number, number] }
    circ.center = move(circ.center)
    return true
  }
  if ('x' in entity) {
    if (vertexKey !== 'xy') return false
    const pt = entity as { x: number; y: number }
    pt.x += dx
    pt.y += dy
    return true
  }
  return false
}

export function edgeDragPreview(
  sketch: Sketch,
  drag: VertexOrEdgeDrag & { type: 'edge' },
): Sketch {
  const dx = drag.currentWorld[0] - drag.startWorld[0]
  const dy = drag.currentWorld[1] - drag.startWorld[1]
  if (dx === 0 && dy === 0) return sketch

  const result = structuredClone(sketch)
  // A group drag moves every member, so the first frame does not show only the
  // grabbed element moving. Absent a group this is the old single translation.
  // A whole-entity effect happens once per entity: two point members of one
  // arc both fall back to their whole entity, which must not move twice.
  const members = drag.group && drag.group.length > 1
    ? drag.group
    : [{ entityId: drag.entityId, vertexKey: 'edge' }]
  const movedWhole = new Set<string>()
  for (const member of members) {
    if (member.vertexKey !== 'edge' && translateVertex(result, member.entityId, member.vertexKey, dx, dy)) continue
    if (movedWhole.has(member.entityId)) continue
    movedWhole.add(member.entityId)
    translateEntity(result, member.entityId, dx, dy)
  }
  return result
}
