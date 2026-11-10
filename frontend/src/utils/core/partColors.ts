// 3D body colors
export const COLOR_BODY_DEFAULT  = '#6ab59b'
export const PART_COLOR_PALETTE = ['#6AB59B', '#A8D5FF', '#B8E8C8', '#FFD6A5', '#F7C6C7', '#D4C7FF', '#FEE6A8', '#CDE7F0', '#F6C7A8', '#FFE29B', '#000000', '#222222',  '#444444', '#666666', '#888888', '#AAAAAA', '#CCCCCC', '#EEEEEE', '#FFFFFF']  // extended palette with more grayscale options
export const COLOR_BODY_EDGE     = '#eeeeee'
export const COLOR_BODY_SELECTED = '#b5a16a'
export const COLOR_BODY_EDGE_SEL = '#ffffff'
export const DEFAULT_PART_ROUGHNESS = 0.7

// The mark of a body the edit in the editor is about to consume (delete_body,
// a boolean that swallows its tool). It lives on the doomed body's WIREFRAME:
// the face is drawn fully transparent, so the pink edges are what show which
// body is leaving. One look for every removal -- no per-body variants. The hue
// is the SAME as the preview overlay (COLOR_PREVIEW_EDGE), by user decision:
// the colour that previews what the edit adds is exactly what the edit will
// take away. It still has to stay clear of the palette's other claimants --
// COLOR_ERROR above all, which paints sketch entities in the same scene while
// an active sketch is on screen, and the selected/edge whites.
// `bodyRemovedColorIsDistinct` pins that distance.
//
// The doomed FACE is always fully transparent, so there is no transparency
// band to floor or ceiling: the pink wireframe is the mark and stays visible
// whatever the part was styled at, while the face never obscures what survives.
export const COLOR_BODY_REMOVED = '#bb5be1'

// Geometry color palette
export const COLOR_SOLVED = '#0288d1'  // darker blue for underconstrained
export const COLOR_FULLY_CONSTRAINED = '#ffffff'  // white for fully constrained
export const COLOR_ERROR = '#ef5350'
// The deeper error red: the constraints the solve blamed for an unsatisfied
// sketch sit inside the all-red mark, one shade down so the culprits are
// findable without hunting the whole red sketch. Deliberately the same hue
// family as COLOR_ERROR, only darker, so it reads as "this one" rather than as
// a different state.
export const COLOR_ERROR_DEEP = '#b71c1c'
export const COLOR_INACTIVE = '#3a4048'
export const COLOR_HOVER = '#ffffff'
export const COLOR_SELECTED = '#ff9800'
// The relation hint: a third, weaker state meaning "this is related to what you
// selected". Cyan is the vocabulary the assembly cross-highlight already used for
// its `.related` rows, so the tree and the viewport now speak one colour. It has
// to stay clear of hover white, selection orange, the pink removal mark and the
// default body green; `hintColorsAreDistinct` pins that distance.
export const COLOR_HINT = '#4fc3f7'
export const COLOR_CONSTRAINT_HOVER = '#fff176'  // entity highlighted because a constraint on it is hovered
export const COLOR_PREVIEW = '#aaaaaa'
export const COLOR_PREVIEW_EDGE = '#bb5be1'  // pink edge-only preview overlay (shared with the doomed-body mark)
export const COLOR_PROJECTED = '#ffca28'  // amber for projected/reference geometry
export const COLOR_SNAP = '#aaaaaa'  // snap indicator during drag (same hue as preview by default)

// Render order (higher = renders on top)
export const RENDER_ORDER_DEFAULT = 0
export const RENDER_ORDER_EDITING = 10
export const RENDER_ORDER_HIGHLIGHT = 999

// Shared edge highlight line width so Part Editor and Assembly mode read the same
export const EDGE_HIGHLIGHT_LINE_WIDTH = 3

export const HOVER_BLEND = 0.4  // how much white to blend into the body color on hover (0 = body color, 1 = white)
// How far a hinted face's fill moves from the body colour toward COLOR_HINT.
// Faces keep the body's identity and only read as related; thin sketch lines use
// the full hint colour because a 0.3 blend on a 1px line is invisible.
export const HINT_BLEND = 0.45

/** Returns a hex color that blends `baseColor` toward `targetColor` by `factor`. */
export function blendToward(baseColor: string, targetColor: string, factor: number): string {
  const [r, g, b] = hexChannels(baseColor)
  const [tr, tg, tb] = hexChannels(targetColor)
  const mix = (from: number, to: number) => Math.round(from + (to - from) * factor)
  return `#${toHex(mix(r, tr))}${toHex(mix(g, tg))}${toHex(mix(b, tb))}`
}

/** Returns a hex color that blends `baseColor` with white by `factor`. */
export function blendWhite(baseColor: string, factor: number = HOVER_BLEND): string {
  return blendToward(baseColor, '#ffffff', factor)
}

function hexChannels(color: string): [number, number, number] {
  const n = parseInt(color.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function toHex(channel: number): string {
  return Math.max(0, Math.min(255, channel)).toString(16).padStart(2, '0')
}

export function normalizeHexColor(color: string | undefined): string | null {
  if (!color) return null
  const trimmed = color.trim()
  if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) return trimmed.toUpperCase()
  return null
}
