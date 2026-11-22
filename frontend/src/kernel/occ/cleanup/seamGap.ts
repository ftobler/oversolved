/**
 * The angular gap search shared by the two seam placement rules.
 *
 * A periodic face's seam must sit somewhere the face's own boundary leaves
 * free, or the seam would end on (and split) a visible edge. Both the cylinder
 * cluster canonicalisation (`canonicalSurfaces.ts`) and the residual-seam
 * re-seat (`cleanup/reseatSeams.ts`) ask the same question of a set of angles
 * their boundary occupies: where is the widest free arc?
 *
 * The input angles are one period wide (a caller normalises them); the search
 * also considers the gap that wraps past the period mark, which is the one a
 * naive sorted-difference pass would miss.
 */

// The narrowest free arc a seam may be placed in. Below it the seam is not
// worth moving: it would graze the boundary instead of clearing it.
export const MIN_SEAM_GAP = (20 * Math.PI) / 180

/**
 * The middle of the largest circular gap in `angles`, in the same units. Null
 * when the widest gap is narrower than `minGap`, or when an angle is not a
 * finite number (accept-on-within: a NaN must reject, not slip through a
 * comparison).
 *
 * No angles at all means the whole circle is free; 0 is as good a seam angle
 * as any.
 */
export function largestFreeGap(angles: readonly number[], minGap = MIN_SEAM_GAP): number | null {
  if (angles.length === 0) return 0
  for (const a of angles) if (!Number.isFinite(a)) return null
  const sorted = [...angles].sort((a, b) => a - b)
  let gapStart = sorted[sorted.length - 1]
  let gap = sorted[0] + 2 * Math.PI - gapStart
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - sorted[i - 1] > gap) {
      gap = sorted[i] - sorted[i - 1]
      gapStart = sorted[i - 1]
    }
  }
  if (!(gap >= minGap)) return null
  return gapStart + gap / 2
}
