export {
  COLOR_BODY_DEFAULT,
  PART_COLOR_PALETTE,
  COLOR_BODY_EDGE,
  COLOR_BODY_HOVER,
  COLOR_BODY_SELECTED,
  COLOR_BODY_EDGE_SEL,
  COLOR_SOLVED,
  COLOR_FULLY_CONSTRAINED,
  COLOR_ERROR,
  COLOR_INACTIVE,
  COLOR_HOVER,
  COLOR_SELECTED,
  HOVER_BLEND,
  blendWhite,
  COLOR_CONSTRAINT_HOVER,
  COLOR_PREVIEW,
  COLOR_PREVIEW_EDGE,
  COLOR_PROJECTED,
  COLOR_SNAP,
  RENDER_ORDER_DEFAULT,
  RENDER_ORDER_EDITING,
  RENDER_ORDER_HIGHLIGHT,
} from '../../utils/partColors'

// Drag snap — vertex pull zone must be larger than entity body pull zone so that
// dragging near an endpoint always snaps to the vertex, not the entity body.
// Mirrors POINT_HIT_PIXELS vs HIT_PIXELS in the hover/click system.
export const DRAG_SNAP_VERTEX_RADIUS_PX = 20   // point-to-point coincident snap radius
export const DRAG_SNAP_ENTITY_RADIUS_PX = 8    // point-on-entity coincident snap radius

// Hit detection & collision geometry
export const HIT_PIXELS = 8
export const POINT_HIT_PIXELS = 20
export const POINT_VIS_PIXELS = 4

// Click-vs-drag disambiguation: pointer moves smaller than this (in screen pixels)
// are treated as pure clicks and do not emit geometry mutations.
export const CLICK_THRESHOLD_PX = 4

// Visualization
export const ARC_SEGMENTS = 64
export const VERTEX_RADIUS = 0.04

// Debug and z-offset (re-exported from Sketch3D constants)
export const POINT_HIT_PIXELS_Z_OFFSET = 10
export const DEBUG_HIT = false
