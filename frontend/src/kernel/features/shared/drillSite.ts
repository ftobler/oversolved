// The one wording for what a hole drill site is. The kernel, the drive value
// boundary and the editor's sketch pick rule all refuse the same circle pick,
// so the reason and its remedy live here instead of drifting per surface.

/** What a sketch's circles offer as an alternative to a point site. */
export type SketchCircleKind = 'none' | 'real' | 'construction'

/**
 * The remedy for a non-construction circle: cut it with an extrude. Construction
 * geometry is excluded from profiles, so a construction circle needs its flag
 * cleared first; the two cases speak differently because the steps differ.
 */
function circleRemedy(construction: boolean): string {
  return construction
    ? 'clear the circle\'s construction flag, then cut it with an extrude cut'
    : 'put a point at the circle\'s centre, or cut the circle with an extrude cut'
}

/** Why a picked circle names no drill site, and what to do instead. */
export function circleDrillSiteReason(sketchId: string, entityId: string, construction = false): string {
  const kind = construction ? 'construction circle' : 'circle'
  return `'${entityId}' of sketch ${sketchId} is a ${kind}, which is not a drill site: ` +
    `a hole drills points at its \`diameter\`; ${circleRemedy(construction)}`
}

/**
 * The whole-sketch refusal when the sketch has no points at all. A circle gets
 * the extrude-cut alternative; a line-only sketch does not, because no circle
 * there would cut a bore.
 */
export function noPointDrillSiteReason(sketchId: string, circle: SketchCircleKind): string {
  if (circle === 'none') {
    return `sketch '${sketchId}' has no point entities; the hole needs a point in its sketch to drill`
  }
  return `sketch '${sketchId}' has no point entities: a hole drills points at its \`diameter\`; ` +
    circleRemedy(circle === 'construction')
}

/**
 * The whole-sketch refusal when points exist but every one is construction. A
 * circle in the sketch keeps the extrude alternative alive, so the message
 * names both ways out instead of claiming the sketch has only construction
 * points (which the circle makes false).
 */
export function constructionOnlyPointsReason(sketchId: string, circle: SketchCircleKind): string {
  if (circle === 'none') {
    return `sketch '${sketchId}' has only construction points; ` +
      'construction geometry is reference only, so add a non-construction point, ' +
      'or clear the point\'s construction flag to drill it'
  }
  return `sketch '${sketchId}' has no drillable non-construction point: ` +
    'add a non-construction point (or clear the point\'s construction flag), or ' +
    circleRemedy(circle === 'construction')
}
