import type {
  Sketch, Constraints, Point,
  PartEntityDef, PartFeature, PartConstraint, ConstraintRender,
  LineSegment, Circle, Arc, PointEntity, Ellipse, Spline,
  ProjectedLineSegment, ProjectedCircle, ProjectedArc, ProjectedPointEntity, ProjectedEllipse, ProjectedSpline,
} from '@/types/cad'
import { getDefaultParams } from '@/registry'
import { getEntityKind } from '@/types/cad'
import { segmentsAreParallel } from '@/utils/geometry/segmentGeometry'
// Import from ellipseAxis directly (not the sketchHelpers re-export): sketchHelpers
// pulls in Three.js, and this module sits in the headless closure of the sketch
// editor store, which must stay Three-free.
import { ellipseAxisPoints } from '@/utils/geometry/ellipseAxis'
import { resolveVertexRef } from '@/types/vertexRef'

type ResolvedRef = { entity: string; point?: string } | null | undefined

// Legacy projected_* kinds normalize to their base geometric kind; projection
// is signalled by the entity's `source`, not by the kind. Tolerated on read so
// documents saved before the kind-collapse keep loading.
const BASE_KIND: Readonly<Record<string, string>> = {
  projected_line: 'line',
  projected_circle: 'circle',
  projected_arc: 'arc',
  projected_point: 'point',
}

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

/** Convert flat array format (from AST initial or solver output) to UI Sketch format.
 *  Ensures all entities are present in result, defaulting to zero-params if missing. */
export function unflattenGeometry(
  flat: Record<string, number[]> | undefined,
  entities: PartEntityDef[] | undefined
): Sketch {
  if (!entities) return {}
  const result: Sketch = {}
  const data = flat || {}

  for (const entityDef of entities) {
    const { id } = entityDef
    // Projection is a metadata flag carried by `source`, not a distinct kind.
    // Legacy docs may still use projected_* kinds; normalize them to base kinds.
    const kind = BASE_KIND[entityDef.kind] ?? entityDef.kind
    const source = entityDef.source
    const projected = source != null && source !== ''
    const construction = entityDef.construction === true
    const params = data[id] || getDefaultParams(kind)
    const projTag = projected ? { projected: true as const, source: source as string } : null

    if (kind === 'line') {
      result[id] = {
        start: [params[0] || 0, params[1] || 0],
        end: [params[2] || 0, params[3] || 0],
        ...(construction && { construction: true }),
        ...(projTag ?? {}),
      } as LineSegment | ProjectedLineSegment
    } else if (kind === 'circle') {
      result[id] = {
        center: [params[0] || 0, params[1] || 0],
        radius: params[2] || 0,
        ...(construction && { construction: true }),
        ...(projTag ?? {}),
      } as Circle | ProjectedCircle
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
        ...(projTag ?? {}),
      } as Arc | ProjectedArc
    } else if (kind === 'ellipse') {
      result[id] = {
        center: [params[0] || 0, params[1] || 0],
        a: params[2] || 0,
        b: params[3] || 0,
        theta: params[4] || 0,
        ...(construction && { construction: true }),
        ...(projTag ?? {}),
      } as Ellipse | ProjectedEllipse
    } else if (kind === 'spline') {
      result[id] = {
        p1: [params[0] || 0, params[1] || 0],
        p2: [params[2] || 0, params[3] || 0],
        p3: [params[4] || 0, params[5] || 0],
        p4: [params[6] || 0, params[7] || 0],
        ...(construction && { construction: true }),
        ...(projTag ?? {}),
      } as Spline | ProjectedSpline
    } else if (kind === 'point') {
      result[id] = {
        x: params[0] || 0,
        y: params[1] || 0,
        ...(construction && { construction: true }),
        ...(projTag ?? {}),
      } as PointEntity | ProjectedPointEntity
    }
  }
  return result
}

/** Resolve a query string (e.g. "$line1" or "$arc1start") to an {entity, point?} ref.
 *  Thin wrapper over the shared vertex-ref reader; types/vertexRef owns the
 *  full-id-first + longest-eid tie-break. Dict refs are passed through by the
 *  callers' `normalize`, so only the string form reaches here. */
