import type { Sketch, Constraints, Point } from '../types/cad'

/** Convert flat array format (from AST initial or server solve) to UI Sketch format.
 *  Ensures all entities are present in result, defaulting to zero-params if missing. */
export function unflattenGeometry(
  flat: Record<string, number[]> | undefined,
  entities: Array<{ id: string; kind: string }> | undefined
): Sketch {
  if (!entities) return {}
  const result: Sketch = {}
  const data = flat || {}

  for (const { id, kind } of entities) {
    const params = data[id] || (
      kind === 'line_segment' ? [0, 0, 0, 0] :
      kind === 'circle' ? [0, 0, 0] :
      kind === 'arc' ? [0, 0, 0, 0, 0] :
      kind === 'point' ? [0, 0] : []
    )

    if (kind === 'line_segment') {
      result[id] = {
        start: [params[0] || 0, params[1] || 0],
        end: [params[2] || 0, params[3] || 0],
      }
    } else if (kind === 'circle') {
      result[id] = {
        center: [params[0] || 0, params[1] || 0],
        radius: params[2] || 0,
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
      }
    } else if (kind === 'point') {
      result[id] = { x: params[0] || 0, y: params[1] || 0 }
    }
  }
  return result
}

export function geomPoint(sketch: Sketch, ref: { entity: string; point?: string }): [number, number] | null {
  const e = sketch[ref.entity]
  if (!e) return null
  const pt = ref.point || 'start'

  if ('start' in e && 'end' in e && 'radius' in e) {
    const arc = e as any
    return pt !== 'end' ? arc.start : arc.end
  } else if ('start' in e && 'end' in e) {
    const line = e as any
    return pt === 'end' ? line.end : line.start
  } else if ('center' in e) {
    return (e as any).center
  } else if ('x' in e) {
    const p = e as any
    return [p.x, p.y]
  }
  return null
}

