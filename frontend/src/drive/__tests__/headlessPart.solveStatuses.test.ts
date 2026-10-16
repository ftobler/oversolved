// @vitest-environment node
//
// `solveStatuses()` is the only per-feature solve verdict the repro test can
// compare against a recorded sidecar, so its contract (last settle wins, only
// string verdicts published) is pinned directly here with a fake response
// instead of depending on a real kernel run.

import { describe, it, expect, vi } from 'vitest'

vi.mock('@/kernel/solveLocally', async importOriginal => {
  const actual = await importOriginal<typeof import('@/kernel/solveLocally')>()
  return {
    ...actual,
    solveLocally: vi.fn(async () => ({
      solve_ms: 1,
      result: {
        sk1: { status: 'underconstrained' },
        sk2: { status: 'overconstrained' },
        noStatus: { geometry: {} },
        nullFeature: null,
      },
      bodies: {},
    })),
  }
})

import { createHeadlessPart } from '../headlessPart'
import type { PartDoc } from '@/types/cad'

function emptyDoc(): PartDoc {
  return { version: 1, kind: 'part', features: [] } as PartDoc
}

describe('headlessPart.solveStatuses', () => {
  it('publishes the last settle status per feature and skips non-string verdicts', async () => {
    const part = createHeadlessPart({ doc: emptyDoc() })
    const outcome = await part.run([
      { mutation: { type: 'add_sketch', featureId: 'sk1', label: 'Rectangle' } },
    ])
    expect(outcome.ok).toBe(true)
    expect(part.solveStatuses()).toEqual({
      sk1: 'underconstrained',
      sk2: 'overconstrained',
    })
  })
})
