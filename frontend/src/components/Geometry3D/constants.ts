// 3D body colors
export const COLOR_BODY_DEFAULT  = '#6ab59b'
export const PART_COLOR_PALETTE = ['#6AB59B', '#A8D5FF', '#B8E8C8', '#FFD6A5', '#F7C6C7', '#D4C7FF', '#FEE6A8', '#CDE7F0', '#F6C7A8']
export const COLOR_BODY_EDGE     = '#d3ede4'
export const COLOR_BODY_HOVER    = '#91ccb7'
export const COLOR_BODY_SELECTED = '#b5a16a'
export const COLOR_BODY_EDGE_SEL = '#ffffff'

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
