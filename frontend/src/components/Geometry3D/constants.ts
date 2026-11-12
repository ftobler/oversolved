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
  COLOR_HINT,
  COLOR_HINT_FAILED,
  HINT_BLEND,
  blendToward,
  COLOR_CONSTRAINT_HOVER,
  COLOR_PREVIEW,
  COLOR_PROJECTED,
  COLOR_SNAP,
  EDGE_HIGHLIGHT_LINE_WIDTH,
} from '@/utils/core/partColors'

export {
  COLOR_BODY_DEFAULT,
  COLOR_BODY_EDGE,
  COLOR_BODY_SELECTED,
  COLOR_BODY_EDGE_SEL,
  COLOR_BODY_REMOVED,
  DEFAULT_PART_ROUGHNESS,
  COLOR_SOLVED,
  COLOR_FULLY_CONSTRAINED,
  COLOR_ERROR,
  COLOR_ERROR_DEEP,
  COLOR_INACTIVE,
  COLOR_HOVER,
  COLOR_SELECTED,
  HOVER_BLEND,
  blendWhite,
  blendToward,
  COLOR_HINT,
  COLOR_HINT_FAILED,
  HINT_BLEND,
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

// ─── highlight precedence ───
// The one question every highlight painter asks: which of the live states claims
// this primitive? Selection outranks hover, because a click is the durable answer
// to "what am I acting on" and the hover under the cursor is only the next
// candidate. The relation hint is the weakest: it answers "this is related to
// what you selected", not "this is what you selected", so a hover or selection
// always wins. The failure tier of the hint (a pick the solve refused) sits just
// above the plain hint: it is still a hint, only a red one. Every painter (sketch
// lines, dots, helix, planes, sketch areas, B-rep outlines and the vertex/colour
// buffers) calls this, so a primitive that is both selected and hovered reads the
// same everywhere: one colour, one render layer.
export type HighlightState = 'selected' | 'hovered' | 'hinted-failed' | 'hinted' | null

export function highlightState(
  selected: boolean,
  hovered: boolean,
  hinted = false,
  hintedFailed = false,
): HighlightState {
  if (selected) return 'selected'
  if (hovered) return 'hovered'
  if (hintedFailed) return 'hinted-failed'
  if (hinted) return 'hinted'
  return null
}

// ─── highlight overlay recipe ───
// The material a hovered or selected B-rep primitive is outlined with. Hover
// and selection differ ONLY in colour: `depthTest: false` keeps the marker
// above the body it outlines, and `transparent: true` puts it in the sorted
// pass after every opaque layer, so the body fill (order 0) and the section cap
// (order 150+) can no longer paint over a hover. The hover overlay used to be
// opaque and at order 0, which is exactly how a hovered edge vanished on a
// sectioned or transparent body while the selected one beside it stayed.
export function overlayLineMaterialProps(color: string) {
  return {
    color,
    linewidth: EDGE_HIGHLIGHT_LINE_WIDTH,
    depthTest: false,
    transparent: true,
  }
}

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
//   selected           -> above the B-rep, at the edit layer (hover does not move it)
//   hovered            -> top of everything (above other editing lines too)
//   editing only       -> above the B-rep, at the edit layer
//   visible only       -> depth-tested at its plane (clipped by solids in front)
export interface EntityLayerState {
  isEditing?: boolean
  selected?: boolean
  hovered?: boolean
  hinted?: boolean
}

export function entityRenderLayer(
  { isEditing = false, selected = false, hovered = false, hinted = false }: EntityLayerState,
): { depthTest: boolean; renderOrder: number } {
  const state = highlightState(selected, hovered, hinted)
  if (state === 'selected') return { depthTest: false, renderOrder: RENDER_ORDER_EDITING }
  if (state === 'hovered') return { depthTest: false, renderOrder: RENDER_ORDER_HIGHLIGHT }
  // A hinted sketch line is drawn by the hint rather than by its own visibility:
  // the consumption rule hides the sketch but the line still sits inside the
  // body it built, so it needs the edit layer to be seen at all. Hinted B-rep
  // faces are not lifted: they stay depth-tested.
  if (isEditing || state === 'hinted' || state === 'hinted-failed') return { depthTest: false, renderOrder: RENDER_ORDER_EDITING }
  return { depthTest: true, renderOrder: RENDER_ORDER_DEFAULT }
}

// ─── dimension render layering ───
// Dimensions only exist on the sketch being edited, so they ride the same
// overlay layer as the sketch's own entities. depthTest: false alone is not
// "on top": three sorts the opaque pass by renderOrder and only breaks a tie on
// material.id, so a dimension whose material was created before a body's (the
// shape every body remount during a solve produces) is drawn first and the body
// paints over it. The explicit renderOrder outranks the body whatever the
// material creation order happened to be.
export function dimensionRenderLayer(): { depthTest: false; renderOrder: number } {
  return { depthTest: false, renderOrder: RENDER_ORDER_EDITING }
}

// ─── body surface look ───
// The one place that decides how a solid body is drawn. Three inputs can each
// claim the surface, so the precedence has to be stated somewhere rather than
// fall out of the order of a ternary chain:
//
//   selected > doomed > the part's own colour
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
  doomed?: boolean
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
  doomed = false,
  color,
  transparency = 0,
  metalness = 0,
  roughness = DEFAULT_PART_ROUGHNESS,
  transmission = 0,
}: BodySurfaceState): BodySurfaceLook {
  if (doomed) {
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
  COLOR_HINT, COLOR_PREVIEW, COLOR_PROJECTED, COLOR_SNAP,
] as const

export const REMOVED_COLOR_MIN_DISTANCE = 50

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', ''), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function nearestRival(color: string, rivals: readonly string[]): { nearest: string; distance: number } {
  const [r, g, b] = rgb(color)
  let nearest = ''
  let distance = Infinity
  for (const other of rivals) {
    const [r2, g2, b2] = rgb(other)
    const d = Math.hypot(r - r2, g - g2, b - b2)
    if (d < distance) { distance = d; nearest = other }
  }
  return { nearest, distance }
}

