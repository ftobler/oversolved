// The part colour a STEP import takes from its file. Oversolved colours a part,
// never a face, so where the file colours faces one colour has to win: the
// area-weighted majority of the faces' effective colours. Pure on purpose: the
// kernel hands in per-face colours and areas (occ/stepIo.ts reads them through
// OversolvedStepCaf) and the rule is tested without a kernel.
//
// Colours arrive already rounded to 8-bit sRGB: the OversolvedStepCaf helper
// reads each channel as sRGB and rounds it, so a file's 0.8 and 0.80001 are
// one `0xRRGGBB` value before they reach this module and vote together by
// plain equality (`color_faces.step` writes one face that way).

/** One face's vote: its effective file colour (`#rrggbb`, sRGB) or null when
 *  the file leaves it uncoloured, and its area. */
export interface FaceColorSample {
  color: string | null
  area: number
}

/** The label an uncoloured share carries in a note's `dropped` list. */
export const UNCOLOURED = 'uncoloured'

/** How the winner was chosen when its faces disagreed. */
export type ImportColorChoice =
  // The largest area share won outright.
  | 'majority'
  // Shares tied and the solid's own colour settled it.
  | 'solid-tie'
  // Shares tied with no solid colour; the tied colour with the largest face won.
  | 'largest-face-tie'

/** Why a part took its colour (or stayed uncoloured) when its faces disagreed. */
export interface ImportColorNote {
  // The chosen colour, or null when the uncoloured share won.
  color: string | null
  // The chosen share of the part's face area, 0..1 (0 for a solid colour that
  // settled a tie without any face showing it).
  share: number
  choice: ImportColorChoice
  // The other colours the faces carried, largest area first; an uncoloured
  // share is listed as `uncoloured`.
  dropped: string[]
}

export interface ImportColor {
  // Null when the uncoloured share won: the palette colour then applies.
  color: string | null
  // Null when every face agreed: there was nothing to decide.
  note: ImportColorNote | null
}

// Two areas within this relative distance are a tie. Equal faces of a
// symmetric part differ in the last bits of their BRepGProp areas.
const TIE_TOLERANCE = 1e-9

/** `0xRRGGBB` as `#rrggbb`. */
export function hexOfPackedRgb(rgb: number): string {
  return '#' + (rgb & 0xffffff).toString(16).padStart(6, '0')
}

interface Tally {
  key: string
  area: number
  largestFace: number
}

/**
 * The part colour for one solid, or null when the file says nothing about it
 * (every face uncoloured, no solid colour): the palette colour then applies,
 * as for a modelled part.
 *
 * - Each face votes its effective colour with its area; uncoloured faces vote
 *   as one `uncoloured` share, so a file that colours only a logo face does
 *   not paint the part.
 * - A tie goes to `solidColor` (the colour the file put on the solid itself)
 *   when there is one, else to the tied colour owning the largest single face.
 * - When more than one share appeared, the result carries a note, also when
 *   the uncoloured share won and the part keeps no file colour.
 */
export function partImportColor(
  faces: readonly FaceColorSample[],
  solidColor: string | null,
): ImportColor | null {
  const tallies = new Map<string, Tally>()
  let total = 0
  for (const face of faces) {
    const key = face.color ?? UNCOLOURED
    const area = Number.isFinite(face.area) && face.area > 0 ? face.area : 0
    const tally = tallies.get(key) ?? { key, area: 0, largestFace: 0 }
    tally.area += area
    tally.largestFace = Math.max(tally.largestFace, area)
    tallies.set(key, tally)
    total += area
  }
  if (tallies.size === 0) return solidColor === null ? null : { color: solidColor, note: null }
  const ranked = [...tallies.values()].sort((a, b) => b.area - a.area)
  const top = ranked[0].area
  const tied = ranked.filter((t) => sameArea(t.area, top))
  const { key, choice } = tied.length === 1
    ? { key: tied[0].key, choice: 'majority' as const }
    : breakTie(tied, solidColor)
  const color = key === UNCOLOURED ? null : key
  if (tallies.size === 1) return color === null ? null : { color, note: null }
  const area = tallies.get(key)?.area ?? 0
  return {
    color,
    note: {
      color,
      share: total > 0 ? area / total : 0,
      choice,
      dropped: ranked.filter((t) => t.key !== key).map((t) => t.key),
    },
  }
}

function sameArea(a: number, b: number): boolean {
  return Math.abs(a - b) <= TIE_TOLERANCE * Math.max(Math.abs(a), Math.abs(b))
}

// The solid's own colour settles a tie even when no face shows it any more
// (every face overrode it): it is the colour the file declared for the part.
function breakTie(tied: Tally[], solidColor: string | null): { key: string; choice: ImportColorChoice } {
  if (solidColor !== null) return { key: solidColor, choice: 'solid-tie' }
  const best = tied.reduce((winner, t) => (t.largestFace > winner.largestFace ? t : winner))
  return { key: best.key, choice: 'largest-face-tie' }
}

/** The reply text for a part whose faces disagreed. */
export function importColorNoteText(partId: string, note: ImportColorNote): string {
  const percent = Math.round(note.share * 100)
  const others = note.dropped.length === 1 ? '1 other colour' : `${note.dropped.length} other colours`
  const tail = `; ${others} dropped (${note.dropped.join(', ')})`
  if (note.color === null) {
    return `part ${partId} stays uncoloured: ${percent}% of its face area has no colour in the STEP file${tail}`
  }
  if (note.choice === 'solid-tie') {
    return `part ${partId} takes ${note.color}, the STEP file's colour for the solid, because its face colours tie${tail}`
  }
  const how = note.choice === 'largest-face-tie' ? ', a tie broken by its largest face' : ''
  return `part ${partId} takes ${note.color} from the STEP file (${percent}% of its face area${how})${tail}`
}
