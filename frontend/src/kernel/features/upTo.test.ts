// Pure tests for up-to terminator resolution + distance (feature: extrude-up-to).
// The plane / point branches of resolveUpToPlane do not touch OCC, so oc/scope/
// table are unused here and passed as null.

import { describe, it, expect } from 'vitest'
import { resolveUpToPlane, upToDistance, orientToTarget, type CutPlane } from './upTo'
import type { Repository } from '../query'
import type { OccModule } from '../occ/occTypes'
import type { DisposeScope } from '../occ/disposeScope'
import type { HandleTable } from '../occ/handleTable'

function repoReturning(entry: unknown): Repository {
  return { query: () => entry } as unknown as Repository
}

const noOcc = null as unknown as OccModule
const noScope = null as unknown as DisposeScope
const noTable = null as unknown as HandleTable

describe('resolveUpToPlane', () => {
  it('resolves a registered plane / flatface to origin + normal', () => {
    const repo = repoReturning({ origin: [0, 0, 7], normal: [0, 0, 1] })
    const cut = resolveUpToPlane(noOcc, noScope, noTable, 'q', [0, 0, 1], repo, {})
    expect(cut).toEqual({ origin: [0, 0, 7], normal: [0, 0, 1] })
  })

  it('resolves a point to a plane perpendicular to the extrude direction', () => {
    const repo = repoReturning({ point: [1, 2, 4] })
    const cut = resolveUpToPlane(noOcc, noScope, noTable, 'q', [0, 0, 1], repo, {})
    expect(cut).toEqual({ origin: [1, 2, 4], normal: [0, 0, 1] })
  })

  it('returns null for an unresolved ref', () => {
    expect(resolveUpToPlane(noOcc, noScope, noTable, 'q', [0, 0, 1], repoReturning(null), {})).toBeNull()
    expect(resolveUpToPlane(noOcc, noScope, noTable, '', [0, 0, 1], repoReturning({ normal: [0, 0, 1], origin: [0, 0, 1] }), {})).toBeNull()
  })

  it('normalizes the plane normal', () => {
    const repo = repoReturning({ origin: [0, 0, 0], normal: [0, 0, 5] })
    const cut = resolveUpToPlane(noOcc, noScope, noTable, 'q', [0, 0, 1], repo, {})
    expect(cut!.normal).toEqual([0, 0, 1])
  })
})

describe('upToDistance', () => {
  it('is the signed distance to the plane along the direction', () => {
    expect(upToDistance({ origin: [0, 0, 7], normal: [0, 0, 1] }, [0, 0, 0], [0, 0, 1])).toBeCloseTo(7)
    expect(upToDistance({ origin: [0, 0, -5], normal: [0, 0, 1] }, [0, 0, 0], [0, 0, 1])).toBeCloseTo(-5)
  })
})

describe('orientToTarget', () => {
  const zPlane = (z: number): CutPlane => ({ origin: [0, 0, z], normal: [0, 0, 1] })

  // Componentwise, because negating a zero component yields -0.
  function expectDir(actual: number[], expected: number[]): void {
    for (let i = 0; i < 3; i++) expect(actual[i]).toBeCloseTo(expected[i])
  }

  it('keeps the direction when the target is ahead', () => {
    expectDir(orientToTarget(zPlane(7), [0, 0, 0], [0, 0, 1]), [0, 0, 1])
  })

  it('reverses the direction when the target is behind', () => {
    expectDir(orientToTarget(zPlane(-5), [0, 0, 0], [0, 0, 1]), [0, 0, -1])
  })

  it('reverses a reversed direction back when the target is ahead of the profile', () => {
    expectDir(orientToTarget(zPlane(7), [0, 0, 0], [0, 0, -1]), [0, 0, 1])
  })

  it('works for an oblique direction and a tilted plane', () => {
    const s = Math.SQRT1_2
    const cut: CutPlane = { origin: [0, 0, -3], normal: [0, -s, s] }
    expectDir(orientToTarget(cut, [0, 0, 0], [0, s, s]), [0, -s, -s])
  })

  it('throws when the target passes through the profile', () => {
    expect(() => orientToTarget(zPlane(0), [0, 0, 0], [0, 0, 1])).toThrow(/no distance to extrude/)
  })
})
