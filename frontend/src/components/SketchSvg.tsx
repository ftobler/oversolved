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

type Entity = LineSegment | Circle | Arc

export interface Sketch {
  [entityId: string]: Entity
}

interface Props {
  initial: Sketch
  solved: Sketch
  size?: number
}

const PADDING = 20

function allPoints(sketches: Sketch[]): Point[] {
  const pts: Point[] = []
  for (const sketch of sketches) {
    for (const entity of Object.values(sketch)) {
      if ('start' in entity && 'end' in entity && 'radius' in entity) {
        // arc
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
      const largeArc = Math.abs(arc.angle_end - arc.angle_start) > 180 ? 1 : 0
      const [sx, sy] = px(arc.start[0], arc.start[1])
      const [ex, ey] = px(arc.end[0], arc.end[1])
      return (
        <g key={id}>
          <path d={`M ${x0} ${y0} A ${r} ${r} 0 ${largeArc} 0 ${x1} ${y1}`} stroke={color} strokeWidth={strokeWidth} fill="none" />
          <circle cx={sx} cy={sy} r={strokeWidth * 1.5} fill={color} />
          <circle cx={ex} cy={ey} r={strokeWidth * 1.5} fill={color} />
          <circle cx={cx} cy={cy} r={strokeWidth} fill={color} opacity={0.5} />
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

export default function SketchSvg({ initial, solved, size = 300 }: Props) {
  const { scale, tx, ty } = fitTransform([initial, solved], size)

  function px(x: number, y: number): [number, number] {
    return [x * scale + tx, size - (y * scale + ty)]
  }

  return (
    <svg width={size} height={size} style={{ background: '#111', borderRadius: 4 }}>
      {renderSketch(initial, px, scale, '#66bb6a', 1)}
      {renderSketch(solved, px, scale, '#4fc3f7', 2)}
    </svg>
  )
}
