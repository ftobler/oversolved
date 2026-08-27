// Whether a left press on the pane may open a rubber-band box sweep.
//
// Three independent reasons to decline, all of them "this press already
// belongs to something else":
//  - a live hover means the press is aimed at geometry, and the id-buffer
//    dispatcher owns it;
//  - a dimension placement is pending, and the next empty-space click IS the
//    placement. Letting a box open there costs the dimension twice: the band's
//    teardown claims the trailing click (bandClickGuard) so
//    finalizeDimensionPlacement never runs, and the committed box replaces the
//    user's normal selection on top of that;
//  - drawing tools commit on pointer-down, so the gesture is a draw.
export function shouldOpenRubberBand(s: {
  activeTool: string | null
  dimensionPickCount: number
  hasHover: boolean
}): boolean {
  if (s.hasHover) return false
  if (s.activeTool === 'dimension') return s.dimensionPickCount === 0
  return s.activeTool === null || s.activeTool === 'drag'
}
