import type { Sketch, Constraints, Topology, EntityStatus } from '../types/cad'
import { renderSketch, renderTopology, renderConstraints } from '../utils/svgRenderUtils'

interface Props {
  initial: Sketch
  solved: Sketch
  status?: string
  entityStatus?: EntityStatus
  size?: number
  constraints?: Constraints
  topology?: Topology
}

const PADDING = 40

const iconModules = import.meta.glob('../assets/icons/*.svg', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>

import constraintParallelUrl from '../assets/icons/constraint-parallel.svg?url'

const SYMBOL_TO_ICON: Record<string, string> = {
  symbol_h:          'constraint-horizontal',
  symbol_v:          'constraint-vertical',
  symbol_coincident: 'constraint-coincident',
  symbol_concentric: 'constraint-concentric',
  symbol_equal:      'constraint-equal',
  symbol_fixed:      'constraint-fixed',
  symbol_midpoint:   'constraint-midpoint',
  symbol_normal:     'constraint-square',
  symbol_parallel:   'constraint-parallel',
  symbol_tangent:    'constraint-tangent',
  symbol_colinear:   'constraint-colinear',
  symbol_angle:      'constraint-angle',
}

function getIconUrl(kind: string): string | undefined {
  if (kind === 'symbol_parallel') return constraintParallelUrl
  const name = SYMBOL_TO_ICON[kind]
  if (!name) return undefined
  return iconModules[`../assets/icons/${name}.svg`]
}

function allPoints(sketches: Sketch[], topology?: Topology): [number, number][] {
  const pts: [number, number][] = []
  for (const sketch of sketches) {
    for (const entity of Object.values(sketch)) {
      if ('start' in entity && 'end' in entity && 'radius' in entity) {
        pts.push(entity.center, entity.start, entity.end)
      } else if ('start' in entity) {
        pts.push(entity.start, entity.end)
      } else if ('center' in entity) {
        const { center, radius } = entity
        pts.push([center[0] - radius, center[1]], [center[0] + radius, center[1]], [center[0], center[1] - radius], [center[0], center[1] + radius])
      } else if ('x' in entity) {
        pts.push([entity.x, entity.y])
      }
    }
  }
  if (topology) {
    for (const v of Object.values(topology.vertices)) {
      pts.push([v.x, v.y])
    }
  }
  return pts
}

function fitTransform(sketches: Sketch[], size: number, topology?: Topology): { scale: number; tx: number; ty: number } {
  const points = allPoints(sketches, topology)
  if (points.length === 0) return { scale: 1, tx: size / 2, ty: size / 2 }
  const xs = points.map(p => p[0]), ys = points.map(p => p[1])
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys)
  const w = maxX - minX || 1, h = maxY - minY || 1
  const scale = (size - PADDING * 2) / Math.max(w, h)
  const tx = PADDING - minX * scale + ((size - PADDING * 2) - w * scale) / 2
  const ty = PADDING - minY * scale + ((size - PADDING * 2) - h * scale) / 2
  return { scale, tx, ty }
}

const STATUS_COLOR: Record<string, string> = {
  fully_constrained: '#ffffff',
  underconstrained: '#4fc3f7',
  overconstrained: '#ef5350',
}

export default function SketchSvg({ initial, solved, status, entityStatus, size = 300, constraints, topology }: Props) {
  const { scale, tx, ty } = fitTransform([initial, solved], size, topology)
  const px = (x: number, y: number): [number, number] => [x * scale + tx, size - (y * scale + ty)]
  const fallbackColor = status ? STATUS_COLOR[status] : STATUS_COLOR.underconstrained
  const solvedColorOf = (id: string): string => (entityStatus && entityStatus[id] ? STATUS_COLOR[entityStatus[id]] : fallbackColor)

  return (
    <svg width={size} height={size} style={{ background: '#111', borderRadius: 4 }}>
      {renderSketch(initial, px, scale, () => '#66bb6a', 1)}
      {renderSketch(solved, px, scale, solvedColorOf, 2)}
      {topology && renderTopology(topology, px, scale)}
      {constraints && renderConstraints(constraints, solved, px, scale, getIconUrl)}
    </svg>
  )
}
