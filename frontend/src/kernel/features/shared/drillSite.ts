// The one wording for what a hole drill site is. The kernel, the drive value
// boundary and the editor's sketch pick rule all refuse the same circle pick,
// so the reason and its remedy live here instead of drifting per surface.
//
// The instance pattern's sketch form selects the same point sites, so the
// wording is parameterized: hole keeps its own sentences byte for byte, and the
// instance pattern reads the same rule with its own nouns. One implementation
// of the sentences is what keeps the two from disagreeing about what a sketch
// point means.
//
// A refused pick is named the way every other message names document things:
// the entity by kind and ordinal, the sketch by its label or its kind ordinal
// (utils/core/displayNames). The raw ids never appear; a caller with no sketch
// row or feature list gets "the sketch" / "the picked entity" instead.

import {
  entityDisplayName,
  entityKindWord,
  sketchDisplayName,
  type NamingRow,
  type SketchNamingSource,
} from '@/utils/core/displayNames'

/** What a sketch's circles offer as an alternative to a point site. */
export type SketchCircleKind = 'none' | 'real' | 'construction'

/** The naming context a refusal has in hand: the sketch row and the document's
 *  ordered feature list. Both optional, so a shape-only caller still gets a
 *  sentence without an id. */
export interface SketchNaming {
  sketch?: SketchNamingSource
  features?: readonly NamingRow[]
}

/** The nouns one feature uses when it refuses a pick that names no point site.
 *  Every string is a fragment so the sentences below stay in one place. */
export interface SiteWording {
  // The feature the sentence names, e.g. "hole" or "instance pattern".
  feature: string
  // What a point is for this feature: "drill site" or "target".
  site: string
  // The clause after the colon explaining why a point is what the feature reads.
  meaning: string
  // The verb completing "the feature needs a point in its sketch to ...".
  needVerb: string
  // The verb completing "toggle its construction off to ...".
  flagVerb: string
  // The noun phrase a sketch with no usable point is refused with.
  noSite: string
  // The alternative to picking one point, completing "pick a sketch point, ...".
  pickHint: string
}

/** A hole's wording. The exact sentences are pinned by the hole tests. */
export const HOLE_SITE_WORDING: SiteWording = {
  feature: 'hole',
  site: 'drill site',
  meaning: 'a hole drills points at its `diameter`',
  needVerb: 'drill',
  flagVerb: 'drill it',
  noSite: 'no drillable non-construction point',
  pickHint: 'or the sketch itself',
}

/** The instance pattern's wording: the same rule, its own nouns. */
export const INSTANCE_SITE_WORDING: SiteWording = {
  feature: 'instance pattern',
  site: 'target',
  meaning: 'an instance pattern copies the source onto points',
  needVerb: 'copy the source onto',
  flagVerb: 'copy the source onto it',
  noSite: 'no non-construction target point',
  pickHint: 'or list the targets one by one',
}

/** The sketch as a sentence subject, `sketch 'Holes'` / `sketch 2` / `the
 *  sketch`. A bare sketch id is not a name the user can read. */
function sketchSubject(sketchId: string, naming: SketchNaming): string {
  return sketchDisplayName(sketchId, naming.features ?? [])
}

/** The picked entity as a sentence subject, falling back to a noun phrase for a
 *  row the sketch no longer holds. */
function entitySubject(sketchId: string, entityId: string, naming: SketchNaming, fallback: string): string {
  return entityDisplayName(naming.sketch ?? { id: sketchId }, entityId) ?? fallback
}

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

/** Why a picked circle names no point site, and what to do instead. */
export function circleDrillSiteReason(
  sketchId: string,
  entityId: string,
  construction = false,
  wording: SiteWording = HOLE_SITE_WORDING,
  naming: SketchNaming = {},
): string {
  const kind = construction ? 'construction circle' : 'circle'
  const subject = entitySubject(sketchId, entityId, naming, construction ? 'a construction circle' : 'a circle')
  return `${subject} of ${sketchSubject(sketchId, naming)} is a ${kind}, which is not a ${wording.site}: ` +
    `${wording.meaning}; ${circleRemedy(construction)}`
}

/**
 * The whole-sketch refusal when the sketch has no points at all. A circle gets
 * the extrude-cut alternative; a line-only sketch does not, because no circle
 * there would cut a bore.
 */
export function noPointDrillSiteReason(
  sketchId: string,
  circle: SketchCircleKind,
  wording: SiteWording = HOLE_SITE_WORDING,
  naming: SketchNaming = {},
): string {
  if (circle === 'none') {
    return `${sketchSubject(sketchId, naming)} has no point entities; ` +
      `the ${wording.feature} needs a point in its sketch to ${wording.needVerb}`
  }
  return `${sketchSubject(sketchId, naming)} has no point entities: ${wording.meaning}; ` +
    circleRemedy(circle === 'construction')
}

/**
 * The whole-sketch refusal when points exist but every one is construction. A
 * circle in the sketch keeps the extrude alternative alive, so the message
 * names both ways out instead of claiming the sketch has only construction
 * points (which the circle makes false).
 */
export function constructionOnlyPointsReason(
  sketchId: string,
  circle: SketchCircleKind,
  wording: SiteWording = HOLE_SITE_WORDING,
  naming: SketchNaming = {},
): string {
  if (circle === 'none') {
    return `${sketchSubject(sketchId, naming)} has only construction points; ` +
      'construction geometry is reference only, so add a non-construction point, ' +
      `or clear the point's construction flag to ${wording.flagVerb}`
  }
  return `${sketchSubject(sketchId, naming)} has ${wording.noSite}: ` +
    'add a non-construction point (or clear the point\'s construction flag), or ' +
    circleRemedy(circle === 'construction')
}

/** A picked non-point entity's name for the refusal sentences: the registry
 *  kind word, or "curve" for a kind the registry does not know. */
export function entityKindForRefusal(kind: string): string {
  return entityKindWord(kind) ?? 'curve'
}
