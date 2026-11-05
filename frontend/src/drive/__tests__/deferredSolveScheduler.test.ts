// @vitest-environment node
//
// The headless run's solve deferral: `request` records the one solve owed and
// `flush` spends it through the base scheduler. A queued request resolves
// 'queued', a later request replaces an earlier one, and generation counts
// flushes rather than requests.

import { describe, it, expect } from 'vitest'
import type { SolveOptions, SolveOutcome, SolveScheduler, SolveSchedulerState } from '@/session/SolveScheduler'
import { createDeferredSolveScheduler } from '../deferredSolveScheduler'

interface RecordingScheduler {
  scheduler: SolveScheduler<string>
  docs: { doc: string; opts: SolveOptions | undefined }[]
  idles: number
}

function recordingScheduler(): RecordingScheduler {
  const docs: { doc: string; opts: SolveOptions | undefined }[] = []
  let idles = 0
  let generation = 0
  let lastError: string | null = null
  const scheduler: SolveScheduler<string> = {
    async request(doc, opts): Promise<SolveOutcome> {
      docs.push({ doc, opts })
      lastError = null
      generation += 1
      return { generation, status: 'applied' }
    },
    async idle(): Promise<void> {
      idles += 1
    },
    state(): SolveSchedulerState {
      return { generation, pending: false, running: false, lastError }
    },
  }
  return { scheduler, docs, get idles() { return idles } }
}

describe('createDeferredSolveScheduler', () => {
  it('queues a request and spends it only on flush', async () => {
    const base = recordingScheduler()
    const solve = createDeferredSolveScheduler(base.scheduler)
    const outcome = await solve.request('first', { bypassCache: true })
    expect(outcome).toEqual({ generation: 0, status: 'queued' })
    expect(solve.owed()).toBe(true)
    expect(base.docs).toEqual([])

    await solve.flush()
    expect(solve.owed()).toBe(false)
    expect(base.docs).toEqual([{ doc: 'first', opts: { bypassCache: true } }])
    expect(base.idles).toBe(1)
    expect(solve.state().generation).toBe(1)
  })

  it('replaces an owed request so the latest document wins', async () => {
    const base = recordingScheduler()
    const solve = createDeferredSolveScheduler(base.scheduler)
    await solve.request('first')
    await solve.request('second', { validate: true })

    await solve.flush()
    expect(base.docs).toEqual([{ doc: 'second', opts: { validate: true } }])
    expect(base.idles).toBe(1)
  })

  it('flushing with nothing owed is a no-op', async () => {
    const base = recordingScheduler()
    const solve = createDeferredSolveScheduler(base.scheduler)
    await solve.flush()
    expect(base.docs).toEqual([])
    expect(base.idles).toBe(0)
  })

  it('delegates idle and state to the base scheduler', async () => {
    const base = recordingScheduler()
    const solve = createDeferredSolveScheduler(base.scheduler)
    await solve.request('doc')
    // A queued request is not pending: idle resolves without solving, which is
    // what lets the run loop defer.
    await solve.idle()
    expect(base.docs).toEqual([])
    expect(solve.state()).toEqual(base.scheduler.state())
    expect(solve.state().pending).toBe(false)
  })
})
