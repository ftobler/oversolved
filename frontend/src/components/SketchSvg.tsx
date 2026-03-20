type Point = [number, number]

interface LineSegment {
  start: Point
  end: Point
}

interface Circle {
  center: Point
  radius: number
}

interface Arc {
  center: Point
  radius: number
  angle_start: number
  angle_end: number
  start: Point
  end: Point
}

interface PointEntity {
  x: number
  y: number
}

type Entity = LineSegment | Circle | Arc | PointEntity

export interface Sketch {
  [entityId: string]: Entity
}

type Status = 'fully_constrained' | 'underconstrained' | 'overconstrained'

// Constraint render types (from solver output)
interface SymbolRender {
  kind: string // symbol_h, symbol_v, symbol_coincident, etc.
  at: Point
}

interface DimLinearRender {
  kind: 'dim_linear'
  p1: Point
  p2: Point
  normal: Point
  value: number
}

interface DimRadiusRender {
  kind: 'dim_radius'
  p1: Point
  p2: Point
  value: number
}

interface DimAngleRender {
  kind: 'dim_angle'
  p1: Point
  p2: Point
  value: number
  [key: string]: unknown
}

type ConstraintRender = SymbolRender | DimLinearRender | DimRadiusRender | DimAngleRender

export interface Constraint {
  render: ConstraintRender
  residual: number
}

export interface Constraints {
  [constraintId: string]: Constraint
}

interface Props {
  initial: Sketch
  solved: Sketch
  status?: Status
  size?: number
  constraints?: Constraints
}

const PADDING = 40
const CONSTRAINT_COLOR = '#ffd54f'
const ICON_SIZE = 14

// Import all constraint icons as URLs
const iconModules = import.meta.glob('../assets/icons/*.svg', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>

const SYMBOL_TO_ICON: Record<string, string> = {
  symbol_h:          'constraint-horizontal',
  symbol_v:          'constraint-vertical',
  symbol_coincident: 'constraint-coincident',
  symbol_concentric: 'constraint-concentric',
  symbol_equal:      'constraint-equal',
  symbol_fixed:      'constraint-fixed',
  symbol_midpoint:   'constraint-midpoint',
  symbol_normal:     'constraint-normal',
  symbol_perp:       'constraint-square',
  symbol_tangent:    'constraint-tangent',
  symbol_colinear:   'constraint-colinear',
  symbol_angle:      'constraint-angle',
}

function getIconUrl(kind: string): string | undefined {
  const name = SYMBOL_TO_ICON[kind]
  if (!name) return undefined
  return iconModules[`../assets/icons/${name}.svg`]
}

function allPoints(sketches: Sketch[]): Point[] {
  const pts: Point[] = []
  for (const sketch of sketches) {
    for (const entity of Object.values(sketch)) {
      if ('start' in entity && 'end' in entity && 'radius' in entity) {
        const arc = entity as Arc
        pts.push(arc.center, arc.start, arc.end)
      } else if ('start' in entity) {
        const line = entity as LineSegment
        pts.push(line.start, line.end)
      } else if ('center' in entity) {
        const circ = entity as Circle
        const { center, radius } = circ
        pts.push(
          [center[0] - radius, center[1]],
          [center[0] + radius, center[1]],
          [center[0], center[1] - radius],
          [center[0], center[1] + radius],
        )
      } else if ('x' in entity) {
        const pt = entity as PointEntity
        pts.push([pt.x, pt.y])
      }
    }
  }
  return pts
}

function fitTransform(sketches: Sketch[], size: number): { scale: number; tx: number; ty: number } {
  const points = allPoints(sketches)
  if (points.length === 0) return { scale: 1, tx: size / 2, ty: size / 2 }

  const xs = points.map(p => p[0])
  const ys = points.map(p => p[1])
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)

  const w = maxX - minX || 1
  const h = maxY - minY || 1
  const scale = (size - PADDING * 2) / Math.max(w, h)
  const tx = PADDING - minX * scale + ((size - PADDING * 2) - w * scale) / 2
  const ty = PADDING - minY * scale + ((size - PADDING * 2) - h * scale) / 2
  return { scale, tx, ty }
}

