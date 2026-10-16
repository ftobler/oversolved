// The helix document boundary: a valid helix is accepted, and a bad enum or an
// out-of-range literal angle is rejected with its field path.

import { describe, it, expect } from 'vitest'
import { loadPartDoc } from '../docSchema'

function helixDoc(helix: Record<string, unknown>): Record<string, unknown> {
  return { features: [{ id: 'hx1', kind: 'helix', label: 'Helix', helix }] }
}

const VALID = {
  reference: '@ex1/face/0', radius_mode: 'derived', mode: 'pitch_turns',
  pitch: 2, turns: 5, height: 10, helix_angle: 5, offset: 0, start_angle: 0,
  hand: 'right', direction: 'normal',
}

describe('docSchema: helix', () => {
  it('accepts a valid helix', () => {
    const result = loadPartDoc(helixDoc(VALID))
    expect(result.ok).toBe(true)
  })

  it('accepts expression strings on the numeric fields', () => {
    const result = loadPartDoc(helixDoc({ ...VALID, pitch: 'p', start_angle: 'a / 2' }))
    expect(result.ok).toBe(true)
  })

  it('rejects an unknown mode', () => {
    const result = loadPartDoc(helixDoc({ ...VALID, mode: 'nope' }))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.field).toBe('features[0].helix.mode')
    }
  })

  it('rejects a bad hand and a bad direction', () => {
    const hand = loadPartDoc(helixDoc({ ...VALID, hand: 'up' }))
    expect(hand.ok).toBe(false)
    if (!hand.ok) expect(hand.error.field).toBe('features[0].helix.hand')
    const dir = loadPartDoc(helixDoc({ ...VALID, direction: 'sideways' }))
    expect(dir.ok).toBe(false)
    if (!dir.ok) expect(dir.error.field).toBe('features[0].helix.direction')
  })

  it('rejects a literal helix_angle of 95', () => {
    const result = loadPartDoc(helixDoc({ ...VALID, helix_angle: 95 }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.field).toBe('features[0].helix.helix_angle')
  })
})
