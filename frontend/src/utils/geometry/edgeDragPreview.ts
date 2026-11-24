// PURE LOGIC -- no Three.js, no React, no WebSocket.
// Produces a live-preview sketch during an edge (whole-entity) drag or a group
// drag. Every moved member's points are translated by the drag delta.
// No constraint resolution -- the real solver handles that on pointer-up.
import type { Sketch } from '@/types/cad'
import type { VertexOrEdgeDrag } from '@/types/drag'
import { fitPointIndex } from '@/types/vertexKeys'

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

/** A mutable view of one named point of a render-sketch entity. Null when the
 *  point is derived rather than stored (an arc end from center/radius/angle, an
 *  ellipse axis end from a/b/theta): the callers then move the whole entity,
 *  which is the group preview's rule for an unmapped member. */
interface VertexRef {
  get: () => [number, number]
  set: (value: [number, number]) => void
}

function vertexRef(entity: Sketch[string], vertexKey: string): VertexRef | null {
  const e = entity as unknown as Record<string, unknown>
  const pair = (prop: string): VertexRef => ({
    get: () => e[prop] as [number, number],
    set: (value) => { e[prop] = value },
  })
  if ('start' in e && 'end' in e && 'radius' in e) return null
  if ('start' in e && 'end' in e) {
    if (vertexKey === 'start' || vertexKey === 'end') return pair(vertexKey)
    return null
  }
  if ('p1' in e) {
    const prop = vertexKey === 'start' ? 'p1'
      : vertexKey === 'c1' ? 'p2'
        : vertexKey === 'c2' ? 'p3'
          : vertexKey === 'end' ? 'p4'
            : null
    return prop === null ? null : pair(prop)
  }
  if ('points' in e) {
    const fit = e as unknown as {
      points: [number, number][]
      handleStart?: [number, number]
      handleEnd?: [number, number]
    }
    if (vertexKey === 'c1') {
      return fit.handleStart === undefined ? null : {
        get: () => fit.handleStart as [number, number],
        set: (value) => { fit.handleStart = value },
      }
    }
    if (vertexKey === 'c2') {
      return fit.handleEnd === undefined ? null : {
        get: () => fit.handleEnd as [number, number],
        set: (value) => { fit.handleEnd = value },
      }
    }
    if (vertexKey === 'start') {
      return { get: () => fit.points[0], set: (value) => { fit.points[0] = value } }
    }
    if (vertexKey === 'end') {
      const index = fit.points.length - 1
      return { get: () => fit.points[index], set: (value) => { fit.points[index] = value } }
    }
    const index = fitPointIndex(vertexKey)
    // fit<k> names the k-th interior fit point, which is points[k].
    if (index === null || index < 1 || index >= fit.points.length - 1) return null
    return { get: () => fit.points[index], set: (value) => { fit.points[index] = value } }
  }
  if ('center' in e) {
    return vertexKey === 'center' ? pair('center') : null
  }
  if ('x' in e) {
    if (vertexKey !== 'xy') return null
    const pt = e as unknown as { x: number; y: number }
    return { get: () => [pt.x, pt.y], set: ([x, y]) => { pt.x = x; pt.y = y } }
  }
  return null
}

/** True when the translation fallback owns this drag: an edge drag, or a group
 *  drag (which may have been pressed on a vertex). A plain vertex drag is the
 *  WASM solve's job, so it must never route here. */
export function isTranslationDrag(drag: VertexOrEdgeDrag): boolean {
  return drag.type === 'edge' || (!!drag.group && drag.group.length > 1)
}

export function edgeDragPreview(
  sketch: Sketch,
  drag: VertexOrEdgeDrag,
  skipIds?: ReadonlySet<string>,
): Sketch {
  if (!isTranslationDrag(drag)) return sketch

  const dx = drag.currentWorld[0] - drag.startWorld[0]
  const dy = drag.currentWorld[1] - drag.startWorld[1]
  if (dx === 0 && dy === 0) return sketch

  const result = structuredClone(sketch)
  // A group drag moves every member, so the first frame does not show only the
  // grabbed element moving. Absent a group this is the old single translation.
  const members = drag.group && drag.group.length > 1
    ? drag.group
    : [{ entityId: drag.entityId, vertexKey: 'edge' }]
  // Resolve the whole-entity set before moving anything, so the outcome does not
  // depend on member order: one whole member and one of its point members must
  // move the entity once, whichever comes first.
  const whole = new Set<string>()
  for (const member of members) {
    const entity = result[member.entityId]
    if (!entity || member.vertexKey === 'edge' || vertexRef(entity, member.vertexKey) === null) {
      whole.add(member.entityId)
    }
  }
  const movedWhole = new Set<string>()
  const movedPoints = new Set<string>()
  for (const member of members) {
    // A projected member is pinned by the solve; translating it here would only
    // snap back on release.
    if (skipIds?.has(member.entityId)) continue
    if (whole.has(member.entityId)) {
      if (movedWhole.has(member.entityId)) continue
      movedWhole.add(member.entityId)
      translateEntity(result, member.entityId, dx, dy)
      continue
    }
    const pointKey = `${member.entityId}\u0000${member.vertexKey}`
    if (movedPoints.has(pointKey)) continue
    movedPoints.add(pointKey)
    const ref = vertexRef(result[member.entityId], member.vertexKey)
    if (!ref) continue
    const [x, y] = ref.get()
    ref.set([x + dx, y + dy])
  }
  return result
}
