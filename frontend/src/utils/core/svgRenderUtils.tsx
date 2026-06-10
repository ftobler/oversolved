import type { Sketch, Point, Arc, LineSegment, PointEntity, Circle, Ellipse, Spline, Topology, TopologyEdge, TopologyArcEdge, TopologyEllipseEdge, Constraints, Constraint, DimLinearRender, DimRadiusRender, DimAngleRender, Entity } from '@/types/cad'
import { COLOR_CONSTRAINT } from '@/components/sketch/sketch_helpers'
const ICON_SIZE = 14

export function arrowhead(x1: number, y1: number, x2: number, y2: number, size = 6): string {
  const dx = x2 - x1
  const dy = y2 - y1
  const len = Math.sqrt(dx * dx + dy * dy) || 1
  const ux = dx / len
  const uy = dy / len
  const px = -uy * size * 0.4
  const py = ux * size * 0.4
  const bx = x2 - ux * size
  const by = y2 - uy * size
  return `M ${x2} ${y2} L ${bx + px} ${by + py} L ${bx - px} ${by - py} Z`
}

export function getEntityBounds(entity: Entity, px: (x: number, y: number) => [number, number]): { minX: number; maxX: number; minY: number; maxY: number } | null {
  const pts: Point[] = []
  if ('start' in entity && 'end' in entity && 'radius' in entity) {
    const arc = entity as Arc
    pts.push(arc.start, arc.end, [arc.center[0] - arc.radius, arc.center[1]], [arc.center[0] + arc.radius, arc.center[1]], [arc.center[0], arc.center[1] - arc.radius], [arc.center[0], arc.center[1] + arc.radius])
  } else if ('start' in entity) {
    const line = entity as LineSegment
    pts.push(line.start, line.end)
  } else if ('center' in entity && 'a' in entity) {
    const el = entity as unknown as Ellipse
    const th = el.theta * (Math.PI / 180)
    const hw = Math.hypot(el.a * Math.cos(th), el.b * Math.sin(th))
    const hh = Math.hypot(el.a * Math.sin(th), el.b * Math.cos(th))
    pts.push([el.center[0] - hw, el.center[1]], [el.center[0] + hw, el.center[1]], [el.center[0], el.center[1] - hh], [el.center[0], el.center[1] + hh])
  } else if ('center' in entity) {
    const circ = entity as Circle
    const { center, radius } = circ
    pts.push([center[0] - radius, center[1]], [center[0] + radius, center[1]], [center[0], center[1] - radius], [center[0], center[1] + radius])
  } else if ('p1' in entity) {
    const sp = entity as Spline
    pts.push(sp.p1, sp.p2, sp.p3, sp.p4)
  } else if ('x' in entity) {
    const pt = entity as PointEntity
    pts.push([pt.x, pt.y])
  }
  if (pts.length === 0) return null
  const pxPts = pts.map(p => px(p[0], p[1]))
  return {
    minX: Math.min(...pxPts.map(p => p[0])),
    maxX: Math.max(...pxPts.map(p => p[0])),
    minY: Math.min(...pxPts.map(p => p[1])),
    maxY: Math.max(...pxPts.map(p => p[1])),
  }
}

