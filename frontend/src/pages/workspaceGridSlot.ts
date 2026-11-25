// The one insertion rule for the workspace tile grid. A pointer's position is
// compared with the gaps between the *other* tiles (the dragged one is not in
// the rect list), so reading order, row ends and the empty tail all name a slot.
// Pure and DOM-free: the page only supplies rects it measured once at drag
// start, which keeps a live reflow from moving the target under the pointer.

export interface GridTileRect {
  left: number
  top: number
  width: number
  height: number
}

export interface GridPoint {
  x: number
  y: number
}

function centerY(rect: GridTileRect): number {
  return rect.top + rect.height / 2
}

function sameRow(a: GridTileRect, b: GridTileRect): boolean {
  return Math.abs(centerY(a) - centerY(b)) < Math.min(a.height, b.height) / 2
}

// One representative point per insertion slot, from just before the first tile
// to just past the last. Same-row gaps sit between the two tiles' edges; a row
// break sits just after the previous row's last tile, which is where a pointer
// at that row's end should drop.
function slotAnchors(rects: ReadonlyArray<GridTileRect>): GridPoint[] {
  if (rects.length === 0) return []
  const first = rects[0]
  const pad = Math.max(4, first.width * 0.2)
  const anchors: GridPoint[] = [{ x: first.left - pad, y: centerY(first) }]
  for (let i = 1; i < rects.length; i++) {
    const previous = rects[i - 1]
    const current = rects[i]
    anchors.push(sameRow(previous, current)
      ? { x: (previous.left + previous.width + current.left) / 2, y: (centerY(previous) + centerY(current)) / 2 }
      : { x: previous.left + previous.width + pad, y: centerY(previous) })
  }
  const last = rects[rects.length - 1]
  anchors.push({ x: last.left + last.width + pad, y: centerY(last) })
  return anchors
}

export function gridSlotAt(rects: ReadonlyArray<GridTileRect>, pointer: GridPoint): number {
  const anchors = slotAnchors(rects)
  let slot = 0
  let best = Infinity
  for (let i = 0; i < anchors.length; i++) {
    const distance = Math.hypot(pointer.x - anchors[i].x, pointer.y - anchors[i].y)
    // Strictly less means an exact tie keeps the earlier slot: the pointer is
    // in the first half of a tile, which inserts before it.
    if (distance < best) {
      best = distance
      slot = i
    }
  }
  return slot
}
