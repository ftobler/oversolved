import {
  RENDER_ORDER_DEFAULT,
  RENDER_ORDER_EDITING,
  RENDER_ORDER_HIGHLIGHT,
  COLOR_BODY_DEFAULT,
  COLOR_BODY_SELECTED,
  COLOR_BODY_EDGE,
  COLOR_BODY_EDGE_SEL,
  COLOR_BODY_REMOVED,
  DEFAULT_PART_ROUGHNESS,
  COLOR_ERROR,
  COLOR_SOLVED,
  COLOR_FULLY_CONSTRAINED,
  COLOR_INACTIVE,
  COLOR_HOVER,
  COLOR_SELECTED,
  COLOR_CONSTRAINT_HOVER,
  COLOR_PREVIEW,
  COLOR_PROJECTED,
  COLOR_SNAP,
} from '@/utils/core/partColors'

export {
  COLOR_BODY_DEFAULT,
  PART_COLOR_PALETTE,
  COLOR_BODY_EDGE,
  COLOR_BODY_SELECTED,
  COLOR_BODY_EDGE_SEL,
  COLOR_BODY_REMOVED,
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
// three layers, and the result is ALWAYS explicit, never undefined.
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

// ─── body surface look ───
// The one place that decides how a solid body is drawn. Three inputs can each
// claim the surface, so the precedence has to be stated somewhere rather than
// fall out of the order of a ternary chain:
//
//   selected > removedByEdit > the part's own colour
//
// Selection wins because it answers "what am I acting on", which is what the
// user asked for most recently. The removal mark answers "what is this edit
// about to take away" and outranks the part colour, which only carries
// identity.
//
// It returns the WHOLE surface, not just the colour, because "one look for
// every removal" is a claim about the rendered pixels: a doomed body still
// wearing its own transmission=1 (glass) or metalness=1 reads as a completely
// different material and washes the mark out. Deciding the colour here and
// leaving the other four to the caller would make that claim false at exactly
// the point it is supposed to hold.
export interface BodySurfaceState {
  selected?: boolean
  removedByEdit?: boolean
  color?: string
  transparency?: number
  metalness?: number
  roughness?: number
  transmission?: number
}

export interface BodySurfaceLook {
  color: string
  transparency: number
  metalness: number
  roughness: number
  transmission: number
}

export function bodySurfaceLook({
  selected = false,
  removedByEdit = false,
  color,
  transparency = 0,
  metalness = 0,
  roughness = DEFAULT_PART_ROUGHNESS,
  transmission = 0,
}: BodySurfaceState): BodySurfaceLook {
  if (removedByEdit) {
    return {
      // The face goes fully see-through so the doomed body stops obscuring
      // what survives; the removal mark moves to the wireframe, which Body3D
      // paints pink. Selection still claims the surface so the "click again
      // to un-pick" affordance stays defined -- the visible half of it is the
      // wireframe brightening to the selected edge colour.
      color: selected ? COLOR_BODY_SELECTED : COLOR_BODY_REMOVED,
      transparency: 1,
      metalness: 0,
      roughness: DEFAULT_PART_ROUGHNESS,
      transmission: 0,
    }
  }
  return {
    color: selected ? COLOR_BODY_SELECTED : (color || COLOR_BODY_DEFAULT),
    transparency,
    metalness,
    roughness,
    transmission,
  }
}

// Every other colour that can share the 3D scene with a doomed body. The
// removal mark must not be mistakable for any of them -- COLOR_ERROR above all,
// which paints sketch entities in the same viewport whenever the active sketch
// is overconstrained. COLOR_PREVIEW_EDGE is deliberately absent: by user
// decision it IS the mark hue (both #bb5be1), so guarding against it would fail
// on distance 0 -- the preview overlay and the doomed mark share the pink on
// purpose.
const SCENE_COLORS_AGAINST_REMOVED = [
  COLOR_BODY_DEFAULT, COLOR_BODY_SELECTED, COLOR_BODY_EDGE, COLOR_BODY_EDGE_SEL,
  COLOR_ERROR, COLOR_SOLVED, COLOR_FULLY_CONSTRAINED, COLOR_INACTIVE,
  COLOR_HOVER, COLOR_SELECTED, COLOR_CONSTRAINT_HOVER,
  COLOR_PREVIEW, COLOR_PROJECTED, COLOR_SNAP,
] as const

export const REMOVED_COLOR_MIN_DISTANCE = 50

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', ''), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** Smallest RGB distance from COLOR_BODY_REMOVED to any other scene colour. */
export function bodyRemovedColorIsDistinct(): { nearest: string; distance: number } {
  const [r, g, b] = rgb(COLOR_BODY_REMOVED)
  let nearest = ''
  let distance = Infinity
  for (const other of SCENE_COLORS_AGAINST_REMOVED) {
    const [r2, g2, b2] = rgb(other)
    const d = Math.hypot(r - r2, g - g2, b - b2)
    if (d < distance) { distance = d; nearest = other }
  }
  return { nearest, distance }
}

// Drag snap: vertex pull zone must be larger than entity body pull zone so that
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