function renderSketch(
  sketch: Sketch,
  px: (x: number, y: number) => [number, number],
  pxScale: number,
  color: string,
  strokeWidth: number,
) {
  return Object.entries(sketch).map(([id, entity]) => {
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
      // Arcs are CCW in CAD (y-up). Negating angles for y-flip preserves visual orientation,
      // so CCW in CAD remains CCW on screen: sweep=0.
      // Span is computed CCW: (end - start + 360) % 360.
      const span = ((arc.angle_end - arc.angle_start) + 360) % 360
      const largeArc = span > 180 ? 1 : 0
      const [sx, sy] = px(arc.start[0], arc.start[1])
      const [ex, ey] = px(arc.end[0], arc.end[1])
      return (
        <g key={id}>
          <path d={`M ${x0} ${y0} A ${r} ${r} 0 ${largeArc} 0 ${x1} ${y1}`} stroke={color} strokeWidth={strokeWidth} fill="none" />
          {/* radius lines: center to start and center to end */}
          <line x1={cx} y1={cy} x2={x0} y2={y0} stroke={color} strokeWidth={strokeWidth * 0.5} strokeDasharray={`${strokeWidth * 2} ${strokeWidth * 2}`} opacity={0.5} />
          <line x1={cx} y1={cy} x2={x1} y2={y1} stroke={color} strokeWidth={strokeWidth * 0.5} strokeDasharray={`${strokeWidth * 2} ${strokeWidth * 2}`} opacity={0.5} />
          <circle cx={sx} cy={sy} r={strokeWidth * 1.5} fill={color} />
          <circle cx={ex} cy={ey} r={strokeWidth * 1.5} fill={color} />
          <circle cx={cx} cy={cy} r={strokeWidth * 2} fill={color} opacity={0.7} />
        </g>
      )
    } else if ('start' in entity) {
      const line = entity as LineSegment
      const [x1, y1] = px(line.start[0], line.start[1])
      const [x2, y2] = px(line.end[0], line.end[1])
      return (
        <g key={id}>
          <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={color} strokeWidth={strokeWidth} />
          <circle cx={x1} cy={y1} r={strokeWidth * 1.5} fill={color} />
          <circle cx={x2} cy={y2} r={strokeWidth * 1.5} fill={color} />
        </g>
      )
    } else if ('x' in entity) {
      const pt = entity as PointEntity
      const [px_, py_] = px(pt.x, pt.y)
      return (
        <g key={id}>
          <circle cx={px_} cy={py_} r={strokeWidth * 2.5} fill={color} />
          <line x1={px_ - strokeWidth * 4} y1={py_} x2={px_ + strokeWidth * 4} y2={py_} stroke={color} strokeWidth={strokeWidth * 0.75} />
          <line x1={px_} y1={py_ - strokeWidth * 4} x2={px_} y2={py_ + strokeWidth * 4} stroke={color} strokeWidth={strokeWidth * 0.75} />
        </g>
      )
    } else {
      const circ = entity as Circle
      const [cx, cy] = px(circ.center[0], circ.center[1])
      const r = circ.radius * pxScale
      return (
        <g key={id}>
          <circle cx={cx} cy={cy} r={r} stroke={color} strokeWidth={strokeWidth} fill="none" />
          <circle cx={cx} cy={cy} r={strokeWidth} fill={color} opacity={0.5} />
        </g>
      )
    }
  })
}