function resolveQueryRef(q: string | undefined, knownIds: ReadonlySet<string>): { entity: string; point?: string } | null {
  if (typeof q !== 'string') return null
  return resolveVertexRef(knownIds, q)
}

export function geomPoint(sketch: Sketch, ref: { entity: string; point?: string }): [number, number] | null {
  const entity = sketch[ref.entity]
  if (!entity) return null
  const pt = ref.point || 'start'

  const kind = getEntityKind(entity)
  if (kind === 'arc') {
    const arc = entity as Arc | ProjectedArc
    if (pt === 'center') return [...arc.center] as [number, number]
    return pt !== 'end' ? arc.start : arc.end
  } else if (kind === 'line') {
    const line = entity as LineSegment | ProjectedLineSegment
    return pt === 'end' ? line.end : line.start
  } else if (kind === 'circle') {
    return (entity as Circle | ProjectedCircle).center
  } else if (kind === 'ellipse') {
    const el = entity as Ellipse | ProjectedEllipse
    if (pt === 'major1' || pt === 'major2' || pt === 'minor1' || pt === 'minor2') {
      return ellipseAxisPoints(el.center[0], el.center[1], el.a, el.b, el.theta)[pt]
    }
    return [...el.center] as [number, number]
  } else if (kind === 'spline') {
    const sp = entity as Spline | ProjectedSpline
    if (pt === 'end') return [...sp.p4] as [number, number]
    if (pt === 'c1') return [...sp.p2] as [number, number]
    if (pt === 'c2') return [...sp.p3] as [number, number]
    return [...sp.p1] as [number, number]
  } else {
    const p = entity as PointEntity | ProjectedPointEntity
    return [p.x, p.y]
  }
}

// Public entry point. Delegates to the per-kind core renderer, then guarantees
// a selectable glyph: when the core can't build a specific render (an unknown
// or hand-edited shape, e.g. a parallel between two circles) we anchor a generic
// `symbol_unknown` tile at the first resolvable operand so the constraint stays
// visible and deletable rather than silently vanishing from the canvas.
export function computeConstraintRender(constraint: PartConstraint, sketch: Sketch): ConstraintRender {
  const render = computeConstraintRenderCore(constraint, sketch)
  if (render.kind !== 'unknown') return render
  return fallbackConstraintGlyph(constraint, sketch)
}

// Anchor a fallback glyph at the first operand that resolves to a point. Returns
// `unknown` only when nothing resolves (e.g. every referenced entity is gone),
// in which case there is genuinely nowhere to put a tile.
function fallbackConstraintGlyph(constraint: PartConstraint, sketch: Sketch): ConstraintRender {
  const knownIds = new Set(Object.keys(sketch))
  const normalize = (q: string | undefined): ResolvedRef => typeof q === 'string' ? resolveQueryRef(q, knownIds) : q
  const refs = [
    constraint.a, constraint.b, constraint.target,
    constraint.line, constraint.arc, constraint.point,
    constraint.point_a, constraint.point_b,
  ].map(normalize).filter((r): r is { entity: string; point?: string } => !!r)
  const entities = [...new Set(refs.map(r => r.entity))]
  for (const ref of refs) {
    const at = geomPoint(sketch, ref)
    if (at) return { kind: 'symbol_unknown', at, entity: ref.entity, entities }
  }
  return { kind: 'unknown' }
}