export function computeConstraintRender(constraint: any, sketch: Sketch): any {
  const kind = constraint.kind

  if (kind === 'horizontal') {
    if (constraint.a && constraint.b) {
      const pa = geomPoint(sketch, constraint.a)
      const pb = geomPoint(sketch, constraint.b)
      if (!pa || !pb) return { kind: 'unknown' }
      const at: Point = [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2]
      return { kind: 'symbol_h', at, entity: constraint.a.entity, entities: [constraint.a.entity, constraint.b.entity] }
    }
    const eid = constraint.target?.entity
    if (!eid) return { kind: 'unknown' }
    const e = sketch[eid] as any
    if (!e || !e.start || !e.end) return { kind: 'unknown' }
    const at: Point = [(e.start[0] + e.end[0]) / 2, (e.start[1] + e.end[1]) / 2]
    return { kind: 'symbol_h', at, entity: eid }
  }

  if (kind === 'vertical') {
    if (constraint.a && constraint.b) {
      const pa = geomPoint(sketch, constraint.a)
      const pb = geomPoint(sketch, constraint.b)
      if (!pa || !pb) return { kind: 'unknown' }
      const at: Point = [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2]
      return { kind: 'symbol_v', at, entity: constraint.a.entity, entities: [constraint.a.entity, constraint.b.entity] }
    }
    const eid = constraint.target?.entity
    if (!eid) return { kind: 'unknown' }
    const e = sketch[eid] as any
    if (!e || !e.start || !e.end) return { kind: 'unknown' }
    const at: Point = [(e.start[0] + e.end[0]) / 2, (e.start[1] + e.end[1]) / 2]
    return { kind: 'symbol_v', at, entity: eid }
  }

  if (kind === 'length') {
    const eid = constraint.target?.entity
    if (!eid) return { kind: 'unknown' }
    const e = sketch[eid] as any
    if (!e || !e.start || !e.end) return { kind: 'unknown' }
    const dx = e.end[0] - e.start[0]
    const dy = e.end[1] - e.start[1]
    const n = Math.hypot(dx, dy)
    const normal: Point = n > 0 ? [-dy / n, dx / n] : [0, 1]
    return {
      kind: 'dim_linear',
      p1: e.start,
      p2: e.end,
      value: constraint.value || 0,
      normal,
      entity: eid,
    }
  }

  if (kind === 'radius') {
    const eid = constraint.target?.entity
    if (!eid) return { kind: 'unknown' }
    const e = sketch[eid] as any
    if (!e) return { kind: 'unknown' }
    const center = e.center
    const edge = e.start ? e.start : [e.center[0] + e.radius, e.center[1]]
    return {
      kind: 'dim_radius',
      p1: center,
      p2: edge,
      value: constraint.value || 0,
      entity: eid,
    }
  }

  if (kind === 'coincident') {
    const eid = constraint.a?.entity || constraint.target?.entity
    if (!eid) return { kind: 'unknown' }
    const pt = geomPoint(sketch, constraint.a || constraint.target)
    if (!pt) return { kind: 'unknown' }
    return {
      kind: 'symbol_coincident',
      at: pt,
      entity: eid,
      entities: [constraint.a?.entity, constraint.b?.entity, constraint.target?.entity].filter(Boolean) as string[],
    }
  }

  if (kind === 'perpendicular') {
    const eid = constraint.a?.entity
    const eid2 = constraint.b?.entity
    if (!eid) return { kind: 'unknown' }
    const ea = sketch[eid] as any
    const eb = eid2 ? sketch[eid2] as any : undefined
    const entities = [eid, eid2].filter(Boolean) as string[]
    if (eb && eb.center) {
      const pt = constraint.b?.point !== 'end' ? eb.start : eb.end
      return { kind: 'symbol_perp', at: pt, entity: eid2!, entities }
    }
    if (ea && ea.center) {
      const pt = constraint.a?.point !== 'end' ? ea.start : ea.end
      return { kind: 'symbol_perp', at: pt, entity: eid, entities }
    }
    if (!ea || !ea.end) return { kind: 'unknown' }
    return { kind: 'symbol_perp', at: ea.end, entity: eid, entities }
  }

  if (kind === 'parallel') {
    const eid = constraint.a?.entity
    if (!eid) return { kind: 'unknown' }
    const ea = sketch[eid] as any
    if (!ea || !ea.start || !ea.end) return { kind: 'unknown' }
    const at: Point = [(ea.start[0] + ea.end[0]) / 2, (ea.start[1] + ea.end[1]) / 2]
    return { kind: 'symbol_parallel', at, entity: eid, entities: [constraint.a?.entity, constraint.b?.entity].filter(Boolean) as string[] }
  }

  if (kind === 'angle') {
    const eid = constraint.a?.entity
    const eid2 = constraint.b?.entity
    if (!eid || !eid2) return { kind: 'unknown' }
    const ea = sketch[eid] as any
    const eb = sketch[eid2] as any
    if (!ea || !eb || !ea.start || !ea.end || !eb.end) return { kind: 'unknown' }
    return {
      kind: 'dim_angle',
      p1: ea.start,
      p2: ea.end,
      p3: eb.end,
      value: constraint.value || 0,
      entity: eid,
    }
  }

  if (kind === 'equal_length') {
    const eid = constraint.a?.entity
    const eid2 = constraint.b?.entity
    if (!eid || !eid2) return { kind: 'unknown' }
    const ea = sketch[eid] as any
    const eb = sketch[eid2] as any
    if (!ea || !eb || !ea.start || !ea.end || !eb.start || !eb.end) return { kind: 'unknown' }
    const at_a: Point = [(ea.start[0] + ea.end[0]) / 2, (ea.start[1] + ea.end[1]) / 2]
    return {
      kind: 'symbol_equal',
      at: at_a,
      entity: eid,
      entities: [eid, eid2],
    }
  }

  if (kind === 'point_distance') {
    const eid = constraint.a?.entity
    const eid2 = constraint.b?.entity
    if (!eid || !eid2) return { kind: 'unknown' }
    const pa = geomPoint(sketch, constraint.a)
    const pb = geomPoint(sketch, constraint.b)
    if (!pa || !pb) return { kind: 'unknown' }
    const dx = pb[0] - pa[0]
    const dy = pb[1] - pa[1]
    const n = Math.hypot(dx, dy)
    const normal: Point = n > 0 ? [-dy / n, dx / n] : [0, 1]
    return {
      kind: 'dim_linear',
      p1: pa,
      p2: pb,
      value: constraint.value || 0,
      normal,
      entity: eid,
    }
  }

  if (kind === 'midpoint') {
    const line = constraint.line
    if (!line) return { kind: 'unknown' }
    const eid = line.entity
    if (!eid) return { kind: 'unknown' }
    const e = sketch[eid] as any
    if (!e || !e.start || !e.end) return { kind: 'unknown' }
    const at: Point = [(e.start[0] + e.end[0]) / 2, (e.start[1] + e.end[1]) / 2]
    return {
      kind: 'symbol_midpoint',
      at,
      entity: eid,
      entities: [eid, constraint.point?.entity].filter(Boolean) as string[],
    }
  }

  if (kind === 'concentric') {
    const eid = constraint.a?.entity
    if (!eid) return { kind: 'unknown' }
    const e = sketch[eid] as any
    if (!e) return { kind: 'unknown' }
    const center = e.center ? e.center : [e.x, e.y]
    return { kind: 'symbol_concentric', at: center, entity: eid, entities: [eid, constraint.b?.entity].filter(Boolean) as string[] }
  }

  if (kind === 'fixed') {
    const eid = constraint.target?.entity
    if (!eid) return { kind: 'unknown' }
    const at = geomPoint(sketch, constraint.target)
    if (!at) return { kind: 'unknown' }
    return {
      kind: 'symbol_fixed',
      at,
      entity: eid,
    }
  }

  if (kind === 'tangent') {
    const arc = constraint.arc
    if (!arc) return { kind: 'unknown' }
    const arcEid = arc.entity
    if (!arcEid) return { kind: 'unknown' }
    const arcGeom = sketch[arcEid] as any
    if (!arcGeom) return { kind: 'unknown' }
    const pt = arc.point !== 'end' ? arcGeom.start : arcGeom.end
    return { kind: 'symbol_tangent', at: pt, entity: arcEid, entities: [constraint.line?.entity, arcEid].filter(Boolean) as string[] }
  }

  if (kind === 'normal') {
    const arc = constraint.arc
    if (!arc) return { kind: 'unknown' }
    const arcEid = arc.entity
    if (!arcEid) return { kind: 'unknown' }
    const arcGeom = sketch[arcEid] as any
    if (!arcGeom) return { kind: 'unknown' }
    const pt = arc.point !== 'end' ? arcGeom.start : arcGeom.end
    return { kind: 'symbol_normal', at: pt, entity: arcEid, entities: [constraint.line?.entity, arcEid].filter(Boolean) as string[] }
  }

  if (kind === 'colinear') {
    const eid = constraint.a?.entity || constraint.target?.entity
    if (!eid) return { kind: 'unknown' }
    const pt = geomPoint(sketch, constraint.a || constraint.target)
    if (!pt) return { kind: 'unknown' }
    return {
      kind: 'symbol_colinear',
      at: pt,
      entity: eid,
      entities: [constraint.a?.entity, constraint.b?.entity, constraint.target?.entity].filter(Boolean) as string[],
    }
  }

  return { kind: 'unknown' }
}

export function deriveConstraints(feature: any, sketch: Sketch): Constraints {
  if (!feature.constraints) return {}
  const result: Constraints = {}
  for (const c of feature.constraints) {
    const render = computeConstraintRender(c, sketch)
    if (render.kind === 'unknown') continue
    result[c.id] = { render, residual: 0 }
  }
  return result
}