export function renderSketch(
  sketch: Sketch,
  px: (x: number, y: number) => [number, number],
  pxScale: number,
  colorOf: (id: string) => string,
  strokeWidth: number,
) {
  return Object.entries(sketch).map(([id, entity]) => {
    const color = colorOf(id)
    if ('start' in entity && 'end' in entity && 'radius' in entity) {
      const arc = entity as Arc
      const [cx, cy] = px(arc.center[0], arc.center[1])
      const r = arc.radius * pxScale
      const a0 = -arc.angle_start * (Math.PI / 180)
      const a1 = -arc.angle_end * (Math.PI / 180)
      const x0 = cx + r * Math.cos(a0)
      const y0 = cy + r * Math.sin(a0)
      const x1 = cx + r * Math.cos(a1)
      const y1 = cy + r * Math.sin(a1)
      const span = ((arc.angle_end - arc.angle_start) + 360) % 360
      const largeArc = span > 180 ? 1 : 0
      const [sx, sy] = px(arc.start[0], arc.start[1])
      const [ex, ey] = px(arc.end[0], arc.end[1])
      const dashArray = arc.construction ? '4 2' : undefined
      return (
        <g key={id}>
          <path d={`M ${x0} ${y0} A ${r} ${r} 0 ${largeArc} 0 ${x1} ${y1}`} stroke={color} strokeWidth={strokeWidth} fill="none" strokeDasharray={dashArray} />
          <line x1={cx} y1={cy} x2={x0} y2={y0} stroke={color} strokeWidth={strokeWidth * 0.5} strokeDasharray={`${strokeWidth * 2} ${strokeWidth * 2}`} opacity={0.5} />
          <line x1={cx} y1={cy} x2={x1} y2={y1} stroke={color} strokeWidth={strokeWidth * 0.5} strokeDasharray={`${strokeWidth * 2} ${strokeWidth * 2}`} opacity={0.5} />
          <circle cx={sx} cy={sy} r={strokeWidth * 1.5} fill={color} strokeDasharray={dashArray} />
          <circle cx={ex} cy={ey} r={strokeWidth * 1.5} fill={color} strokeDasharray={dashArray} />
          <circle cx={cx} cy={cy} r={strokeWidth * 2} fill={color} opacity={0.7} />
        </g>
      )
    } else if ('start' in entity) {
      const line = entity as LineSegment
      const [x1, y1] = px(line.start[0], line.start[1])
      const [x2, y2] = px(line.end[0], line.end[1])
      const dashArray = line.construction ? '4 2' : undefined
      return (
        <g key={id}>
          <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={color} strokeWidth={strokeWidth} strokeDasharray={dashArray} />
          <circle cx={x1} cy={y1} r={strokeWidth * 1.5} fill={color} strokeDasharray={dashArray} />
          <circle cx={x2} cy={y2} r={strokeWidth * 1.5} fill={color} strokeDasharray={dashArray} />
        </g>
      )
    } else if ('x' in entity) {
      const pt = entity as PointEntity
      const [px_, py_] = px(pt.x, pt.y)
      const dashArray = pt.construction ? '4 2' : undefined
      return (
        <g key={id}>
          <circle cx={px_} cy={py_} r={strokeWidth * 2.0} fill={color} strokeDasharray={dashArray} />
          <line x1={px_ - strokeWidth * 4} y1={py_} x2={px_ + strokeWidth * 4} y2={py_} stroke={color} strokeWidth={strokeWidth * 0.75} strokeDasharray={dashArray} />
          <line x1={px_} y1={py_ - strokeWidth * 4} x2={px_} y2={py_ + strokeWidth * 4} stroke={color} strokeWidth={strokeWidth * 0.75} strokeDasharray={dashArray} />
        </g>
      )
    } else if ('center' in entity && 'a' in entity) {
      const el = entity as unknown as Ellipse
      const [cx, cy] = px(el.center[0], el.center[1])
      const rx = el.a * pxScale
      const ry = el.b * pxScale
      // px() flips the y axis, so a sketch CCW rotation renders as a CW screen
      // rotation -- negate theta for the SVG transform.
      const dashArray = el.construction ? '4 2' : undefined
      return (
        <g key={id}>
          <ellipse cx={cx} cy={cy} rx={rx} ry={ry} transform={`rotate(${-el.theta} ${cx} ${cy})`} stroke={color} strokeWidth={strokeWidth} fill="none" strokeDasharray={dashArray} />
          <circle cx={cx} cy={cy} r={strokeWidth} fill={color} opacity={0.5} />
        </g>
      )
    } else if ('p1' in entity) {
      const sp = entity as Spline
      const [x1, y1] = px(sp.p1[0], sp.p1[1])
      const [x2, y2] = px(sp.p2[0], sp.p2[1])
      const [x3, y3] = px(sp.p3[0], sp.p3[1])
      const [x4, y4] = px(sp.p4[0], sp.p4[1])
      const dashArray = sp.construction ? '4 2' : undefined
      return (
        <g key={id}>
          <path d={`M ${x1} ${y1} C ${x2} ${y2} ${x3} ${y3} ${x4} ${y4}`} stroke={color} strokeWidth={strokeWidth} fill="none" strokeDasharray={dashArray} />
          <circle cx={x1} cy={y1} r={strokeWidth * 1.5} fill={color} strokeDasharray={dashArray} />
          <circle cx={x4} cy={y4} r={strokeWidth * 1.5} fill={color} strokeDasharray={dashArray} />
        </g>
      )
    } else {
      const circ = entity as Circle
      const [cx, cy] = px(circ.center[0], circ.center[1])
      const r = circ.radius * pxScale
      const dashArray = circ.construction ? '4 2' : undefined
      return (
        <g key={id}>
          <circle cx={cx} cy={cy} r={r} stroke={color} strokeWidth={strokeWidth} fill="none" strokeDasharray={dashArray} />
          <circle cx={cx} cy={cy} r={strokeWidth} fill={color} opacity={0.5} />
        </g>
      )
    }
  })
}

