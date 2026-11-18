// phaseTimer is wired into the production import and render path, so the off
// state must be a pure pass-through and the on state must charge every call.

import { describe, it, expect, afterEach } from 'vitest'
import { startPhaseTiming, stopPhaseTiming, timePhase } from '../phaseTimer'

afterEach(() => {
  stopPhaseTiming()
})

describe('phaseTimer', () => {
  it('passes the result through and records nothing while off', () => {
    expect(timePhase('a', () => 42)).toBe(42)
    startPhaseTiming()
    expect(stopPhaseTiming().size).toBe(0)
  })

  it('charges calls and time per name, nested phases included', () => {
    startPhaseTiming()
    timePhase('outer', () => {
      timePhase('inner', () => 1)
      timePhase('inner', () => 2)
    })
    const totals = stopPhaseTiming()
    expect([...totals.keys()]).toEqual(['inner', 'outer'])
    expect(totals.get('inner')?.calls).toBe(2)
    expect(totals.get('outer')?.calls).toBe(1)
    expect(totals.get('outer')!.ms).toBeGreaterThanOrEqual(totals.get('inner')!.ms)
  })

  it('records a phase that throws, and rethrows', () => {
    startPhaseTiming()
    expect(() => timePhase('boom', () => { throw new Error('x') })).toThrow('x')
    expect(stopPhaseTiming().get('boom')?.calls).toBe(1)
  })

  it('drops a phase that stopped timing inside itself', () => {
    startPhaseTiming()
    let inner = new Map()
    timePhase('self-stop', () => { inner = stopPhaseTiming() })
    expect(inner.size).toBe(0)
    expect(stopPhaseTiming().size).toBe(0)
  })

  it('starts each run empty', () => {
    startPhaseTiming()
    timePhase('old', () => 0)
    startPhaseTiming()
    expect(stopPhaseTiming().has('old')).toBe(false)
  })
})
