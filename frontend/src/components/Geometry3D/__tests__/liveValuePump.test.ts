import { describe, it, expect, vi, afterEach } from 'vitest'
import { createLiveValuePump } from '@/components/Geometry3D/liveValuePump'

/**
 * The newest-value pump in front of a feature-handle drag: one solve in
 * flight, every later pointer move only replaces the waiting value, and a move
 * back to the in-flight value drops the stale wait. Deferred sends make the
 * settling order explicit; a real solver would only make the timing harder to
 * read, not the contract different.
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
  await Promise.resolve()
}

afterEach(() => {
  vi.restoreAllMocks()
})

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

  it('drops the waiting value when the pointer offers the in-flight one again', async () => {
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
    // The pointer came back to the value the solve is already building: the
    // stale 3 must not rebuild the body after it settles.
    pump.offer(1)

    gates[0].resolve()
    await tick()
    expect(sent).toEqual([1])
  })

  it('does not re-send the value that is already sent', async () => {
    const sent: number[] = []
    const gates: Array<ReturnType<typeof deferred>> = []
    const pump = createLiveValuePump(v => {
      sent.push(v)
      const gate = deferred()
      gates.push(gate)
      return gate.promise
    })

    pump.offer(1)
    gates[0].resolve()
    await tick()
    pump.offer(1)
    await tick()
    expect(sent).toEqual([1])
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

  it('keeps pumping after a rejected send', async () => {
    const sent: number[] = []
    const pump = createLiveValuePump(v => {
      sent.push(v)
      return v === 1 ? Promise.reject(new Error('solve failed')) : Promise.resolve()
    })

    pump.offer(1)
    await tick()
    pump.offer(2)
    await tick()
    expect(sent).toEqual([1, 2])
  })

  it('surfaces a throwing send once and keeps pumping', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const sent: number[] = []
    let calls = 0
    const pump = createLiveValuePump(v => {
      sent.push(v)
      calls += 1
      if (calls <= 2) throw new Error('onMutation threw')
      return Promise.resolve()
    })

    expect(() => pump.offer(1)).not.toThrow()
    pump.offer(2)
    await tick()
    pump.offer(3)
    await tick()

    expect(sent).toEqual([1, 2, 3])
    expect(error).toHaveBeenCalledTimes(1)
  })

  it('treats a non-promise send as settled at once', async () => {
    const sent: number[] = []
    const pump = createLiveValuePump(v => { sent.push(v) })

    pump.offer(1)
    pump.offer(2)
    await tick()
    expect(sent).toEqual([1, 2])
  })
})
