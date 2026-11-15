// @vitest-environment node
//
// The material filter of `splitSolids` (features/bodySplit.ts): body creation
// drops a solid with no material in it, so a boolean's zero-volume debris never
// becomes a phantom part. The case is real (robustness-fuzz seed 990: an OCCT 8
// corner cut leaves a flat zero-volume skin beside the result; pinned by
// testing/robustnessFuzz/regressions/seed-990-minimal.json), but the OCC build
// throws while BUILDING a degenerate shape, so the filter is driven here with
// the OCC reads stubbed, the same seam bodySplitOrderRefusal uses.

import { describe, it, expect, vi } from 'vitest'

vi.mock('../../occ/booleans', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../occ/booleans')>()
  return { ...actual, exploreSolids: vi.fn(), volumeOf: vi.fn() }
})
// The two-survivor cases reach the sibling ORDER, which reads a centroid and
// the parent frame; that is bodySplitOrderRefusal's subject, so stub it here.
vi.mock('../../occ/primitives', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../occ/primitives')>()
  return { ...actual, solidCentroid: vi.fn() }
})
vi.mock('../../occ/constructionLineage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../occ/constructionLineage')>()
  return { ...actual, shapeNormalFrame: vi.fn() }
})

import { splitSolids } from '../bodySplit'
import { exploreSolids, volumeOf } from '../../occ/booleans'
import { solidCentroid } from '../../occ/primitives'
import { shapeNormalFrame } from '../../occ/constructionLineage'
import { DisposeScope } from '../../occ/disposeScope'
import type { OccShape } from '../../occ/occTypes'

const noOc = {} as unknown as Parameters<typeof splitSolids>[0]
const noShape = {} as unknown as Parameters<typeof splitSolids>[2]

/** Solid placeholders whose volumes read as `volumes`; returns the placeholders. */
function stubSolids(volumes: number[]): OccShape[] {
  const items = volumes.map(() => ({}) as OccShape)
  vi.mocked(exploreSolids).mockReturnValue(items)
  vi.mocked(volumeOf).mockImplementation((_oc, _scope, solid) => volumes[items.indexOf(solid as OccShape)])
  vi.mocked(solidCentroid).mockImplementation((_oc, _scope, solid) => [items.indexOf(solid as OccShape), 0, 0])
  vi.mocked(shapeNormalFrame).mockReturnValue({ centre: [0, 0, 0], span: 1 })
  return items
}

/** How many solids survive the filter for these two volumes. */
function kept(a: number, b: number): number {
  stubSolids([a, b])
  return splitSolids(noOc, new DisposeScope(), noShape).length
}

describe('bodySplit: material-free solids', () => {
  it('drops a zero-volume sibling and keeps the body with material', () => {
    const [real, skin] = stubSolids([1000, 0])
    expect(splitSolids(noOc, new DisposeScope(), noShape)).toEqual([real])
    expect(splitSolids(noOc, new DisposeScope(), noShape)).not.toContain(skin)
  })

  it('drops a fragment under the degenerate rung and keeps one above it', () => {
    expect(kept(1000, 0)).toBe(1)
    expect(kept(1000, 1e-7)).toBe(1)  // 1e-10 of the body, under the 1e-9 rung
    expect(kept(1000, 1e-5)).toBe(2)  // 1e-8 of the body, above the rung
  })

  it('uses a relative budget, so a 1000x copy is judged the same way', () => {
    expect(kept(1, 1e-10)).toBe(1)
    expect(kept(1000, 1e-7)).toBe(1)
    expect(kept(1, 1e-8)).toBe(2)
    expect(kept(1000, 1e-5)).toBe(2)
  })

  it('keeps a lone solid even when its volume is tiny: it is its own material', () => {
    const [tiny] = stubSolids([1e-12])
    expect(splitSolids(noOc, new DisposeScope(), noShape)).toEqual([tiny])
  })

  it('keeps a shape that reads no material at all: an open shell is a body', () => {
    // An open-shell body integrates to zero under volumeOf's OnlyClosed read
    // (L5, an imported surface body); zero volume alone is not debris.
    const [shell, face] = stubSolids([0, 0])
    expect(splitSolids(noOc, new DisposeScope(), noShape)).toEqual([shell, face])
  })

  it('refuses a non-finite volume read instead of dropping the solid', () => {
    stubSolids([1000, Number.NaN])
    expect(() => splitSolids(noOc, new DisposeScope(), noShape)).toThrow(/volume read failed/)
  })
})