function arrowhead(x1: number, y1: number, x2: number, y2: number, size = 6): string {
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

function renderConstraints(
  constraints: Constraints,
  px: (x: number, y: number) => [number, number],
  pxScale: number,
) {
  return Object.entries(constraints).map(([id, c]) => {
    const r = c.render
    const color = CONSTRAINT_COLOR
    const sw = 1

    if (r.kind.startsWith('symbol_')) {
      const url = getIconUrl(r.kind)
      if (!url) return null
      const iconStyle = { filter: 'invert(1) sepia(1) saturate(5) hue-rotate(5deg)', opacity: 0.9 }
      const renderIcon = (pos: Point, suffix: string) => {
        const [sx, sy] = px(pos[0], pos[1])
        return (
          <image
            key={`${id}${suffix}`}
            href={url}
            x={sx - ICON_SIZE / 2}
            y={sy - ICON_SIZE / 2}
            width={ICON_SIZE}
            height={ICON_SIZE}
            style={iconStyle}
          />
        )
      }
      const sym = r as Record<string, unknown>
      if (sym.at_a && sym.at_b) {
        return <g key={id}>{renderIcon(sym.at_a as Point, '_a')}{renderIcon(sym.at_b as Point, '_b')}</g>
      }
      if (sym.at) return renderIcon(sym.at as Point, '')
      return null
    }

    if (r.kind === 'dim_linear') {
      const dim = r as DimLinearRender
      const [x1, y1] = px(dim.p1[0], dim.p1[1])
      const [x2, y2] = px(dim.p2[0], dim.p2[1])
      // normal in model space → SVG space (y flipped)
      const nx = dim.normal[0]
      const ny = -dim.normal[1]
      const nlen = Math.sqrt(nx * nx + ny * ny) || 1
      const unx = nx / nlen
      const uny = ny / nlen
      const offset = 14 * pxScale / Math.max(pxScale, 1) + 10
      // dimension line endpoints (offset from measured points along normal)
      const d1x = x1 + unx * offset
      const d1y = y1 + uny * offset
      const d2x = x2 + unx * offset
      const d2y = y2 + uny * offset
      const mx = (d1x + d2x) / 2
      const my = (d1y + d2y) / 2
      const label = dim.value % 1 === 0 ? String(dim.value) : dim.value.toFixed(2)
      return (
        <g key={id} opacity={0.85}>
          {/* extension lines */}
          <line x1={x1} y1={y1} x2={d1x} y2={d1y} stroke={color} strokeWidth={sw} strokeDasharray="2 2" />
          <line x1={x2} y1={y2} x2={d2x} y2={d2y} stroke={color} strokeWidth={sw} strokeDasharray="2 2" />
          {/* dimension line with arrows */}
          <line x1={d1x} y1={d1y} x2={d2x} y2={d2y} stroke={color} strokeWidth={sw} />
          <path d={arrowhead(d2x, d2y, d1x, d1y)} fill={color} />
          <path d={arrowhead(d1x, d1y, d2x, d2y)} fill={color} />
          {/* value label */}
          <text x={mx} y={my - 4} fill={color} fontSize={9} fontFamily="monospace" textAnchor="middle">{label}</text>
        </g>
      )
    }

    if (r.kind === 'dim_radius') {
      const dim = r as DimRadiusRender
      const [x1, y1] = px(dim.p1[0], dim.p1[1])
      const [x2, y2] = px(dim.p2[0], dim.p2[1])
      const mx = (x1 + x2) / 2
      const my = (y1 + y2) / 2
      const label = `R${dim.value % 1 === 0 ? dim.value : dim.value.toFixed(2)}`
      return (
        <g key={id} opacity={0.85}>
          <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={color} strokeWidth={sw} />
          <path d={arrowhead(x1, y1, x2, y2)} fill={color} />
          <text x={mx} y={my - 4} fill={color} fontSize={9} fontFamily="monospace" textAnchor="middle">{label}</text>
        </g>
      )
    }

    if (r.kind === 'dim_angle') {
      const dim = r as DimAngleRender
      const [x1, y1] = px(dim.p1[0], dim.p1[1])
      const [x2, y2] = px(dim.p2[0], dim.p2[1])
      const mx = (x1 + x2) / 2
      const my = (y1 + y2) / 2
      const label = `${dim.value % 1 === 0 ? dim.value : dim.value.toFixed(1)}°`
      return (
        <g key={id} opacity={0.85}>
          <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={color} strokeWidth={sw} strokeDasharray="3 2" />
          <text x={mx} y={my - 4} fill={color} fontSize={9} fontFamily="monospace" textAnchor="middle">{label}</text>
        </g>
      )
    }

    return null
  })
}

const STATUS_COLOR: Record<Status, string> = {
  fully_constrained: '#ffffff',
  underconstrained: '#4fc3f7',
  overconstrained: '#ef5350',
}

export default function SketchSvg({ initial, solved, status, size = 300, constraints }: Props) {
  const { scale, tx, ty } = fitTransform([initial, solved], size)

  function px(x: number, y: number): [number, number] {
    return [x * scale + tx, size - (y * scale + ty)]
  }

  return (
    <svg width={size} height={size} style={{ background: '#111', borderRadius: 4 }}>
      {renderSketch(initial, px, scale, '#66bb6a', 1)}
      {renderSketch(solved, px, scale, status ? STATUS_COLOR[status] : '#4fc3f7', 2)}
      {constraints && renderConstraints(constraints, px, scale)}
    </svg>
  )
}
