// The one rule for which sketch points a feature treats as sites. A hole drills
// every non-construction POINT of its sketch; an instance pattern copies the
// source onto the same points. The rule and its refusals live here so the two
// features cannot disagree about construction points, line endpoints or the
// remedy for a picked circle. Projected points are ordinary points held by a
// projection constraint, so they count for both.
//
// A pick naming a single entity narrows the rule to that entity: a point drills,
// a circle gets the extrude-cut remedy, and a line or spline names no point.
// The sentences name the sketch and the entity by display name, never by id.

import {
  circleDrillSiteReason,
  constructionOnlyPointsReason,
  noPointDrillSiteReason,
  HOLE_SITE_WORDING,
  type SketchNaming,
  type SiteWording,
  type SketchCircleKind,
} from './drillSite'
import { entityDisplayName, sketchDisplayName } from '@/utils/core/displayNames'

type Dict = Record<string, unknown>

/** What the sketch's circles offer when no point can be a site. */
export function circleKindOf(entities: readonly Dict[]): SketchCircleKind {
  if (entities.some((e) => e.kind === 'circle' && e.construction !== true)) return 'real'
  return entities.some((e) => e.kind === 'circle') ? 'construction' : 'none'
}

/** The sketch as a sentence subject (`sketch 'Holes'` / `sketch 2` / `the
 *  sketch`), shared by the refusals below. */
function sketchSubject(sketchId: string, naming: SketchNaming): string {
  return sketchDisplayName(sketchId, naming.features ?? [])
}

/**
 * Every non-construction point entity of the sketch, in entity order. A whole-
 * sketch pick with no usable point is refused: a sketch of construction points
 * only, or one with no points at all, names no site and the sentence says what
 * to add (or which circle to cut instead).
 */
export function sketchPointSites(
  entities: readonly Dict[],
  sketchId: string,
  wording: SiteWording = HOLE_SITE_WORDING,
  naming: SketchNaming = {},
): Dict[] {
  const candidates = entities.filter((e) => e.kind === 'point')
  const sites = candidates.filter((e) => e.construction !== true)
  if (sites.length > 0) return sites
  const circle = circleKindOf(entities)
  if (candidates.length > 0) {
    throw new Error(constructionOnlyPointsReason(sketchId, circle, wording, naming))
  }
  throw new Error(noPointDrillSiteReason(sketchId, circle, wording, naming))
}

/**
 * The one entity a single-entity pick names, held to the same site rule. A pick
 * that names one point does not silently widen to every point, and a pick that
 * names a circle or a curve is refused by name with its own remedy.
 */
export function pickedPointSite(
  entities: readonly Dict[],
  sketchId: string,
  entityId: string,
  wording: SiteWording = HOLE_SITE_WORDING,
  naming: SketchNaming = {},
): Dict {
  const picked = entities.find((e) => e.id === entityId)
  const subject = entityDisplayName(naming.sketch ?? { id: sketchId }, entityId)
    ?? 'the picked entity'
  if (picked === undefined) throw new Error(`${sketchSubject(sketchId, naming)} has no such entity; pick the point again`)
  if (picked.kind === 'circle') {
    throw new Error(circleDrillSiteReason(sketchId, entityId, picked.construction === true, wording, naming))
  }
  if (picked.kind === 'point') {
    if (picked.construction === true) {
      throw new Error(
        `${subject} of ${sketchSubject(sketchId, naming)} is construction geometry, which names no ${wording.site}; ` +
        'construction geometry is reference only; toggle its construction off to ' +
        `${wording.flagVerb}, or pick the sketch itself`,
      )
    }
    return picked
  }
  // No kind repeat: the subject already says "line 1" / "arc 2".
  throw new Error(
    `${subject} of ${sketchSubject(sketchId, naming)} is not a point, so it names no ${wording.site}; `
    + `pick a sketch point, ${wording.pickHint}`,
  )
}
