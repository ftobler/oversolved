// 3D body colors
export const COLOR_BODY_DEFAULT  = '#6ab59b'
export const PART_COLOR_PALETTE = ['#6AB59B', '#A8D5FF', '#B8E8C8', '#FFD6A5', '#F7C6C7', '#D4C7FF', '#FEE6A8', '#CDE7F0', '#F6C7A8']
export const COLOR_BODY_EDGE     = '#d3ede4'
export const COLOR_BODY_HOVER    = '#91ccb7'
export const COLOR_BODY_SELECTED = '#b5a16a'
export const COLOR_BODY_EDGE_SEL = '#ffffff'

// Geometry color palette
export const COLOR_SOLVED = '#0288d1'  // darker blue for underconstrained
export const COLOR_FULLY_CONSTRAINED = '#ffffff'  // white for fully constrained
export const COLOR_ERROR = '#ef5350'
export const COLOR_INACTIVE = '#3a4048'
export const COLOR_HOVER = '#ffffff'
export const COLOR_SELECTED = '#ff9800'
export const COLOR_CONSTRAINT_HOVER = '#fff176'  // entity highlighted because a constraint on it is hovered
export const COLOR_PREVIEW = '#aaaaaa'
export const COLOR_PROJECTED = '#ffca28'  // amber for projected/reference geometry
export const COLOR_SNAP = '#aaaaaa'  // snap indicator during drag (same hue as preview by default)

// Constraint tile color (shared between 2D and 3D views)
export const COLOR_CONSTRAINT = '#ffd54f'

// Render order (higher = renders on top)
export const RENDER_ORDER_DEFAULT = 0
export const RENDER_ORDER_GHOST = 1
export const RENDER_ORDER_EDITING = 10
export const RENDER_ORDER_HIGHLIGHT = 999

export function normalizeHexColor(color: string | undefined): string | null {
  if (!color) return null
  const trimmed = color.trim()
  if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) return trimmed.toUpperCase()
  if (/^#[0-9a-fA-F]{3}$/.test(trimmed)) {
    const s = trimmed.slice(1)
    return (`#${s[0]}${s[0]}${s[1]}${s[1]}${s[2]}${s[2]}`).toUpperCase()
  }
  return null
}
