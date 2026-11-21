import { describe, it, expect } from 'vitest'
import { createLiveValuePump } from '@/components/Geometry3D/liveValuePump'

/**
 * The newest-value pump in front of a feature-handle drag: one solve in
 * flight, every later pointer move only replaces the waiting value, and the
 * release (or a flush) is sent once the in-flight one settles. Deferred sends
 * make the settling order explicit; a real solver would only make the timing
 * harder to read, not the contract different.
 */

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>(r => { resolve = r })
  return { promise, resolve }
}

/** Flush pending microtasks, so a settled send's continuation has run. */
async function tick(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('createLiveValuePump', () => {
  it('sends the first value at once and only the newest waiting one when it settles', async () => {
    const sent: number[] = []
    const gates: Array<ReturnType<typeof deferred>> = []
    const pump = createLiveValuePump(v => {
      sent.push(v)
      const gate = deferred()
      gates.push(gate)
      return gate.promise
    })

    pump.offer(1)
    expect(sent).toEqual([1])

    pump.offer(2)
    pump.offer(3)
    expect(sent).toEqual([1])

    gates[0].resolve()
    await tick()
    expect(sent).toEqual([1, 3])
  })

  it('does not re-send the value that is already sent or in flight', async () => {
    const sent: number[] = []
    const gates: Array<ReturnType<typeof deferred>> = []
    const pump = createLiveValuePump(v => {
      sent.push(v)
      const gate = deferred()
      gates.push(gate)
      return gate.promise
    })

    pump.offer(1)
    pump.offer(1)
    gates[0].resolve()
    await tick()
    expect(sent).toEqual([1])
  })

  it('sends the flush value after the in-flight one and resolves once it settles', async () => {
    const sent: number[] = []
    const gates: Array<ReturnType<typeof deferred>> = []
    const pump = createLiveValuePump(v => {
      sent.push(v)
      const gate = deferred()
      gates.push(gate)
      return gate.promise
    })

    pump.offer(1)
    pump.offer(3)
    let flushed = false
    const flush = pump.flush(5).then(() => { flushed = true })

    gates[0].resolve()
    await tick()
    expect(sent).toEqual([1, 5])
    expect(flushed).toBe(false)

    gates[1].resolve()
    await flush
    expect(flushed).toBe(true)
  })

  it('a flush equal to the last sent value sends nothing and resolves after it settles', async () => {
    const sent: number[] = []
    const gates: Array<ReturnType<typeof deferred>> = []
    const pump = createLiveValuePump(v => {
      sent.push(v)
      const gate = deferred()
      gates.push(gate)
      return gate.promise
    })

    pump.offer(7)
    let flushed = false
    const flush = pump.flush(7).then(() => { flushed = true })
    expect(flushed).toBe(false)

    gates[0].resolve()
    await flush
    expect(sent).toEqual([7])
  })

  it('sends nothing after cancel even when the in-flight value settles', async () => {
    const sent: number[] = []
    const gates: Array<ReturnType<typeof deferred>> = []
    const pump = createLiveValuePump(v => {
      sent.push(v)
      const gate = deferred()
      gates.push(gate)
      return gate.promise
    })

    pump.offer(1)
    pump.offer(2)
    pump.cancel()
    gates[0].resolve()
    await tick()
    expect(sent).toEqual([1])
  })
})