// point_distance_x and point_distance_y are the same dimension transposed across
// the two axes; build the shared render and pick the per-axis fields by isX.
function pointDistanceAxisRender(
  dimKind: 'point_distance_x' | 'point_distance_y',
  resolved: ResolvedConstraint,
  sketch: Sketch,
): ConstraintRender {
  const eid = resolved.a?.entity
  const eid2 = resolved.b?.entity
  if (!eid || !eid2 || !resolved.a || !resolved.b) return { kind: 'unknown' }
  const pa = geomPoint(sketch, resolved.a)
  const pb = geomPoint(sketch, resolved.b)
  if (!pa || !pb) return { kind: 'unknown' }
  const isX = dimKind === 'point_distance_x'
  const mid = isX ? (pa[1] + pb[1]) / 2 : (pa[0] + pb[0]) / 2
  return {
    kind: 'dim_linear',
    dimKind,
    p1: isX ? [pa[0], mid] : [mid, pa[1]],
    p2: isX ? [pb[0], mid] : [mid, pb[1]],
    value: resolved.value || 0,
    normal: isX ? [0, 1] : [1, 0],
    entity: eid,
    ext1_line: isX ? [pa[0] - 100, pa[1], pa[0] + 100, pa[1]] : [pa[0], pa[1] - 100, pa[0], pa[1] + 100],
    ext2_line: isX ? [pb[0] - 100, pb[1], pb[0] + 100, pb[1]] : [pb[0], pb[1] - 100, pb[0], pb[1] + 100],
    ...(resolved.pos && { pos: resolved.pos }),
  }
}

