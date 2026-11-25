/**
 * A running solve is asked to stop when a newer solve is submitted: the Actor
 * marks its context superseded, the engine checks it at the next feature
 * boundary, and the request is answered SUPERSEDED_ERROR while the finished
 * checkpoints become the next solve's prevState. Exports and other one-shot
 * jobs neither ask a solve to stop nor are asked themselves.
 *
 * The engine here is a fake with the production engine's shape around the real
 * builder stepper (fake deps, no OCC), so the Actor, the request handler and
 * the abortable build are exercised together.
 */
import { describe, it, expect } from 'vitest'
import { WorkerActor, handleSolveRequest, type ActorJob, type ActorJobContext } from '../solverWorker'
import { SUPERSEDED_ERROR, type SolveRequest, type SolveResponse } from '../solverProtocol'
import { build, buildAbortable } from '../../builder'
import { makeTrackerDeps } from '../../builderTestUtils'
import { SolveSuperseded } from '../../errors'
import { nextMacrotask } from '../../nextMacrotask'
import type { BuildState } from '../../types3d'
import type { solveLocally } from '../../solveLocally'

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise(resolve => { setTimeout(resolve, 0) })
}

/** A deferred the test resolves by hand. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void
  const promise = new Promise<void>(resolve => { open = resolve })
  return { promise, open }
}

/** solveLocally's contract over the real stepper: one cached state, partial on a stop. */
function fakeEngine(onYield: (count: number) => void) {
  let last: BuildState | null = null
  const prevSeen: Array<BuildState | null> = []
  let yields = 0
  const deps = makeTrackerDeps()
  const engine = async (spec: Record<string, unknown>, options: { shouldAbort?: () => boolean } = {}) => {
    prevSeen.push(last)
    const out = options.shouldAbort
      ? await buildAbortable(spec, { prevState: last }, deps, options.shouldAbort, async () => {
        onYield(++yields)
        await nextMacrotask()
      })
      : build(spec, { prevState: last }, deps)
    if ('aborted' in out) {
      last = out.state
      throw new SolveSuperseded()
    }
    last = out._build_state
    return out
  }
  return { engine: engine as unknown as typeof solveLocally, prevSeen }
}

const spec = (tag: string) => ({
  id: 'doc', features: Array.from({ length: 5 }, (_, i) => ({ id: `f${i}`, kind: 'sketch', tag: i === 4 ? tag : '' })),
})

function solveJob(
  req: SolveRequest,
  engine: typeof solveLocally,
  replies: SolveResponse[],
): ActorJob {
  return {
    lane: 'solve',
    run: async (ctx) => { replies.push(await handleSolveRequest(req, engine, undefined, () => ctx.superseded)) },
    onSuperseded: () => { replies.push({ id: req.id, ok: false, error: SUPERSEDED_ERROR }) },
  }
}

describe('aborting the running solve', () => {
  it('stops solve A at a feature boundary when solve B arrives, and B resumes from its partial state', async () => {
    const actor = new WorkerActor()
    const firstYield = gate()
    const { engine, prevSeen } = fakeEngine((n) => { if (n === 1) firstYield.open() })
    const replies: SolveResponse[] = []

    actor.submit(solveJob({ id: 1, spec: spec('a'), options: {} }, engine, replies))
    await firstYield.promise
    actor.submit(solveJob({ id: 2, spec: spec('b'), options: {} }, engine, replies))
    await settle()

    expect(replies.map((r) => [r.id, r.ok])).toEqual([[1, false], [2, true]])
    expect(replies[0]).toEqual({ id: 1, ok: false, error: SUPERSEDED_ERROR })
    // B saw A's partial state: the full order, only the first feature solved.
    const partial = prevSeen[1]!
    expect(partial.feature_order).toEqual(['f0', 'f1', 'f2', 'f3', 'f4'])
    expect(Object.keys(partial.checkpoints)).toEqual(['f0'])
  })

  it('does not stop a running solve for an export', async () => {
    const actor = new WorkerActor()
    const firstYield = gate()
    const { engine } = fakeEngine((n) => { if (n === 1) firstYield.open() })
    const replies: SolveResponse[] = []
    const log: string[] = []

    actor.submit(solveJob({ id: 1, spec: spec('a'), options: {} }, engine, replies))
    await firstYield.promise
    actor.submit({ lane: null, run: async () => { log.push('export') } })
    await settle()

    expect(replies.map((r) => [r.id, r.ok])).toEqual([[1, true]])
    expect(log).toEqual(['export'])
  })

  it('does not ask a running export to stop for a solve', async () => {
    const actor = new WorkerActor()
    const held = gate()
    const seen: ActorJobContext[] = []
    actor.submit({
      lane: null,
      run: async (ctx) => {
        seen.push(ctx)
        await held.promise
      },
    })
    await settle()
    const { engine } = fakeEngine(() => {})
    const replies: SolveResponse[] = []
    actor.submit(solveJob({ id: 1, spec: spec('a'), options: {} }, engine, replies))
    expect(seen[0].superseded).toBe(false)
    held.open()
    await settle()
    expect(seen[0].superseded).toBe(false)
    expect(replies.map((r) => [r.id, r.ok])).toEqual([[1, true]])
  })

  it('does not stop a running solve for a measure', async () => {
    const actor = new WorkerActor()
    const firstYield = gate()
    const { engine } = fakeEngine((n) => { if (n === 1) firstYield.open() })
    const replies: SolveResponse[] = []

    actor.submit(solveJob({ id: 1, spec: spec('a'), options: {} }, engine, replies))
    await firstYield.promise
    actor.submit({ lane: 'measure', run: async () => {} })
    await settle()

    expect(replies.map((r) => [r.id, r.ok])).toEqual([[1, true]])
  })
})
