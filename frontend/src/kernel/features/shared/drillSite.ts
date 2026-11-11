// The one wording for what a hole drill site is. The kernel, the drive value
// boundary and the editor's sketch pick rule all refuse the same circle pick,
// so the reason and its remedy live here instead of drifting per surface.

/** Why a picked circle names no drill site, and what to do instead. */
export function circleDrillSiteReason(sketchId: string, entityId: string): string {
  return `'${entityId}' of sketch ${sketchId} is a circle, which is not a drill site: ` +
    'a hole drills points at its `diameter`; put a point at the circle\'s centre, or cut the circle with an extrude cut'
}

/**
 * The whole-sketch refusal when no point can be drilled. A sketch that holds a
 * circle gets the extrude-cut alternative; a line-only sketch does not, because
 * no circle there would cut a bore.
 */
export function noPointDrillSiteReason(sketchId: string, hasCircle: boolean): string {
  return hasCircle
    ? `sketch '${sketchId}' has no point entities: a hole drills points at its \`diameter\`; ` +
      'put a point at the circle\'s centre, or cut the circle with an extrude cut'
    : `sketch '${sketchId}' has no point entities; the hole needs a point in its sketch to drill`
}
