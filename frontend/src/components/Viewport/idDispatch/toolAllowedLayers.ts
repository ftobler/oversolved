import type { ActiveTool } from '@/types/cad'
import {
  FACE_LAYER_NAME, EDGE_LAYER_NAME, VERTEX_LAYER_NAME,
  PLANE_LAYER_NAME, SKETCH_ENTITY_LAYER_NAME, SKETCH_VERTEX_LAYER_NAME,
  ORIGIN_LAYER_NAME,
} from '@/picking'

/**
 * Per-tool allow-list of ID layers the pointer dispatcher will route from.
 *
 * `null` means "all layers" (no filter). Drawing tools return a subset
 * that permits B-rep / plane / sketch / origin picks but excludes
 * dimensionLabel so dimension labels don't intercept drawing strokes.
 */
export function getToolAllowedLayers(tool: ActiveTool): ReadonlySet<string> | null {
  switch (tool) {
    case null:
    case 'select':
    case 'dimension':
    case 'drag':
      return null
    case 'line':
    case 'rect':
    case 'center_rect':
    case 'circle':
    case 'arc':
    case 'point':
    case 'project':
    case 'mirror':
      return new Set([
        FACE_LAYER_NAME, EDGE_LAYER_NAME, VERTEX_LAYER_NAME,
        PLANE_LAYER_NAME, SKETCH_ENTITY_LAYER_NAME, SKETCH_VERTEX_LAYER_NAME,
        ORIGIN_LAYER_NAME,
      ])
    default:
      return null
  }
}
