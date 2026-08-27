import { describe, it, expect } from 'vitest'
import { missClearsNormalSelection } from '@/components/Viewport/emptyClickClear'

describe('missClearsNormalSelection', () => {
  it('clears on a stationary primary click that hit nothing', () => {
    expect(missClearsNormalSelection({
      clickConsumedByIdDispatch: false,
      clickWasStaleResolve: false,
      bandDragging: false,
      stationaryPrimaryClick: true,
    })).toBe(true)
  })

  it('does not clear when the id dispatcher consumed the click', () => {
    expect(missClearsNormalSelection({
      clickConsumedByIdDispatch: true,
      clickWasStaleResolve: false,
      bandDragging: false,
      stationaryPrimaryClick: true,
    })).toBe(false)
  })

  it('does not clear when the resolve was stale', () => {
    expect(missClearsNormalSelection({
      clickConsumedByIdDispatch: false,
      clickWasStaleResolve: true,
      bandDragging: false,
      stationaryPrimaryClick: true,
    })).toBe(false)
  })

  it('does not clear while a rubber band is open', () => {
    expect(missClearsNormalSelection({
      clickConsumedByIdDispatch: false,
      clickWasStaleResolve: false,
      bandDragging: true,
      stationaryPrimaryClick: true,
    })).toBe(false)
  })

  it('does not clear for a gesture that travelled', () => {
    expect(missClearsNormalSelection({
      clickConsumedByIdDispatch: false,
      clickWasStaleResolve: false,
      bandDragging: false,
      stationaryPrimaryClick: false,
    })).toBe(false)
  })

  it('does not clear for a right-button gesture', () => {
    expect(missClearsNormalSelection({
      clickConsumedByIdDispatch: false,
      clickWasStaleResolve: false,
      bandDragging: false,
      stationaryPrimaryClick: false,
    })).toBe(false)
  })

  it('each guard alone is sufficient to decline', () => {
    const base = {
      clickConsumedByIdDispatch: false,
      clickWasStaleResolve: false,
      bandDragging: false,
      stationaryPrimaryClick: true,
    }
    const guards = ['clickConsumedByIdDispatch', 'clickWasStaleResolve', 'bandDragging'] as const
    for (const g of guards) {
      expect(missClearsNormalSelection({ ...base, [g]: true })).toBe(false)
    }
  })
})
