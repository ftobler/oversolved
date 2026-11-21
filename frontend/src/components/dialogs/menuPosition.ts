// Where a right-click menu is drawn. Kept apart from the component so the
// flip/clamp rules are unit tested without a layout: a menu anchored at the raw
// click runs off the window at the bottom and right edges, where its last items
// become unreachable.

export interface MenuSize {
  width: number
  height: number
}

export interface ViewportSize {
  width: number
  height: number
}

// The gap kept between the menu and the window edge, in pixels.
export const MENU_MARGIN = 8

// One axis: `start` is the click coordinate, `extent` the menu's size on that
// axis and `limit` the viewport's. The menu hangs from the pointer while it
// fits, flips to the other side when it does not, and finally pins to the margin
// when neither side fits (a menu larger than the window cannot be shown whole,
// so the leading edge wins and the overflow falls off the far side).
function placeAxis(start: number, extent: number, limit: number, margin: number): number {
  if (start + extent <= limit - margin) return start
  const flipped = start - extent
  if (flipped >= margin) return flipped
  return margin
}

export function clampMenuPosition(
  click: [number, number],
  size: MenuSize,
  viewport: ViewportSize,
  margin: number = MENU_MARGIN,
): [number, number] {
  return [
    placeAxis(click[0], size.width, viewport.width, margin),
    placeAxis(click[1], size.height, viewport.height, margin),
  ]
}
