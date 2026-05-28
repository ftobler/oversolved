import type {
  Sketch, Constraints, Point,
  PartEntityDef, PartFeature, PartConstraint, ConstraintRender,
  LineSegment, Circle, Arc, PointEntity,
  ProjectedLineSegment, ProjectedCircle, ProjectedArc, ProjectedPointEntity,
} from '@/types/cad'
import { getDefaultParams } from '@/registry'
import { getEntityKind } from '@/types/cad'

type ResolvedRef = { entity: string; point?: string } | null | undefined

interface ResolvedConstraint {
  id: string
  kind: string
  value?: number
  target?: ResolvedRef
  a?: ResolvedRef
  b?: ResolvedRef
  line?: ResolvedRef
  arc?: ResolvedRef
  point?: ResolvedRef
  point_a?: ResolvedRef
  point_b?: ResolvedRef
  pos?: [number, number]
}

/** Convert flat array format (from AST initial or server solve) to UI Sketch format.
 *  Ensures all entities are present in result, defaulting to zero-params if missing. */
export function unflattenGeometry(
  flat: Record<string, number[]> | undefined,
  entities: PartEntityDef[] | undefined
): Sketch {
  if (!entities) return {}
  const result: Sketch = {}
  const data = flat || {}

  for (const entityDef of entities) {
    const { id, kind } = entityDef
    const construction = entityDef.construction === true
    const params = data[id] || getDefaultParams(kind)

    if (kind === 'line') {
      result[id] = {
        start: [params[0] || 0, params[1] || 0],
        end: [params[2] || 0, params[3] || 0],
        ...(construction && { construction: true }),
      }
    } else if (kind === 'circle') {
      result[id] = {
        center: [params[0] || 0, params[1] || 0],
        radius: params[2] || 0,
        ...(construction && { construction: true }),
      }
    } else if (kind === 'arc') {
      const cx = params[0] || 0, cy = params[1] || 0, r = params[2] || 0, a0 = params[3] || 0, a1 = params[4] || 0
      result[id] = {
        center: [cx, cy],
        radius: r,
        angle_start: a0,
        angle_end: a1,
        start: [cx + r * Math.cos((a0 * Math.PI) / 180), cy + r * Math.sin((a0 * Math.PI) / 180)],
        end: [cx + r * Math.cos((a1 * Math.PI) / 180), cy + r * Math.sin((a1 * Math.PI) / 180)],
        ...(construction && { construction: true }),
      }
    } else if (kind === 'point') {
      result[id] = { x: params[0] || 0, y: params[1] || 0 }
    } else if (kind === 'projected_line') {
      const source = entityDef.source ?? ''
      result[id] = {
        start: [params[0] || 0, params[1] || 0],
        end: [params[2] || 0, params[3] || 0],
        projected: true,
        source,
      } as ProjectedLineSegment
    } else if (kind === 'projected_circle') {
      const source = entityDef.source ?? ''
      result[id] = {
        center: [params[0] || 0, params[1] || 0],
        radius: params[2] || 0,
        projected: true,
        source,
      } as ProjectedCircle
    } else if (kind === 'projected_arc') {
      const cx = params[0] || 0, cy = params[1] || 0, r = params[2] || 0, a0 = params[3] || 0, a1 = params[4] || 0
      const source = entityDef.source ?? ''
      result[id] = {
        center: [cx, cy],
        radius: r,
        angle_start: a0,
        angle_end: a1,
        start: [cx + r * Math.cos((a0 * Math.PI) / 180), cy + r * Math.sin((a0 * Math.PI) / 180)],
        end: [cx + r * Math.cos((a1 * Math.PI) / 180), cy + r * Math.sin((a1 * Math.PI) / 180)],
        projected: true,
        source,
      } as ProjectedArc
    } else if (kind === 'projected_point') {
      const source = entityDef.source ?? ''
      result[id] = {
        x: params[0] || 0,
        y: params[1] || 0,
        projected: true,
        source,
      } as ProjectedPointEntity
    }
  }
  return result
}

const KNOWN_POINTS = ['start', 'end', 'center', 'xy'] as const

/** Resolve a query string (e.g. "$line1" or "$arc1start") to an {entity, point?} ref.
 *  Tries known sub-element suffixes first, then falls back to a bare entity lookup. */
