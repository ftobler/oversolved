// The chain watchdog pool's contract, pinned with fake children: a done reply
// settles its recipe, a hang kills only its own child and leaves a sibling in
// flight, a queued recipe's clock starts at dispatch, zombie events from a
// killed child are ignored, and a crash or a dispose rejects exactly the
// recipes involved.

import { describe, it, expect, afterEach } from 'vitest'
import {
  runChainWithTimeout,
  disposeChainChild,
  setChainChildForTest,
  configureChainWorkers,
  resetChainChildForTest,
  type ChainChildLike,
} from './chainTimeout'
import type { ChainRun } from './chain'
import type { Recipe } from './recipe'

interface FakeChild {
  child: ChainChildLike
  sent: { id: number; recipe: Recipe }[]
  killed: boolean
  reply(msg: Record<string, unknown>): void
  exit(code: number): void
}

function makeFakeChild(): FakeChild {
  const messageCbs: ((msg: unknown) => void)[] = []
  const errorCbs: ((e: unknown) => void)[] = []
  const exitCbs: ((code: number) => void)[] = []
  const sent: { id: number; recipe: Recipe }[] = []
  let killed = false
  const child = {
    send(msg: Record<string, unknown>) { sent.push(msg as { id: number; recipe: Recipe }) },
    on(event: string, cb: (arg: unknown) => void) {
      if (event === 'message') messageCbs.push(cb)
      else if (event === 'error') errorCbs.push(cb)
      else exitCbs.push(cb as (code: number) => void)
    },
    kill() { killed = true },
  } as unknown as ChainChildLike
  return {
    child,
    sent,
    get killed() { return killed },
    reply(msg) { for (const cb of messageCbs) cb(msg) },
    exit(code) { for (const cb of exitCbs) cb(code) },
  }
}

const recipe: Recipe = { seed: 0, steps: [] }
const doneRun: ChainRun = {
  violations: [], reports: [], refusals: [], picks: [], stalePicks: [], completed: true,
}

describe('the chain watchdog pool', () => {
  let fakes: FakeChild[]

  function installPool(): void {
    fakes = []
    setChainChildForTest(() => {
      const fake = makeFakeChild()
      fakes.push(fake)
      return fake.child
    })
  }

  afterEach(() => {
    // resetChainChildForTest also restores the default pool bound.
    resetChainChildForTest()
  })

  it('resolves a done replay from the child reply, with the run and stale list', async () => {
    installPool()
    const pending = runChainWithTimeout(recipe, { timeoutMs: 1000 })
    expect(fakes).toHaveLength(1)
    expect(fakes[0].sent).toHaveLength(1)
    fakes[0].reply({ id: fakes[0].sent[0].id, progress: { step: 0, kind: 'start' } })
    fakes[0].reply({ id: fakes[0].sent[0].id, ok: true, run: doneRun, stale: [] })
    const result = await pending
    expect(result).toEqual({ status: 'done', replay: { run: doneRun, stale: [] } })
  })

  it('kills only the hung child and leaves its sibling in flight', async () => {
    installPool()
    const hung = runChainWithTimeout(recipe, { timeoutMs: 30 })
    const healthy = runChainWithTimeout(recipe, { timeoutMs: 1000 })
    expect(fakes).toHaveLength(2)
    fakes[0].reply({ id: fakes[0].sent[0].id, progress: { step: 2, kind: 'mirror' } })
    expect(await hung).toEqual({ status: 'hang', hang: { step: 2, kind: 'mirror' } })
    expect(fakes[0].killed).toBe(true)
    expect(fakes[1].killed).toBe(false)
    fakes[1].reply({ id: fakes[1].sent[0].id, ok: true, run: doneRun, stale: [] })
    expect((await healthy).status).toBe('done')
  })

  it('starts a queued recipe timeout only when a child picks it up', async () => {
    installPool()
    configureChainWorkers(1)
    const first = runChainWithTimeout(recipe, { timeoutMs: 250 })
    const queued = runChainWithTimeout(recipe, { timeoutMs: 100 })
    expect(fakes).toHaveLength(1)
    expect(fakes[0].sent).toHaveLength(1)
    expect((await first).status).toBe('hang')
    // The queued recipe went to a fresh child now. Had its clock been armed at
    // enqueue, it would have expired during the wait above.
    expect(fakes).toHaveLength(2)
    fakes[1].reply({ id: fakes[1].sent[0].id, ok: true, run: doneRun, stale: [] })
    expect((await queued).status).toBe('done')
  })

  it('ignores a killed child zombie reply instead of settling its replacement', async () => {
    installPool()
    configureChainWorkers(1)
    const first = runChainWithTimeout(recipe, { timeoutMs: 30 })
    const second = runChainWithTimeout(recipe, { timeoutMs: 1000 })
    const zombieId = fakes[0].sent[0].id
    expect((await first).status).toBe('hang')
    expect(fakes).toHaveLength(2)
    fakes[0].reply({ id: zombieId, ok: true, run: doneRun, stale: [] })
    let settled = false
    void second.then(() => { settled = true })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(settled).toBe(false)
    fakes[1].reply({ id: fakes[1].sent[0].id, ok: true, run: doneRun, stale: [] })
    expect((await second).status).toBe('done')
  })

  it('rejects the in-flight recipe when its child exits', async () => {
    installPool()
    const pending = runChainWithTimeout(recipe, { timeoutMs: 1000 })
    const rejects = expect(pending).rejects.toThrow(/exited with code 1/)
    fakes[0].exit(1)
    await rejects
  })

  it('replaces a crashed child for a queued recipe', async () => {
    installPool()
    configureChainWorkers(1)
    const first = runChainWithTimeout(recipe, { timeoutMs: 1000 })
    const queued = runChainWithTimeout(recipe, { timeoutMs: 1000 })
    expect(fakes).toHaveLength(1)
    const firstRejects = expect(first).rejects.toThrow(/exited with code 1/)
    fakes[0].exit(1)
    await firstRejects
    // The crash freed the single slot, so the queued recipe must have been
    // dispatched to a fresh child instead of waiting for a slot forever.
    expect(fakes).toHaveLength(2)
    fakes[1].reply({ id: fakes[1].sent[0].id, ok: true, run: doneRun, stale: [] })
    expect((await queued).status).toBe('done')
  })

  it('dispose rejects the in-flight and queued recipes and kills every child', async () => {
    installPool()
    configureChainWorkers(1)
    const inFlight = runChainWithTimeout(recipe, { timeoutMs: 1000 })
    const queued = runChainWithTimeout(recipe, { timeoutMs: 1000 })
    const inFlightRejects = expect(inFlight).rejects.toThrow(/disposed/)
    const queuedRejects = expect(queued).rejects.toThrow(/disposed/)
    disposeChainChild()
    await inFlightRejects
    await queuedRejects
    expect(fakes.every((fake) => fake.killed)).toBe(true)
  })
})
