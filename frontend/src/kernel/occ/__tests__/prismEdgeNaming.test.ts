// @vitest-environment node
//
// The production warn in derivePrismEdgeNames (prismEdgeNaming.ts): an edge
// whose adjacent faces all stayed unnamed (unrescued topology) or that touches
// more than two named faces (non-manifold) would otherwise collapse onto the
// body-wide ancestral query in silence. failLoud throws in test mode and warns
// only in dev, so the guard pairs it with an explicit production-visible
// `if (!isDevBuild()) console.warn(message)`. vitest cannot flip
// import.meta.env.DEV and the real failLoud throws in test mode, so both are
// mocked to the production answer to exercise that warn directly.

import { describe, it, expect, vi } from 'vitest'

const { failLoudMock } = vi.hoisted(() => ({ failLoudMock: vi.fn() }))

vi.mock('@/utils/invariants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/invariants')>()
  return { ...actual, failLoud: failLoudMock }
})

vi.mock('@/kernel/isDevBuild', () => ({
  isDevBuild: () => false,
  isDevOrTestBuild: () => false,
}))

import { derivePrismEdgeNames } from '../prismEdgeNaming'
import type { OccModule, OccShape } from '../occTypes'
import type { DisposeScope } from '../disposeScope'

describe('derivePrismEdgeNames production warn', () => {
  it('warns when an edge has no nameable face pair (unrescued topology) in production', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      // One solid edge whose two adjacent faces both stayed unnamed after the
      // neighbour pass: 0 distinct named adjacent faces -> the else branch. The
      // ordering passes never run (no pair or seam groups), so oc/scope/solid
      // and the edge-shape table are all unused and can stay undefined.
      const adjacency: Record<string, Set<string>> = { egh0: new Set(['f0', 'f1']) }
      const { edgeNames } = derivePrismEdgeNames(
        undefined as unknown as OccModule,
        undefined as unknown as DisposeScope,
        undefined as unknown as OccShape,
        adjacency,
        {},
        {},
        {},
        'feat',
      )
      expect(edgeNames).toEqual({})
      const message =
        '[prismLineage] edge has 0 distinct named adjacent faces ' +
        '(expected 1 or 2): non-manifold or unrescued topology (feat)'
      expect(warn).toHaveBeenCalledWith(message)
      expect(failLoudMock).toHaveBeenCalledWith(message)
    } finally {
      warn.mockRestore()
    }
  })
})