function computeConstraintRenderCore(constraint: PartConstraint, sketch: Sketch): ConstraintRender {
  // Normalize refs: convert query strings to {entity, point?} objects.
  const knownIds = new Set(Object.keys(sketch))
  const normalize = (q: string | undefined): ResolvedRef => typeof q === 'string' ? resolveQueryRef(q, knownIds) : q
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

  // horizontal/vertical share the same anchoring; only the glyph differs.
  if (kind === 'horizontal' || kind === 'vertical') {
    const sym = kind === 'horizontal' ? 'symbol_h' : 'symbol_v'
    if (resolved.a && resolved.b) {
      const pa = geomPoint(sketch, resolved.a)
      const pb = geomPoint(sketch, resolved.b)
      if (!pa || !pb) return { kind: 'unknown' }
      const at: Point = [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2]
      return { kind: sym, at, entity: resolved.a.entity, entities: [resolved.a.entity, resolved.b.entity] }
    }
    const eid = resolved.target?.entity
    if (!eid) return { kind: 'unknown' }
    const e = sketch[eid] as LineSegment | Arc
    if (!e || !('start' in e) || !('end' in e)) return { kind: 'unknown' }
    const at: Point = [(e.start[0] + e.end[0]) / 2, (e.start[1] + e.end[1]) / 2]
    return { kind: sym, at, entity: eid }
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
    // Anchor at whichever operand resolves to a sketch point. A coincident pinning
    // a local point to the document origin (or any builtin/cross-sketch ref) leaves
    // one slot unresolvable in this sketch; the other operand still gives a valid
    // glyph position, so it renders as a coincident rather than the generic unknown
    // tile. See bugreports/strange_residual_constraint_20260622_200230.md.
    const entities = [resolved.a?.entity, resolved.b?.entity, resolved.target?.entity].filter(Boolean) as string[]
    for (const ref of [resolved.a, resolved.b, resolved.target]) {
      if (!ref) continue
      const pt = geomPoint(sketch, ref)
      if (pt) return { kind: 'symbol_coincident', at: pt, entity: ref.entity, entities }
    }
    return { kind: 'unknown' }
  }

  if (kind === 'normal') {
    const eid = resolved.a?.entity
    const eid2 = resolved.b?.entity
    if (!eid) return { kind: 'unknown' }
    const ea = sketch[eid] as Arc | LineSegment
    const eb = eid2 ? sketch[eid2] as Arc | LineSegment : undefined
    const entities = [eid, eid2].filter(Boolean) as string[]
    // geomPoint resolves the anchor for both arcs and circles: it returns an
    // arc's start/end (honoring the resolved center key) and a circle's center.
    // The old Arc cast read `.start` off a circle, which is undefined and dropped
    // the glyph into the AABB-corner fallback.
    if (eb && resolved.b && 'center' in eb) {
      const pt = geomPoint(sketch, resolved.b)
      if (pt) return { kind: 'symbol_normal', at: pt, entity: eid2!, entities }
    }
    if (ea && resolved.a && 'center' in ea) {
      const pt = geomPoint(sketch, resolved.a)
      if (pt) return { kind: 'symbol_normal', at: pt, entity: eid, entities }
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
    const na = Math.hypot(dax, day)
    if (segmentsAreParallel(ea.start, ea.end, eb.start, eb.end)) {
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
    if (!eid || !eid2 || !resolved.a) return { kind: 'unknown' }
    const ea = sketch[eid] as LineSegment | Arc | Circle
    if (!ea) return { kind: 'unknown' }
    // Lines anchor the glyph at the segment midpoint; circles/arcs (equal-radius)
    // anchor at their representative point (center) via geomPoint.
    const at: Point | null = 'start' in ea && 'end' in ea
      ? [(ea.start[0] + ea.end[0]) / 2, (ea.start[1] + ea.end[1]) / 2]
      : geomPoint(sketch, resolved.a)
    if (!at) return { kind: 'unknown' }
    return {
      kind: 'symbol_equal',
      at,
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

  if (kind === 'point_distance_x' || kind === 'point_distance_y') {
    return pointDistanceAxisRender(kind, resolved, sketch)
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
    // Extension-line evaluation segments so LinearDimension can decide
    // whether to draw each extension line and where it touches the entity.
    const ext1Line: [number, number, number, number] = [ea.start[0], ea.start[1], ea.end[0], ea.end[1]]
    let ext2Line: [number, number, number, number] | undefined
    const ebEid = resolved.b.entity
    if (ebEid) {
      const eb = sketch[ebEid] as LineSegment | Arc | undefined
      if (eb && 'start' in eb && 'end' in eb) {
        ext2Line = [eb.start[0], eb.start[1], eb.end[0], eb.end[1]]
      }
    }
    return {
      kind: 'dim_linear',
      dimKind: 'line_distance',
      p1: foot,
      p2: pb,
      value: resolved.value || 0,
      normal,
      entity: eid,
      ext1_line: ext1Line,
      ...(ext2Line && { ext2_line: ext2Line }),
      ...(resolved.pos && { pos: resolved.pos }),
    }
  }

  if (kind === 'radius_difference') {
    const eid = resolved.a?.entity
    const eid2 = resolved.b?.entity
    if (!eid || !eid2) return { kind: 'unknown' }
    const ea = sketch[eid] as Circle | Arc
    const eb = sketch[eid2] as Circle | Arc
    if (!ea || !eb || !('radius' in ea) || !('radius' in eb) || !('center' in ea)) return { kind: 'unknown' }
    // Draw the radial gap along a fixed direction (+x) so p1/p2 sit on the inner
    // and outer circle; the dim length then equals |rA - rB|. The label is moved
    // by `pos`; `normal` is perpendicular to the measurement so dragging slides
    // the dimension line sideways (matching the other linear dims).
    const [cx, cy] = ea.center
    const rInner = Math.min(ea.radius, eb.radius)
    const rOuter = Math.max(ea.radius, eb.radius)
    return {
      kind: 'dim_linear',
      p1: [cx + rInner, cy],
      p2: [cx + rOuter, cy],
      value: resolved.value ?? Math.abs(ea.radius - eb.radius),
      normal: [0, 1],
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

  if (kind === 'ngon') {
    // Sugar regularity constraint over N member lines: anchor the tile at the
    // polygon centroid (mean of the member vertices) so the user sees it exists
    // even though it is expanded away before the solver runs.
    const refs = constraint.refs ?? []
    const pts: Point[] = []
    const entities: string[] = []
    for (const q of refs) {
      const r = resolveQueryRef(q, knownIds)
      if (!r) continue
      entities.push(r.entity)
      const p = geomPoint(sketch, r)
      if (p) pts.push(p)
    }
    if (pts.length === 0) return { kind: 'unknown' }
    const at: Point = [
      pts.reduce((s, p) => s + p[0], 0) / pts.length,
      pts.reduce((s, p) => s + p[1], 0) / pts.length,
    ]
    return { kind: 'symbol_ngon', at, entity: entities[0], entities }
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
