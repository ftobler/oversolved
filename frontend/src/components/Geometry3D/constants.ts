import {
  RENDER_ORDER_DEFAULT,
  RENDER_ORDER_EDITING,
  RENDER_ORDER_HIGHLIGHT,
} from '@/utils/core/partColors'

export {
  COLOR_BODY_DEFAULT,
  PART_COLOR_PALETTE,
  COLOR_BODY_EDGE,
  COLOR_BODY_SELECTED,
  COLOR_BODY_EDGE_SEL,
  DEFAULT_PART_ROUGHNESS,
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
  EDGE_HIGHLIGHT_LINE_WIDTH,
} from '@/utils/core/partColors'

// ─── sketch entity render layering ───
// Single source of truth for the z-ordering (Three.js renderOrder) and depth
// behaviour of a sketch entity, given its interaction state. There are exactly
// three layers, and the result is ALWAYS explicit — never undefined.
//
// Why explicit matters: a drei <Line> keeps one persistent LineMaterial/Line2
// for its lifetime. Passing `undefined` for depthTest/renderOrder does not
// restore the default, it leaves whatever was last applied. Expressing "normal"
// as undefined therefore makes the state sticky (a line that went on-top while
// selected stayed on-top after deselect). Returning concrete values means every
// transition, in any direction, fully resets the layer.
//
//   hovered            -> top of everything (above other editing lines too)
//   selected | editing -> above the B-rep, at the edit layer
//   visible only       -> depth-tested at its plane (clipped by solids in front)
export interface EntityLayerState {
  isEditing?: boolean
  selected?: boolean
  hovered?: boolean
}

export function entityRenderLayer(
  { isEditing = false, selected = false, hovered = false }: EntityLayerState,
): { depthTest: boolean; renderOrder: number } {
  if (hovered) return { depthTest: false, renderOrder: RENDER_ORDER_HIGHLIGHT }
  if (selected || isEditing) return { depthTest: false, renderOrder: RENDER_ORDER_EDITING }
  return { depthTest: true, renderOrder: RENDER_ORDER_DEFAULT }
}

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

// Tiny z-offset used to lift dimension labels, constraint icons, and entity
// markers above the sketch plane (z=0) so they render on top without z-fighting.
export const LABEL_Z_OFFSET = 0.001
