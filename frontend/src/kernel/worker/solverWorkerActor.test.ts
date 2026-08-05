/**
 * The Worker queue policy: a new solve request flushes the solves still
 * waiting, so a burst (a sketch drag fires one solve per pointer move) costs
 * one build instead of N. The job already running is never dropped -- an OCC
 * build is one synchronous WASM call and cannot be interrupted from the
 * outside; only the cancel button's Worker terminate can end it early.
 */
import { describe, it, expect } from 'vitest'
import { WorkerActor, type ActorJob } from './solverWorker'

/** A promise the test resolves by hand, to hold a job open. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void
  const promise = new Promise<void>(resolve => { open = resolve })
  return { promise, open }
}

/** Let the actor's macrotask yields and any settled jobs run through. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise(resolve => { setTimeout(resolve, 0) })
}

function solveJob(name: string, log: string[], hold?: Promise<void>): ActorJob {
  return {
    supersedable: true,
    run: async () => {
      log.push(`run:${name}`)
      await hold
      log.push(`done:${name}`)
    },
    onSuperseded: () => log.push(`superseded:${name}`),
  }
}

function exportJob(name: string, log: string[], hold?: Promise<void>): ActorJob {
  return {
    supersedable: false,
    run: async () => {
      log.push(`run:${name}`)
      await hold
      log.push(`done:${name}`)
    },
  }
}

describe('WorkerActor', () => {
  it('runs jobs one at a time, in order', async () => {
    const log: string[] = []
    const actor = new WorkerActor()
    actor.submit(exportJob('a', log))
    actor.submit(exportJob('b', log))
    await settle()
    expect(log).toEqual(['run:a', 'done:a', 'run:b', 'done:b'])
  })

  it('drops the queued solve when a newer solve arrives', async () => {
    const log: string[] = []
    const held = gate()
    const actor = new WorkerActor()
    actor.submit(solveJob('a', log, held.promise))
    await settle()  // 'a' is now the running job
    expect(log).toEqual(['run:a'])

    actor.submit(solveJob('b', log))
    actor.submit(solveJob('c', log))
    // 'b' never ran: 'c' replaced it while it was still queued.
    expect(log).toEqual(['run:a', 'superseded:b'])

    held.open()
    await settle()
    expect(log).toEqual(['run:a', 'superseded:b', 'done:a', 'run:c', 'done:c'])
  })

  it('never drops the solve already running', async () => {
    const log: string[] = []
    const held = gate()
    const actor = new WorkerActor()
    actor.submit(solveJob('running', log, held.promise))
    await settle()
    actor.submit(solveJob('next', log))
    await settle()
    // The running solve is still running, uninterrupted, and finishes normally.
    expect(log).toEqual(['run:running'])
    held.open()
    await settle()
    expect(log).toEqual(['run:running', 'done:running', 'run:next', 'done:next'])
  })

  it('keeps exports and bundle builds when a solve flushes the queue', async () => {
    const log: string[] = []
    const held = gate()
    const actor = new WorkerActor()
    actor.submit(solveJob('running', log, held.promise))
    await settle()
    actor.submit(exportJob('export', log))
    actor.submit(solveJob('stale', log))
    actor.submit(solveJob('fresh', log))
    expect(log).toEqual(['run:running', 'superseded:stale'])

    held.open()
    await settle()
    expect(log).toEqual([
      'run:running', 'superseded:stale', 'done:running',
      'run:export', 'done:export', 'run:fresh', 'done:fresh',
    ])
  })

  it('flushes a whole burst down to the last solve', async () => {
    const log: string[] = []
    const held = gate()
    const actor = new WorkerActor()
    actor.submit(solveJob('running', log, held.promise))
    await settle()
    for (let i = 0; i < 5; i++) actor.submit(solveJob(`drag${i}`, log))
    held.open()
    await settle()
    expect(log.filter(l => l.startsWith('run:'))).toEqual(['run:running', 'run:drag4'])
  })

  it('keeps draining after a job throws', async () => {
    const log: string[] = []
    const actor = new WorkerActor()
    actor.submit({
      supersedable: false,
      run: async () => { throw new Error('reply failed to clone') },
    })
    actor.submit(exportJob('after', log))
    await settle()
    expect(log).toEqual(['run:after', 'done:after'])
  })

  it('keeps the queue invariant when a superseded reply throws', async () => {
    const log: string[] = []
    const held = gate()
    const actor = new WorkerActor()
    actor.submit(solveJob('running', log, held.promise))
    await settle()

    // A supersedable job whose onSuperseded throws (a hostile callback, or a
    // reply that will not clone). The sweep must still drop it and keep going.
    const poison: ActorJob = {
      supersedable: true,
      run: async () => { log.push('run:poison') },
      onSuperseded: () => {
        log.push('superseded:poison')
        throw new Error('superseded reply failed to clone')
      },
    }
    actor.submit(poison)
    // Pre-fix submit let the throw escape and silently lost the new solve;
    // the invariant below is the point, so keep the test running to it.
    try {
      actor.submit(solveJob('fresh', log))
    } catch {
      // The buggy submit threw here; the invariant below is the point.
    }
    actor.submit(exportJob('after', log))
    // The poison job got its superseded reply and never runs; 'fresh' is queued.
    expect(log).toEqual(['run:running', 'superseded:poison'])

    held.open()
    await settle()
    // The drain continues past the throwing reply: fresh then the export run.
    expect(log).toEqual([
      'run:running', 'superseded:poison', 'done:running',
      'run:fresh', 'done:fresh', 'run:after', 'done:after',
    ])
  })
})
