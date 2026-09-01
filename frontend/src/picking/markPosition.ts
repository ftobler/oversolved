// PURE LOGIC -- no three.js, no GL.

/**
 * The bucket key for "these marks are at the same place".
 *
 * Rounded to FLOAT32, which is the precision a position attribute is uploaded
 * at anyway. That makes the rule exactly "these two marks cannot be told apart
 * by anything downstream of here", with no epsilon to pick and no dependence on
 * scale, zoom or camera -- so a co-location established at registration time
 * stays true for the life of that registration instead of having to be redone
 * whenever the view moves.
 *
 * Deliberately NOT geometric identity: ids are still allocated by query, and
 * this key is only ever a confined, render-local answer to which marks share a
 * pixel. Two entities bucketed together keep their own ids, their own queries
 * and their own pick keys, and separate again the moment their positions differ.
 */
export function markPositionKey(x: number, y: number, z: number): string {
  return `${Math.fround(x)},${Math.fround(y)},${Math.fround(z)}`
}