const _LOOP_TOL = 1e-6

/** Append a full-ellipse self-contained closed sub-path (two half-ellipse arcs). */
function appendEllipseSubpath(
  parts: string[],
  edge: TopologyEllipseEdge,
  px: (x: number, y: number) => [number, number],
  pxScale: number,
): void {
  const [cx, cy] = edge.center
  const rot = (edge.theta ?? 0) * (Math.PI / 180)
  const ca = Math.cos(rot)
  const sa = Math.sin(rot)
  // The two major-axis extremes in sketch space, taken through px so the screen
  // flip is already applied; the SVG arc rotation then negates theta (px() flips
  // the y axis, matching the renderSketch ellipse arm).
  const [x0, y0] = px(cx + edge.a * ca, cy + edge.a * sa)
  const [x1, y1] = px(cx - edge.a * ca, cy - edge.a * sa)
  const rx = edge.a * pxScale
  const ry = edge.b * pxScale
  const rotDeg = -(edge.theta ?? 0)
  parts.push(`M ${x0} ${y0}`)
  parts.push(`A ${rx} ${ry} ${rotDeg} 0 1 ${x1} ${y1}`)
  parts.push(`A ${rx} ${ry} ${rotDeg} 0 1 ${x0} ${y0}`)
  parts.push('Z')
}

export function buildSurfacePath(
  surface: { boundary: TopologyEdge[] },
  px: (x: number, y: number) => [number, number],
  pxScale: number,
): string {
  const parts: string[] = []
  let prevEnd: [number, number] | null = null
  for (const edge of surface.boundary) {
    // A full ellipse carries no shared endpoints: it is its own closed sub-path.
    if (edge.kind === 'ellipse') {
      if (prevEnd !== null) parts.push('Z')
      appendEllipseSubpath(parts, edge, px, pxScale)
      prevEnd = null
      continue
    }
    const [sx, sy] = px(edge.start[0], edge.start[1])
    const [ex, ey] = px(edge.end[0], edge.end[1])
    const gapFromPrev = prevEnd === null
      || Math.hypot(sx - prevEnd[0], sy - prevEnd[1]) > _LOOP_TOL
    if (gapFromPrev) {
      if (prevEnd !== null) parts.push('Z')
      parts.push(`M ${sx} ${sy}`)
    }
    if (edge.kind === 'line') {
      parts.push(`L ${ex} ${ey}`)
    } else if (edge.kind === 'spline') {
      const [c1x, c1y] = px(edge.c1[0], edge.c1[1])
      const [c2x, c2y] = px(edge.c2[0], edge.c2[1])
      parts.push(`C ${c1x} ${c1y} ${c2x} ${c2y} ${ex} ${ey}`)
    } else {
      const ae = edge as TopologyArcEdge
      const r = ae.radius * pxScale
      const span = ae.ccw
        ? ((ae.angle_end_deg - ae.angle_start_deg) + 360) % 360
        : ((ae.angle_start_deg - ae.angle_end_deg) + 360) % 360
      const largeArc = span > 180 ? 1 : 0
      const sweep = ae.ccw ? 0 : 1
      parts.push(`A ${r} ${r} 0 ${largeArc} ${sweep} ${ex} ${ey}`)
    }
    prevEnd = [ex, ey]
  }
  if (prevEnd !== null) parts.push('Z')
  return parts.join(' ')
}

export function renderTopology(
  topology: Topology,
  px: (x: number, y: number) => [number, number],
  pxScale: number,
) {
  const elements: React.ReactNode[] = []
  topology.surfaces.forEach((surface, si) => {
    const d = buildSurfacePath(surface, px, pxScale)
    if (d) {
      elements.push(
        <path key={`topo-surface-${si}`} d={d} fill="white" fillOpacity={0.10} stroke="none" fillRule="evenodd" />,
      )
    }
  })
  Object.entries(topology.intersection_points).forEach(([vid, pt]) => {
    const [cx, cy] = px(pt.x, pt.y)
    elements.push(<circle key={`topo-ipt-${vid}`} cx={cx} cy={cy} r={4} fill="white" opacity={0.10} />)
  })
  return elements
}

