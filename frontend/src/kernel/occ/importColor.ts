// The body colour a STEP import takes from its file. Oversolved colours a body,
// never a face, so where the file colours faces one colour has to win: the
// area-weighted majority of the faces' effective colours. Pure on purpose: the
// kernel hands in per-face colours and areas (occ/stepIo.ts reads them through
// OversolvedStepCaf) and the rule is tested without a kernel.

/** One face's vote: its effective file colour (`#rrggbb`, sRGB) or null when
 *  the file leaves it uncoloured, and its area. */
export interface FaceColorSample {
  color: string | null
  area: number
}

/** Why a body took its colour when its faces disagreed. */
export interface ImportColorNote {
  color: string
  // The winning colour's share of the body's face area, 0..1.
  share: number
  // The other colours the faces carried, largest area first. An uncoloured
  // share is listed as `none`.
  dropped: string[]
}

export interface ImportColor {
  color: string
  // Null when every face agreed: there was nothing to decide.
  note: ImportColorNote | null
}

const NONE = 'none'

// Two areas within this relative distance are a tie. Equal faces of a
// symmetric part differ in the last bits of their BRepGProp areas.
const TIE_TOLERANCE = 1e-9

/** `0xRRGGBB` as `#rrggbb`. */
export function hexOfPackedRgb(rgb: number): string {
  return '#' + (rgb & 0xffffff).toString(16).padStart(6, '0')
}

/** Unit sRGB channels as `#rrggbb`, each rounded to 8 bits, so two colours
 *  written as 0.8 and 0.80001 come out as one value and vote together. */
export function hexOfUnitRgb(r: number, g: number, b: number): string {
  const byte = (c: number): number => Math.min(255, Math.max(0, Math.round(c * 255)))
  return hexOfPackedRgb((byte(r) << 16) | (byte(g) << 8) | byte(b))
}

interface Tally {
  key: string
  area: number
  largestFace: number
}

/**
 * The body colour for one solid, or null when the file gives it none (the
 * palette colour then applies, as for a modelled body).
 *
 * - Each face votes its effective colour with its area; uncoloured faces vote
 *   `none`, so a file that colours only a logo face does not paint the body.
 * - A tie goes to `solidColor` (the colour the file put on the solid itself)
 *   when there is one, else to the tied colour owning the largest single face.
 * - When more than one colour (or `none`) appeared, the result carries a note.
 */
export function bodyImportColor(
  faces: readonly FaceColorSample[],
  solidColor: string | null,
): ImportColor | null {
  const tallies = new Map<string, Tally>()
  let total = 0
  for (const face of faces) {
    const key = face.color ?? NONE
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
  const key = tied.length === 1 ? tied[0].key : breakTie(tied, solidColor)
  if (key === NONE) return null
  if (tallies.size === 1) return { color: key, note: null }
  const area = tallies.get(key)?.area ?? 0
  return {
    color: key,
    note: {
      color: key,
      share: total > 0 ? area / total : 0,
      dropped: ranked.filter((t) => t.key !== key).map((t) => t.key),
    },
  }
}

function sameArea(a: number, b: number): boolean {
  return Math.abs(a - b) <= TIE_TOLERANCE * Math.max(Math.abs(a), Math.abs(b))
}

// The solid's own colour settles a tie even when no face shows it any more
// (every face overrode it): it is the colour the file declared for the body.
function breakTie(tied: Tally[], solidColor: string | null): string {
  if (solidColor !== null) return solidColor
  return tied.reduce((best, t) => (t.largestFace > best.largestFace ? t : best)).key
}

/** The reply text for a body whose faces disagreed. */
export function importColorNoteText(bodyId: string, note: ImportColorNote): string {
  const percent = Math.round(note.share * 100)
  const others = note.dropped.length === 1 ? '1 other colour' : `${note.dropped.length} other colours`
  return `body ${bodyId} takes ${note.color} from the STEP file (${percent}% of its face area); `
    + `${others} dropped (${note.dropped.join(', ')})`
}
