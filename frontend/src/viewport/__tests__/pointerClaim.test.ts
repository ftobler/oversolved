// A press that lands on a handle owns its pointer for the whole gesture. The
// claim is what lets the camera controller refuse that pointer synchronously,
// before React can commit the store gate.
import { describe, it, expect } from 'vitest'
import { createPointerClaims } from '@/viewport/pointerClaim'

describe('pointer claims', () => {
  it('round-trips claim and release', () => {
    const claims = createPointerClaims()
    expect(claims.isClaimed(7)).toBe(false)
    expect(claims.anyClaimed()).toBe(false)

    claims.claim(7)
    expect(claims.isClaimed(7)).toBe(true)
    expect(claims.isClaimed(8)).toBe(false)
    expect(claims.anyClaimed()).toBe(true)

    claims.release(7)
    expect(claims.isClaimed(7)).toBe(false)
    expect(claims.anyClaimed()).toBe(false)
  })

  it('clears every claim at once', () => {
    const claims = createPointerClaims()
    claims.claim(1)
    claims.claim(2)
    claims.clear()
    expect(claims.anyClaimed()).toBe(false)
  })

  it('releases an unclaimed id without touching the others', () => {
    const claims = createPointerClaims()
    claims.claim(1)
    claims.release(2)
    expect(claims.isClaimed(1)).toBe(true)
  })

  it('keeps each registry independent', () => {
    // Two viewports must never share claims: a handle press in one pane cannot
    // freeze the other pane's camera.
    const part = createPointerClaims()
    const assembly = createPointerClaims()
    part.claim(3)
    expect(part.isClaimed(3)).toBe(true)
    expect(assembly.isClaimed(3)).toBe(false)
  })
})
