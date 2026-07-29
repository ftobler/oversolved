// 3D body colors
export const COLOR_BODY_DEFAULT  = '#6ab59b'
export const PART_COLOR_PALETTE = ['#6AB59B', '#A8D5FF', '#B8E8C8', '#FFD6A5', '#F7C6C7', '#D4C7FF', '#FEE6A8', '#CDE7F0', '#F6C7A8', '#FFE29B', '#000000', '#222222',  '#444444', '#666666', '#888888', '#AAAAAA', '#CCCCCC', '#EEEEEE', '#FFFFFF']  // extended palette with more grayscale options
export const COLOR_BODY_EDGE     = '#eeeeee'
export const COLOR_BODY_SELECTED = '#b5a16a'
export const COLOR_BODY_EDGE_SEL = '#ffffff'
export const DEFAULT_PART_ROUGHNESS = 0.7

// A ghost body the edit in the editor is about to consume (delete_body, a
// boolean that swallows its tool). One look for every removal -- no per-body
// variants. Crimson: it has to stay clear of BOTH neighbours in this palette,
// the violet COLOR_PREVIEW_EDGE (which means the OPPOSITE, "new geometry") and
// COLOR_ERROR, which paints sketch entities in the same scene while an active
// sketch is on screen. `bodyRemovedColorIsDistinct` pins that distance.
export const COLOR_BODY_REMOVED = '#d81b60'

// Floor and ceiling, not a fixed value: the floor keeps the doomed body from
// hiding what survives behind it, the ceiling keeps the mark itself visible.
// Without the ceiling a body the user had already styled at transparency 1
// stayed fully invisible while still registered in the id buffer -- an
// unclickable-through blocker with no mark, strictly worse than the old hide.
export const BODY_REMOVED_TRANSPARENCY = 0.7
export const BODY_REMOVED_TRANSPARENCY_MAX = 0.9

// Geometry color palette
export const COLOR_SOLVED = '#0288d1'  // darker blue for underconstrained
export const COLOR_FULLY_CONSTRAINED = '#ffffff'  // white for fully constrained
export const COLOR_ERROR = '#ef5350'
export const COLOR_INACTIVE = '#3a4048'
export const COLOR_HOVER = '#ffffff'
export const COLOR_SELECTED = '#ff9800'
export const COLOR_CONSTRAINT_HOVER = '#fff176'  // entity highlighted because a constraint on it is hovered
export const COLOR_PREVIEW = '#aaaaaa'
export const COLOR_PREVIEW_EDGE = '#A855F7'  // violet neon for edge-only preview overlay
export const COLOR_PROJECTED = '#ffca28'  // amber for projected/reference geometry
export const COLOR_SNAP = '#aaaaaa'  // snap indicator during drag (same hue as preview by default)

// Render order (higher = renders on top)
export const RENDER_ORDER_DEFAULT = 0
export const RENDER_ORDER_EDITING = 10
export const RENDER_ORDER_HIGHLIGHT = 999

// Shared edge highlight line width so Part Editor and Assembly mode read the same
export const EDGE_HIGHLIGHT_LINE_WIDTH = 3

export const HOVER_BLEND = 0.4  // how much white to blend into the body color on hover (0 = body color, 1 = white)

/** Returns a hex color that blends `baseColor` with white by `factor`. */
export function blendWhite(baseColor: string, factor: number = HOVER_BLEND): string {
  const r = parseInt(baseColor.slice(1, 3), 16)
  const g = parseInt(baseColor.slice(3, 5), 16)
  const b = parseInt(baseColor.slice(5, 7), 16)
  const br = Math.min(255, Math.round(r + (255 - r) * factor))
  const bg = Math.min(255, Math.round(g + (255 - g) * factor))
  const bb = Math.min(255, Math.round(b + (255 - b) * factor))
  return `#${br.toString(16).padStart(2, '0')}${bg.toString(16).padStart(2, '0')}${bb.toString(16).padStart(2, '0')}`
}

export function normalizeHexColor(color: string | undefined): string | null {
  if (!color) return null
  const trimmed = color.trim()
  if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) return trimmed.toUpperCase()
  return null
}