function resolveQueryRef(q: string | undefined, sketch: Sketch): { entity: string; point?: string } | null {
  if (!q) return null
  if (!q.startsWith('$')) return null
  const local = q.slice(1)
  for (const pt of KNOWN_POINTS) {
    if (local.length > pt.length && local.endsWith(pt)) {
      const eid = local.slice(0, -pt.length)
      if (sketch[eid]) return { entity: eid, point: pt }
    }
  }
  if (sketch[local]) return { entity: local }
  return null
}

export function geomPoint(sketch: Sketch, ref: { entity: string; point?: string }): [number, number] | null {
  const entity = sketch[ref.entity]
  if (!entity) return null
  const pt = ref.point || 'start'

  const kind = getEntityKind(entity)
  if (kind === 'arc') {
    const arc = entity as Arc | ProjectedArc
    return pt !== 'end' ? arc.start : arc.end
  } else if (kind === 'line') {
    const line = entity as LineSegment | ProjectedLineSegment
    return pt === 'end' ? line.end : line.start
  } else if (kind === 'circle') {
    return (entity as Circle | ProjectedCircle).center
  } else {
    const p = entity as PointEntity | ProjectedPointEntity
    return [p.x, p.y]
  }
}

export function computeConstraintRender(constraint: PartConstraint, sketch: Sketch): ConstraintRender {
  // Normalize refs: convert query strings to {entity, point?} objects.
  const normalize = (q: string | undefined): ResolvedRef => typeof q === 'string' ? resolveQueryRef(q, sketch) : q
  const resolved: ResolvedConstraint = {
    ...constraint,
    target:  normalize(constraint.target),
    a:       normalize(constraint.a),
    b:       normalize(constraint.b),
    line:    normalize(constraint.line),
    arc:     normalize(constraint.arc),
    point:   normalize(constraint.point),
    point_a: normalize(constraint.point_a),
    point_b: normalize(constraint.point_b),
  }
  const kind = resolved.kind

  if (kind === 'horizontal') {
    if (resolved.a && resolved.b) {
      const pa = geomPoint(sketch, resolved.a)
      const pb = geomPoint(sketch, resolved.b)
      if (!pa || !pb) return { kind: 'unknown' }
      const at: Point = [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2]
      return { kind: 'symbol_h', at, entity: resolved.a.entity, entities: [resolved.a.entity, resolved.b.entity] }
    }
    const eid = resolved.target?.entity
    if (!eid) return { kind: 'unknown' }
    const e = sketch[eid] as LineSegment | Arc
    if (!e || !('start' in e) || !('end' in e)) return { kind: 'unknown' }
    const at: Point = [(e.start[0] + e.end[0]) / 2, (e.start[1] + e.end[1]) / 2]
    return { kind: 'symbol_h', at, entity: eid }
  }

  if (kind === 'vertical') {
    if (resolved.a && resolved.b) {
      const pa = geomPoint(sketch, resolved.a)
      const pb = geomPoint(sketch, resolved.b)
      if (!pa || !pb) return { kind: 'unknown' }
      const at: Point = [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2]
      return { kind: 'symbol_v', at, entity: resolved.a.entity, entities: [resolved.a.entity, resolved.b.entity] }
    }
    const eid = resolved.target?.entity
    if (!eid) return { kind: 'unknown' }
    const e = sketch[eid] as LineSegment | Arc
    if (!e || !('start' in e) || !('end' in e)) return { kind: 'unknown' }
    const at: Point = [(e.start[0] + e.end[0]) / 2, (e.start[1] + e.end[1]) / 2]
    return { kind: 'symbol_v', at, entity: eid }
  }

  if (kind === 'length') {
    const eid = resolved.target?.entity
    if (!eid) return { kind: 'unknown' }
    const e = sketch[eid] as LineSegment | Arc
    if (!e || !('start' in e) || !('end' in e)) return { kind: 'unknown' }
    const dx = e.end[0] - e.start[0]
    const dy = e.end[1] - e.start[1]
    const n = Math.hypot(dx, dy)
    const normal: Point = n > 0 ? [-dy / n, dx / n] : [0, 1]
    return {
      kind: 'dim_linear',
      p1: e.start,
      p2: e.end,
      value: resolved.value || 0,
      normal,
      entity: eid,
      ...(resolved.pos && { pos: resolved.pos }),
    }
  }

  if (kind === 'radius') {
    const eid = resolved.target?.entity
    if (!eid) return { kind: 'unknown' }
    const e = sketch[eid] as Circle | Arc
    if (!e) return { kind: 'unknown' }
    const center = e.center
    const edge = 'start' in e ? e.start : [e.center[0] + e.radius, e.center[1]] as Point
    return {
      kind: 'dim_radius',
      p1: center,
      p2: edge,
      value: resolved.value || 0,
      entity: eid,
      ...(resolved.pos && { pos: resolved.pos }),
    }
  }

  if (kind === 'diameter') {
    const eid = resolved.target?.entity
    if (!eid) return { kind: 'unknown' }
    const e = sketch[eid] as Circle | Arc
    if (!e) return { kind: 'unknown' }
    const cx = e.center[0], cy = e.center[1], r = e.radius
    return {
      kind: 'dim_diameter',
      p1: [cx - r, cy] as [number, number],
      p2: [cx + r, cy] as [number, number],
      value: resolved.value || 0,
      entity: eid,
      ...(resolved.pos && { pos: resolved.pos }),
    }
  }

  if (kind === 'coincident') {
    const eid = resolved.a?.entity || resolved.target?.entity
    if (!eid) return { kind: 'unknown' }
    const ref = resolved.a ?? resolved.target
    if (!ref) return { kind: 'unknown' }
    const pt = geomPoint(sketch, ref)
    if (!pt) return { kind: 'unknown' }
    return {
      kind: 'symbol_coincident',
      at: pt,
      entity: eid,
      entities: [resolved.a?.entity, resolved.b?.entity, resolved.target?.entity].filter(Boolean) as string[],
    }
  }

  if (kind === 'normal') {
    const eid = resolved.a?.entity
    const eid2 = resolved.b?.entity
    if (!eid) return { kind: 'unknown' }
    const ea = sketch[eid] as Arc | LineSegment
    const eb = eid2 ? sketch[eid2] as Arc | LineSegment : undefined
    const entities = [eid, eid2].filter(Boolean) as string[]
    if (eb && 'center' in eb) {
      const pt = resolved.b?.point !== 'end' ? (eb as Arc).start : (eb as Arc).end
      return { kind: 'symbol_normal', at: pt, entity: eid2!, entities }
    }
    if (ea && 'center' in ea) {
      const pt = resolved.a?.point !== 'end' ? (ea as Arc).start : (ea as Arc).end
      return { kind: 'symbol_normal', at: pt, entity: eid, entities }
    }
    if (!ea || !('end' in ea)) return { kind: 'unknown' }
    return { kind: 'symbol_normal', at: (ea as LineSegment).end, entity: eid, entities }
  }

  if (kind === 'parallel') {
    const eid = resolved.a?.entity
    if (!eid) return { kind: 'unknown' }
    const ea = sketch[eid] as LineSegment | Arc
    if (!ea || !('start' in ea) || !('end' in ea)) return { kind: 'unknown' }
    const at: Point = [(ea.start[0] + ea.end[0]) / 2, (ea.start[1] + ea.end[1]) / 2]
    return { kind: 'symbol_parallel', at, entity: eid, entities: [resolved.a?.entity, resolved.b?.entity].filter(Boolean) as string[] }
  }

  if (kind === 'angle') {
    const eid = resolved.a?.entity
    const eid2 = resolved.b?.entity
    if (!eid || !eid2) return { kind: 'unknown' }
    const ea = sketch[eid] as LineSegment | Arc
    const eb = sketch[eid2] as LineSegment | Arc
    if (!ea || !eb || !('start' in ea) || !('end' in ea) || !('start' in eb) || !('end' in eb)) return { kind: 'unknown' }
    // Parallel lines have no meaningful angle vertex (intersection at infinity).
    // Render as a perpendicular linear distance so the dim is visually correct,
    // matching the Dimension-tool preview's resolution for the parallel case.
    const dax = ea.end[0] - ea.start[0]
    const day = ea.end[1] - ea.start[1]
    const dbx = eb.end[0] - eb.start[0]
    const dby = eb.end[1] - eb.start[1]
    const na = Math.hypot(dax, day)
    const nb = Math.hypot(dbx, dby)
    const parallel = na > 0 && nb > 0 && Math.abs(dax * dby - day * dbx) / (na * nb) <= 1e-6
    if (parallel) {
      const normal: Point = [dax / na, day / na]
      const perpDir: [number, number] = [-day / na, dax / na]
      const pb: Point = eb.start
      const t = (pb[0] - ea.start[0]) * perpDir[0] + (pb[1] - ea.start[1]) * perpDir[1]
      const foot: Point = [pb[0] - t * perpDir[0], pb[1] - t * perpDir[1]]
      return {
        kind: 'dim_linear',
        p1: foot,
        p2: pb,
        // Use the geometric perpendicular distance rather than the constraint's
        // angle value -- the angle is 0/180 by parallelism and would render as
        // a misleading "0" between visibly separated lines.
        value: Math.abs(t),
        normal,
        entity: eid,
        ...(resolved.pos && { pos: resolved.pos }),
      }
    }
    return {
      kind: 'dim_angle',
      p1: ea.start,
      p2: ea.end,
      p3: eb.start,
      p4: eb.end,
      value: resolved.value || 0,
      entity: eid,
      ...(resolved.pos && { pos: resolved.pos }),
    }
  }

  if (kind === 'equal_length') {
    const eid = resolved.a?.entity
    const eid2 = resolved.b?.entity
    if (!eid || !eid2) return { kind: 'unknown' }
    const ea = sketch[eid] as LineSegment | Arc
    const eb = sketch[eid2] as LineSegment | Arc
    if (!ea || !eb || !('start' in ea) || !('end' in ea) || !('start' in eb) || !('end' in eb)) return { kind: 'unknown' }
    const at_a: Point = [(ea.start[0] + ea.end[0]) / 2, (ea.start[1] + ea.end[1]) / 2]
    return {
      kind: 'symbol_equal',
      at: at_a,
      entity: eid,
      entities: [eid, eid2],
    }
  }

  if (kind === 'point_distance') {
    const eid = resolved.a?.entity
    const eid2 = resolved.b?.entity
    if (!eid || !eid2 || !resolved.a || !resolved.b) return { kind: 'unknown' }
    const pa = geomPoint(sketch, resolved.a)
    const pb = geomPoint(sketch, resolved.b)
    if (!pa || !pb) return { kind: 'unknown' }
    const dx = pb[0] - pa[0]
    const dy = pb[1] - pa[1]
    const n = Math.hypot(dx, dy)
    const normal: Point = n > 0 ? [-dy / n, dx / n] : [0, 1]
    return {
      kind: 'dim_linear',
      p1: pa,
      p2: pb,
      value: resolved.value || 0,
      normal,
      entity: eid,
      ...(resolved.pos && { pos: resolved.pos }),
    }
  }

  if (kind === 'line_distance') {
    const eid = resolved.a?.entity
    if (!eid || !resolved.b) return { kind: 'unknown' }
    const ea = sketch[eid] as LineSegment | Arc
    if (!ea || !('start' in ea) || !('end' in ea)) return { kind: 'unknown' }
    const pb = geomPoint(sketch, resolved.b)
    if (!pb) return { kind: 'unknown' }
    const dx = ea.end[0] - ea.start[0]
    const dy = ea.end[1] - ea.start[1]
    const n = Math.hypot(dx, dy)
    // normal must be along the line direction (perpendicular to the measurement) so that
    // dragging the label slides the dimension line sideways, not along the measurement axis.
    const normal: Point = n > 0 ? [dx / n, dy / n] : [0, 1]
    const perpDir: [number, number] = n > 0 ? [-dy / n, dx / n] : [1, 0]
    const t = (pb[0] - ea.start[0]) * perpDir[0] + (pb[1] - ea.start[1]) * perpDir[1]
    const foot: Point = [pb[0] - t * perpDir[0], pb[1] - t * perpDir[1]]
    return {
      kind: 'dim_linear',
      p1: foot,
      p2: pb,
      value: resolved.value || 0,
      normal,
      entity: eid,
      ...(resolved.pos && { pos: resolved.pos }),
    }
  }

  if (kind === 'midpoint') {
    const line = resolved.line
    if (!line) return { kind: 'unknown' }
    const eid = line.entity
    if (!eid) return { kind: 'unknown' }
    const e = sketch[eid] as LineSegment | Arc
    if (!e || !('start' in e) || !('end' in e)) return { kind: 'unknown' }
    const at: Point = [(e.start[0] + e.end[0]) / 2, (e.start[1] + e.end[1]) / 2]
    return {
      kind: 'symbol_midpoint',
      at,
      entity: eid,
      entities: [eid, resolved.point?.entity].filter(Boolean) as string[],
    }
  }

  if (kind === 'concentric') {
    const eid = resolved.a?.entity
    if (!eid) return { kind: 'unknown' }
    const e = sketch[eid] as Circle | Arc | PointEntity
    if (!e) return { kind: 'unknown' }
    const center = 'center' in e ? e.center : [e.x, e.y] as Point
    return { kind: 'symbol_concentric', at: center, entity: eid, entities: [eid, resolved.b?.entity].filter(Boolean) as string[] }
  }

  if (kind === 'fixed') {
    const eid = resolved.target?.entity
    if (!eid || !resolved.target) return { kind: 'unknown' }
    const at = geomPoint(sketch, resolved.target)
    if (!at) return { kind: 'unknown' }
    return {
      kind: 'symbol_fixed',
      at,
      entity: eid,
      ...(resolved.target?.point != null && { point: resolved.target.point }),
    }
  }

  if (kind === 'tangent') {
    // supports both line/arc keys and a/b keys
    const bEid = resolved.b?.entity
    const bGeom = bEid ? sketch[bEid] : undefined
    const arc = resolved.arc ?? (bGeom && 'center' in bGeom ? resolved.b : resolved.a)
    if (!arc) return { kind: 'unknown' }
    const arcEid = arc.entity
    if (!arcEid) return { kind: 'unknown' }
    const arcGeom = sketch[arcEid] as Arc | Circle
    if (!arcGeom) return { kind: 'unknown' }
    const lineEid = resolved.line?.entity ?? (arcEid === resolved.a?.entity ? resolved.b?.entity : resolved.a?.entity)
    let pt: [number, number]
    if ('start' in arcGeom) {
      // arc: use the pinned endpoint
      pt = arc.point !== 'end' ? arcGeom.start : arcGeom.end
    } else if ('center' in arcGeom && lineEid) {
      // circle + line: tangent point is foot of perpendicular from center to line
      const lineGeom = sketch[lineEid] as LineSegment | undefined
      if (lineGeom && 'start' in lineGeom && 'end' in lineGeom) {
        const [cx, cy] = arcGeom.center
        const [x0, y0] = lineGeom.start
        const [x1, y1] = lineGeom.end
        const dx = x1 - x0
        const dy = y1 - y0
        const len2 = dx * dx + dy * dy
        if (len2 > 1e-12) {
          const t = Math.max(0, Math.min(1, ((cx - x0) * dx + (cy - y0) * dy) / len2))
          pt = [x0 + t * dx, y0 + t * dy]
        } else {
          pt = [x0, y0]
        }
      } else {
        pt = arcGeom.center
      }
    } else {
      pt = arcGeom.center
    }
    return { kind: 'symbol_tangent', at: pt, entity: arcEid, entities: [lineEid, arcEid].filter(Boolean) as string[] }
  }

  if (kind === 'colinear') {
    const eid = resolved.a?.entity || resolved.target?.entity
    if (!eid) return { kind: 'unknown' }
    const colinearRef = resolved.a ?? resolved.target
    if (!colinearRef) return { kind: 'unknown' }
    const pt = geomPoint(sketch, colinearRef)
    if (!pt) return { kind: 'unknown' }
    return {
      kind: 'symbol_colinear',
      at: pt,
      entity: eid,
      entities: [resolved.a?.entity, resolved.b?.entity, resolved.target?.entity].filter(Boolean) as string[],
    }
  }

  return { kind: 'unknown' }
}

export function deriveConstraints(feature: PartFeature, sketch: Sketch): Constraints {
  if (!feature.constraints) return {}
  const result: Constraints = {}
  for (const c of feature.constraints) {
    const render = computeConstraintRender(c, sketch)
    if (render.kind === 'unknown') continue
    result[c.id] = { render, residual: 0 }
  }
  return result
}