/** Smallest RGB distance from COLOR_BODY_REMOVED to any other scene colour. */
export function bodyRemovedColorIsDistinct(): { nearest: string; distance: number } {
  return nearestRival(COLOR_BODY_REMOVED, SCENE_COLORS_AGAINST_REMOVED)
}

// The colours a hint must never be mistaken for: the two stronger highlights,
// the removal mark, and the default body fill. The hinted face colour is the
// body colour blended toward COLOR_HINT, which is the one value the viewport
// actually paints; the line colour is COLOR_HINT at full strength.
export const HINT_COLOR_MIN_DISTANCE = 40

const HINT_RIVALS = [COLOR_HOVER, COLOR_SELECTED, COLOR_BODY_REMOVED, COLOR_BODY_DEFAULT, COLOR_HINT_FAILED] as const

/** How far the hinted face fill and the hinted line colour sit from every
 *  stronger highlight and from the default body. Shared constants, not
 *  screenshots: R3F tone-mapping is not what the tree's CSS reads either. */
export function hintColorsAreDistinct(): {
  face: { nearest: string; distance: number }
  line: { nearest: string; distance: number }
} {
  return {
    face: nearestRival(blendToward(COLOR_BODY_DEFAULT, COLOR_HINT, HINT_BLEND), HINT_RIVALS),
    line: nearestRival(COLOR_HINT, HINT_RIVALS),
  }
}

// The failure tier keeps the same shape of guard, measured against the states
// that outrank it plus the plain hint it sits beside. COLOR_ERROR is deliberately
// absent: a refused pick and an overconstrained sketch entity are two marks for
// "the solve could not do this", so they may share a red family.
export const FAILED_HINT_COLOR_MIN_DISTANCE = 40

const FAILED_HINT_RIVALS = [
  COLOR_HOVER, COLOR_SELECTED, COLOR_HINT, COLOR_BODY_REMOVED, COLOR_BODY_DEFAULT,
] as const

export function failedHintColorsAreDistinct(): {
  face: { nearest: string; distance: number }
  line: { nearest: string; distance: number }
} {
  return {
    face: nearestRival(blendToward(COLOR_BODY_DEFAULT, COLOR_HINT_FAILED, HINT_BLEND), FAILED_HINT_RIVALS),
    line: nearestRival(COLOR_HINT_FAILED, FAILED_HINT_RIVALS),
  }
}

// Hit detection & collision geometry
export const POINT_VIS_PIXELS = 4

// Click-vs-drag disambiguation: pointer moves smaller than this (in screen pixels)
// are treated as pure clicks and do not emit geometry mutations. Defined in the
// utils leaf so the headless gesture logic does not import the UI tree.
export { CLICK_THRESHOLD_PX } from '@/utils/pointerAbstraction'

// Visualization
export { ARC_SEGMENTS } from '@/utils/geometry/arcSegments'

// Tiny z-offset used to lift dimension labels, constraint icons, and entity
// markers above the sketch plane (z=0) so they render on top without z-fighting.
export const LABEL_Z_OFFSET = 0.001