export function renderConstraints(
  constraints: Constraints,
  sketch: Sketch,
  px: (x: number, y: number) => [number, number],
  pxScale: number,
  getIconUrl: (kind: string) => string | undefined,
) {
  const byEntity: Record<string, [string, Constraint][]> = {}
  for (const [id, c] of Object.entries(constraints)) {
    const eid = ('entity' in c.render ? c.render.entity : undefined) || 'default'
    if (!byEntity[eid]) byEntity[eid] = []
    byEntity[eid].push([id, c])
  }

  const symbolConstraints: React.ReactNode[] = []
  const dimConstraints: React.ReactNode[] = []

  for (const [eid, clist] of Object.entries(byEntity)) {
    const entity = sketch[eid]
    if (!entity) continue
    const bounds = getEntityBounds(entity, px)
    if (!bounds) continue

    const gridX = bounds.maxX + 16
    const gridY = bounds.maxY + 16
    const colCount = 3
    const iconPadding = 4

    let symbolIdx = 0
    clist.forEach(([id, c]) => {
      const r = c.render
      const color = COLOR_CONSTRAINT

      if (r.kind.startsWith('symbol_')) {
        const url = getIconUrl(r.kind)
        if (!url) return
        const row = Math.floor(symbolIdx / colCount)
        const col = symbolIdx % colCount
        symbolIdx++
        const x = gridX + col * (ICON_SIZE + iconPadding)
        const y = gridY + row * (ICON_SIZE + iconPadding)
        const bgColor = '#3e3e3e'
        const padding = 3
        symbolConstraints.push(
          <g key={id}>
            <rect x={x - ICON_SIZE / 2 - padding} y={y - ICON_SIZE / 2 - padding} width={ICON_SIZE + padding * 2} height={ICON_SIZE + padding * 2} fill={bgColor} rx={2} />
            <image href={url} x={x - ICON_SIZE / 2} y={y - ICON_SIZE / 2} width={ICON_SIZE} height={ICON_SIZE} style={{ filter: 'invert(1) sepia(1) saturate(5) hue-rotate(5deg)', opacity: 0.9 }} />
          </g>
        )
        return
      }

      if (r.kind === 'dim_linear') {
        const dim = r as DimLinearRender
        const [x1, y1] = px(dim.p1[0], dim.p1[1])
        const [x2, y2] = px(dim.p2[0], dim.p2[1])
        const nx = -dim.normal[0]
        const ny = dim.normal[1]
        const nlen = Math.sqrt(nx * nx + ny * ny) || 1
        const unx = nx / nlen
        const uny = ny / nlen
        const offset = 14 * pxScale / Math.max(pxScale, 1) + 10
        const d1x = x1 + unx * offset
        const d1y = y1 + uny * offset
        const d2x = x2 + unx * offset
        const d2y = y2 + uny * offset
        const mx = (d1x + d2x) / 2
        const my = (d1y + d2y) / 2
        const label = dim.value % 1 === 0 ? String(dim.value) : dim.value.toFixed(2)
        const textPadding = 3
        dimConstraints.push(
          <g key={id} opacity={0.85}>
            <line x1={x1} y1={y1} x2={d1x} y2={d1y} stroke={color} strokeWidth={1} strokeDasharray="2 2" />
            <line x1={x2} y1={y2} x2={d2x} y2={d2y} stroke={color} strokeWidth={1} strokeDasharray="2 2" />
            <line x1={d1x} y1={d1y} x2={d2x} y2={d2y} stroke={color} strokeWidth={1} />
            <path d={arrowhead(d2x, d2y, d1x, d1y)} fill={color} />
            <path d={arrowhead(d1x, d1y, d2x, d2y)} fill={color} />
            <rect x={mx - (label.length * 2.5 + textPadding)} y={my - 6} width={label.length * 5 + textPadding * 2} height={12} fill="#111" />
            <text x={mx} y={my} fill={color} fontSize={9} fontFamily="monospace" textAnchor="middle" dominantBaseline="middle">{label}</text>
          </g>
        )
      } else if (r.kind === 'dim_radius') {
        const dim = r as DimRadiusRender
        const [x1, y1] = px(dim.p1[0], dim.p1[1])
        const [x2, y2] = px(dim.p2[0], dim.p2[1])
        const angle = 10 * (Math.PI / 180)
        const cos10 = Math.cos(angle)
        const sin10 = Math.sin(angle)
        const dx = x2 - x1
        const dy = y2 - y1
        const rdx = dx * cos10 - dy * sin10
        const rdy = dx * sin10 + dy * cos10
        const x2_rot = x1 + rdx
        const y2_rot = y1 + rdy
        const mx = (x1 + x2_rot) / 2
        const my = (y1 + y2_rot) / 2
        const label = `R${dim.value % 1 === 0 ? dim.value : dim.value.toFixed(2)}`
        const textPadding = 3
        dimConstraints.push(
          <g key={id} opacity={0.85}>
            <line x1={x1} y1={y1} x2={x2_rot} y2={y2_rot} stroke={color} strokeWidth={1} />
            <path d={arrowhead(x1, y1, x2_rot, y2_rot)} fill={color} />
            <rect x={mx - (label.length * 2.5 + textPadding)} y={my - 6} width={label.length * 5 + textPadding * 2} height={12} fill="#111" />
            <text x={mx} y={my} fill={color} fontSize={9} fontFamily="monospace" textAnchor="middle" dominantBaseline="middle">{label}</text>
          </g>
        )
      } else if (r.kind === 'dim_angle') {
        const dim = r as DimAngleRender
        // p1,p2 = line A; direction da = p2-p1. p3,p4 = line B; direction db = p4-p3.
        const [ax1s, ay1s] = px(dim.p1[0], dim.p1[1])
        const [ax2s, ay2s] = px(dim.p2[0], dim.p2[1])
        const [bx1s, by1s] = px(dim.p3[0], dim.p3[1])
        const [bx2s, by2s] = px(dim.p4[0], dim.p4[1])
        const angle1 = Math.atan2(ay2s - ay1s, ax2s - ax1s)  // direction of da
        const angle2 = Math.atan2(by2s - by1s, bx2s - bx1s)  // direction of db
        // Find shared vertex
        const EPS = 1e-4
        let vx: number, vy: number
        if (Math.hypot(ax2s - bx1s, ay2s - by1s) < EPS) { vx = ax2s; vy = ay2s }
        else if (Math.hypot(ax2s - bx2s, ay2s - by2s) < EPS) { vx = ax2s; vy = ay2s }
        else if (Math.hypot(ax1s - bx1s, ay1s - by1s) < EPS) { vx = ax1s; vy = ay1s }
        else if (Math.hypot(ax1s - bx2s, ay1s - by2s) < EPS) { vx = ax1s; vy = ay1s }
        else { vx = ax2s; vy = ay2s }
        // Extension line endpoints (the non-vertex end of each line)
        const extAx = Math.abs(ax2s - vx) + Math.abs(ay2s - vy) > EPS ? ax2s : ax1s
        const extAy = Math.abs(ax2s - vx) + Math.abs(ay2s - vy) > EPS ? ay2s : ay1s
        const extBx = Math.abs(bx2s - vx) + Math.abs(by2s - vy) > EPS ? bx2s : bx1s
        const extBy = Math.abs(bx2s - vx) + Math.abs(by2s - vy) > EPS ? by2s : by1s
        const rA = Math.hypot(extAx - vx, extAy - vy)
        const rB = Math.hypot(extBx - vx, extBy - vy)
        const arcRadius = Math.min(rA, rB) * 0.4
        const ax1 = vx + arcRadius * Math.cos(angle1)
        const ay1 = vy + arcRadius * Math.sin(angle1)
        const ax2 = vx + arcRadius * Math.cos(angle2)
        const ay2 = vy + arcRadius * Math.sin(angle2)
        let spanRad = angle2 - angle1
        if (spanRad < -Math.PI) spanRad += 2 * Math.PI
        else if (spanRad > Math.PI) spanRad -= 2 * Math.PI
        const largeArc = Math.abs(spanRad) > Math.PI ? 1 : 0
        const midAngle = angle1 + spanRad / 2
        const labelRadius = arcRadius * 1.5
        const labelX = vx + labelRadius * Math.cos(midAngle)
        const labelY = vy + labelRadius * Math.sin(midAngle)
        const label = `${dim.value % 1 === 0 ? dim.value : dim.value.toFixed(1)}°`
        const arcPath = `M ${ax1} ${ay1} A ${arcRadius} ${arcRadius} 0 ${largeArc} 1 ${ax2} ${ay2}`
        const textPadding = 4
        const textWidth = (label.length * 3 + 4) + textPadding * 2
        dimConstraints.push(
          <g key={id} opacity={0.85}>
            <line x1={vx} y1={vy} x2={extAx} y2={extAy} stroke={color} strokeWidth={1} />
            <line x1={vx} y1={vy} x2={extBx} y2={extBy} stroke={color} strokeWidth={1} />
            <path d={arcPath} stroke={color} strokeWidth={1} fill="none" />
            <rect x={labelX - textWidth / 2} y={labelY - 7} width={textWidth} height={14} fill="#111" />
            <text x={labelX} y={labelY} fill={color} fontSize={9} fontFamily="monospace" textAnchor="middle" dominantBaseline="middle">{label}</text>
          </g>
        )
      }
    })
  }
  return [...symbolConstraints, ...dimConstraints]
}
