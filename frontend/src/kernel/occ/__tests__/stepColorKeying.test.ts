// The pairing of OversolvedStepCaf's positional colour arrays with our own
// sub-shapes. A count mismatch must degrade to "no colours" (null), never pair
// colours with the wrong faces and never fail the import.

import { describe, it, expect } from 'vitest'
import { keyColors } from '../stepIo'
import type { OccShape, OccSubShape } from '../occTypes'

/** A stand-in sub-shape: identity is object identity, no HashCode. */
function fakeShape(): OccShape {
  const self = { IsSame: (other: unknown) => other === self }
  return self as unknown as OccShape
}

describe('keyColors', () => {
  it('keys each coloured position by its sub-shape and leaves -1 and unpaired targets out', () => {
    const [a, b, c] = [fakeShape(), fakeShape(), fakeShape()]
    const out = keyColors(Int32Array.from([0x808080, -1, 0xcc3333, 0x3333cc]), [a, b, c, null])
    expect(out).not.toBeNull()
    expect(out!.get(a as OccSubShape)).toBe(0x808080)
    expect(out!.has(b as OccSubShape)).toBe(false)
    expect(out!.get(c as OccSubShape)).toBe(0xcc3333)
    expect(out!.size).toBe(2)
  })

  it('refuses a count mismatch with null rather than pairing by position', () => {
    expect(keyColors(Int32Array.from([0x808080, 0x808080]), [fakeShape()])).toBeNull()
    expect(keyColors(Int32Array.from([]), [fakeShape()])).toBeNull()
  })
})
