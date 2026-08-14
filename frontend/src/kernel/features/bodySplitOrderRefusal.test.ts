// @vitest-environment node
//
// The refusal contract of `orderSolids` (features/bodySplit.ts), driven through
// `splitSolids` with the three OCC reads stubbed. A NaN ordering key (a
// centroid the kernel failed to read) and a genuine near-tie both fail the
// solve, but with distinct messages: the first is a geometry failure with no
// fix, the second is an ambiguous split the user can nudge. The stub exists
// because opencascade.js throws while BUILDING a degenerate shape (a zero-size
// box dies inside BRepPrimAPI_MakeBox), so a NaN centroid is not reachable
// through real geometry.

import { describe, it, expect, vi } from 'vitest'
import type { Vec3 } from '../occ/primitives'

vi.mock('../occ/primitives', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../occ/primitives')>()
  return { ...actual, solidCentroid: vi.fn() }
})
vi.mock('../occ/booleans', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../occ/booleans')>()
  return { ...actual, exploreSolids: vi.fn() }
})
vi.mock('../occ/constructionLineage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../occ/constructionLineage')>()
  return { ...actual, shapeNormalFrame: vi.fn() }
})

import { splitSolids } from './bodySplit'
import { solidCentroid } from '../occ/primitives'
import { exploreSolids } from '../occ/booleans'
import { shapeNormalFrame } from '../occ/constructionLineage'
import { DisposeScope } from '../occ/disposeScope'
import { SPLIT_EPS } from '../constructionName'
import type { OccShape } from '../occ/occTypes'

describe('bodySplit: orderSolids refusal messages', () => {
  // Give the split two solid placeholders whose centroids read as `centroids`.
  function stubSplit(centroids: Vec3[]): void {
    const items = centroids.map(() => ({}) as OccShape)
    vi.mocked(exploreSolids).mockReturnValue(items)
    vi.mocked(solidCentroid).mockImplementation((_oc, _scope, solid) => centroids[items.indexOf(solid)])
    vi.mocked(shapeNormalFrame).mockReturnValue({ centre: [0, 0, 0], span: 1 })
  }

  const noOc = {} as unknown as Parameters<typeof splitSolids>[0]
  const noShape = {} as unknown as Parameters<typeof splitSolids>[2]

  it('a NaN centroid throws the geometry-read message, not the near-tie message', () => {
    stubSplit([[0, 0, 0], [Number.NaN, 0, 0]])
    expect(() => splitSolids(noOc, new DisposeScope(), noShape)).toThrow(/centroid read failed/)
    expect(() => splitSolids(noOc, new DisposeScope(), noShape)).not.toThrow(/near-tie/)
  })

  it('a genuine near-tie still throws the near-tie message', () => {
    stubSplit([[0.5, 0, 0], [0.5 + SPLIT_EPS / 2, 0, 0]])
    expect(() => splitSolids(noOc, new DisposeScope(), noShape)).toThrow(/near-tie/)
    expect(() => splitSolids(noOc, new DisposeScope(), noShape)).not.toThrow(/centroid read failed/)
  })
})
