/**
 * The Worker queue policy, by lane: a new solve or measure flushes the jobs still
 * waiting in its own lane, so a burst (a sketch drag fires one solve per pointer
 * move, a cursor sweep one measure per face) costs one run instead of N. A solve
 * additionally drops the queued measures, whose generation it is about to
 * replace; a measure never drops a solve. The job already running is never
 * dropped; a running solve is only asked to stop at its next feature boundary
 * (solverWorkerAbort.test.ts).
 */
import { describe, it, expect, vi } from 'vitest'
import { WorkerActor, type ActorJob, type ActorLane } from '../solverWorker'

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

function laneJob(lane: ActorLane, name: string, log: string[], hold?: Promise<void>): ActorJob {
  return {
    lane,
    run: async () => {
      log.push(`run:${name}`)
      await hold
      log.push(`done:${name}`)
    },
    onSuperseded: () => log.push(`superseded:${name}`),
  }
}

const solveJob = (name: string, log: string[], hold?: Promise<void>): ActorJob =>
  laneJob('solve', name, log, hold)
const measureJob = (name: string, log: string[], hold?: Promise<void>): ActorJob =>
  laneJob('measure', name, log, hold)

function exportJob(name: string, log: string[], hold?: Promise<void>): ActorJob {
  return {
    lane: null,
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

  it('drops a queued measure when a newer measure arrives', async () => {
    const log: string[] = []
    const held = gate()
    const actor = new WorkerActor()
    actor.submit(solveJob('solve', log, held.promise))
    await settle()
    actor.submit(measureJob('m1', log))
    actor.submit(measureJob('m2', log))
    // The cursor moved on: only the newest readout is worth answering.
    expect(log).toEqual(['run:solve', 'superseded:m1'])

    held.open()
    await settle()
    expect(log).toEqual(['run:solve', 'superseded:m1', 'done:solve', 'run:m2', 'done:m2'])
  })

  it('drops the queued measures when a solve arrives, without dropping the solve', async () => {
    const log: string[] = []
    const held = gate()
    const actor = new WorkerActor()
    actor.submit(solveJob('running', log, held.promise))
    await settle()
    actor.submit(measureJob('m1', log))
    actor.submit(measureJob('m2', log))
    actor.submit(solveJob('next', log))
    // Both measures named the generation this solve replaces; the solve and the
    // measure that was already running are untouched.
    expect(log).toEqual(['run:running', 'superseded:m1', 'superseded:m2'])

    held.open()
    await settle()
    expect(log).toEqual([
      'run:running', 'superseded:m1', 'superseded:m2', 'done:running',
      'run:next', 'done:next',
    ])
  })

  it('never drops a queued solve when a measure arrives', async () => {
    const log: string[] = []
    const held = gate()
    const actor = new WorkerActor()
    actor.submit(exportJob('export', log, held.promise))
    await settle()
    actor.submit(solveJob('solve', log))
    actor.submit(measureJob('measure', log))
    // The solve is the document; a readout must never displace it.
    expect(log).toEqual(['run:export'])

    held.open()
    await settle()
    expect(log).toEqual(['run:export', 'done:export', 'run:solve', 'done:solve', 'run:measure', 'done:measure'])
  })

  it('keeps an export running with both lanes busy', async () => {
    const log: string[] = []
    const held = gate()
    const actor = new WorkerActor()
    actor.submit(solveJob('solve', log, held.promise))
    await settle()
    actor.submit(measureJob('measure', log))
    actor.submit(exportJob('export', log))
    // The export waits its turn and neither lane drops it.
    expect(log).toEqual(['run:solve'])

    held.open()
    await settle()
    expect(log).toEqual([
      'run:solve', 'done:solve', 'run:measure', 'done:measure', 'run:export', 'done:export',
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
      lane: null,
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

    // A droppable job whose onSuperseded throws (a hostile callback, or a reply
    // that will not clone). The sweep must still drop it and keep going.
    const poison: ActorJob = {
      lane: 'solve',
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

  it('falls back to a timer yield when MessageChannel is unavailable', async () => {
    // MessageChannel is preferred so a background tab's timer throttling cannot
    // stall a queued solve; the timer is the documented fallback. The queue must
    // still drain when it is missing.
    vi.stubGlobal('MessageChannel', undefined)
    try {
      // Guard the guard: if the stub did not take, the test would silently
      // exercise the preferred path instead of the fallback.
      expect(typeof MessageChannel).toBe('undefined')
      const log: string[] = []
      const actor = new WorkerActor()
      actor.submit(exportJob('a', log))
      await settle()
      expect(log).toEqual(['run:a', 'done:a'])
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
