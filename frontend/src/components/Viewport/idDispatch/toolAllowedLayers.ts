import type { ActiveTool } from '@/types/cad'
import {
  FACE_LAYER_NAME, EDGE_LAYER_NAME, VERTEX_LAYER_NAME,
  PLANE_LAYER_NAME, SKETCH_ENTITY_LAYER_NAME, SKETCH_VERTEX_LAYER_NAME,
  ORIGIN_LAYER_NAME,
} from '@/picking'

// Sketch-plane pick layers shared by every sketch tool: the sketch's own
// geometry plus the plane and origin used for snapping. Body geometry the user
// can snap to during drawing arrives here too, projected into sketch-snap
// entities (see buildBodySnapSketch), so drawing tools never need the B-rep
// layers directly.
const SKETCH_PICK_LAYERS = [
  PLANE_LAYER_NAME, SKETCH_ENTITY_LAYER_NAME, SKETCH_VERTEX_LAYER_NAME, ORIGIN_LAYER_NAME,
] as const

// The 3D solid layers. Only the project tool resolves these while a sketch is
// being edited; bodies stay in the pick buffer (collision pass is always live)
// but lower-priority than sketch layers, so sketch items win where they overlap.
const BREP_PICK_LAYERS = [FACE_LAYER_NAME, EDGE_LAYER_NAME, VERTEX_LAYER_NAME] as const

/**
 * Per-tool allow-list of ID layers the pointer dispatcher will route from.
 *
 * `null` means "all layers" (no filter), used by select / drag / dimension so
 * they can pick anything including bodies. Drawing tools return a sketch-only
 * subset: it excludes dimensionLabel (so labels don't intercept strokes) and
 * the B-rep layers (so a body face under the cursor is never selected
 * mid-stroke). The project tool adds the B-rep layers back so the user can pick
 * 3D geometry to project onto the sketch plane.
 */
export function getToolAllowedLayers(tool: ActiveTool): ReadonlySet<string> | null {
  switch (tool) {
    case null:
    case 'select':
    case 'dimension':
    case 'drag':
      return null
    case 'project':
      return new Set([...BREP_PICK_LAYERS, ...SKETCH_PICK_LAYERS])
    case 'line':
    case 'rect':
    case 'center_rect':
    case 'circle':
    case 'arc':
    case 'ellipse':
    case 'point':
    case 'mirror':
      return new Set(SKETCH_PICK_LAYERS)
    default:
      return null
  }
}
