// Geometry3D color palette
export const COLOR_SOLVED = '#0288d1'  // darker blue for underconstrained
export const COLOR_FULLY_CONSTRAINED = '#ffffff'  // white for fully constrained
export const COLOR_ERROR = '#ef5350'
export const COLOR_INACTIVE = '#3a4048'
export const COLOR_HOVER = '#ffffff'
export const COLOR_SELECTED = '#ff9800'
export const COLOR_CONSTRAINT_HOVER = '#fff176'  // entity highlighted because a constraint on it is hovered
export const COLOR_PREVIEW = '#aaaaaa'
export const COLOR_PROJECTED = '#ffca28'  // amber — projected/reference geometry
export const COLOR_SNAP = '#aaaaaa'  // snap indicator during drag (same hue as preview by default)

// Drag snap — vertex pull zone must be larger than entity body pull zone so that
// dragging near an endpoint always snaps to the vertex, not the entity body.
// Mirrors POINT_HIT_PIXELS vs HIT_PIXELS in the hover/click system.
export const DRAG_SNAP_VERTEX_RADIUS_PX = 20   // point-to-point coincident snap radius
export const DRAG_SNAP_ENTITY_RADIUS_PX = 8    // point-on-entity coincident snap radius

// Hit detection & collision geometry
export const HIT_PIXELS = 8
export const POINT_HIT_PIXELS = 20
export const POINT_HIT_PIXELS_Z_OFFSET = 10

// Visualization
export const ARC_SEGMENTS = 64
export const DEBUG_HIT = false  // Set to true to visualize hit geometry (orange cylinders, blue spheres)
