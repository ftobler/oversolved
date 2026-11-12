// The heartbeat that splits a long feature's kernel phases: `markFeatureProgress`
// re-emits the feature `build()` announced, and does nothing outside a build.
// The host side (a mark re-arms the stall timer) is pinned in
// drive/__tests__/kernelHost.test.ts; together they are the rule "30 s inside
// one kernel operation" rather than "30 s inside one feature".

import { describe, it, expect, afterEach } from 'vitest'
import {
  clearFeatureProgress,
  markFeatureProgress,
  markFeatureStart,
  onFeatureStart,
} from '../featureProgress'

describe('feature progress heartbeat', () => {
  let unsubscribe: (() => void) | null = null
  afterEach(() => {
    unsubscribe?.()
    unsubscribe = null
    clearFeatureProgress()
  })

  it('does nothing when no build has announced a feature', () => {
    clearFeatureProgress()
    const seen: string[] = []
    unsubscribe = onFeatureStart((id) => seen.push(id))
    markFeatureProgress()
    expect(seen).toEqual([])
  })

  it('re-emits the current feature without changing it', () => {
    const seen: string[] = []
    unsubscribe = onFeatureStart((id) => seen.push(id))
    markFeatureStart('paa')
    markFeatureProgress()
    markFeatureProgress()
    expect(seen).toEqual(['paa', 'paa', 'paa'])
  })

  it('follows the latest feature the build announced', () => {
    const seen: string[] = []
    unsubscribe = onFeatureStart((id) => seen.push(id))
    markFeatureStart('ex1')
    markFeatureStart('paa')
    markFeatureProgress()
    expect(seen).toEqual(['ex1', 'paa', 'paa'])
  })

  it('stops re-emitting once the build clears it', () => {
    const seen: string[] = []
    unsubscribe = onFeatureStart((id) => seen.push(id))
    markFeatureStart('paa')
    clearFeatureProgress()
    markFeatureProgress()
    expect(seen).toEqual(['paa'])
  })
})
