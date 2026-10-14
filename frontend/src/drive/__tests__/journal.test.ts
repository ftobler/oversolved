// @vitest-environment node

import { describe, it, expect } from 'vitest'
import { CommandJournal, JOURNAL_CAPACITY, type ReproPayload } from '../journal'
import { JournalingCommandRegistry } from '../journalingRegistry'
import { replayJournal } from '../replay'
import { docHashOf } from '../docHash'
import { noParams, type CommandContext } from '@/utils/core/commandSpec'
import type { CommandName } from '@/utils/core/commandNames'
import { okResult } from '@/session/result'

interface TestCtx extends CommandContext {
  doc: { n: number }
}

// A tiny registry over a mutable doc box: the smallest thing that exercises the
// real CommandRegistry.execute seam the journal hooks.
function makeRegistry(doc: { n: number }, journal: CommandJournal) {
  const registry = new JournalingCommandRegistry<TestCtx>(() => ({ editor: 'part', doc }), {
    journal,
    hashDoc: () => docHashOf(doc),
    getDoc: () => doc,
    clock: () => 1234,
  })
  registry.register({
    id: 'bump' as CommandName,
    label: 'Bump',
    params: noParams(),
    enabled: () => true,
    undoable: true,
    run: (ctx) => { ctx.doc.n += 1; return okResult() },
  })
  registry.register({
    id: 'noop' as CommandName,
    label: 'No-op',
    params: noParams(),
    enabled: () => true,
    undoable: false,
    run: () => okResult(),
  })
  return registry
}

describe('CommandJournal', () => {
  it('records only commands that changed the doc hash, at the real registry seam', () => {
    const doc = { n: 0 }
    const journal = new CommandJournal()
    const registry = makeRegistry(doc, journal)
    registry.execute('noop' as CommandName)
    expect(journal.size()).toBe(0)
    registry.execute('bump' as CommandName)
    registry.execute('noop' as CommandName)
    expect(journal.size()).toBe(1)
    const [entry] = journal.entries()
    expect(entry.commandId).toBe('bump')
    expect(entry.docHashBefore).toBe(docHashOf({ n: 0 }))
    expect(entry.docHashAfter).toBe(docHashOf({ n: 1 }))
    expect(entry.at).toBe(1234)
    expect(entry.params).toBeNull()
  })

  it('records an unknown command result but not an entry', () => {
    const doc = { n: 0 }
    const journal = new CommandJournal()
    const registry = makeRegistry(doc, journal)
    const result = registry.execute('missing' as CommandName)
    expect(result.ok).toBe(false)
    expect(journal.size()).toBe(0)
  })

  it('caps the ring and restarts the generation so the suffix stays replayable', () => {
    const doc = { n: 0 }
    const journal = new CommandJournal(2)
    const registry = makeRegistry(doc, journal)
    registry.execute('bump' as CommandName)
    registry.execute('bump' as CommandName)
    registry.execute('bump' as CommandName)
    // The third record overflowed the two-slot ring: the generation restarted
    // with it, and its baseline is the doc it read (n = 2), not the original.
    expect(journal.size()).toBe(1)
    const repro = journal.repro()
    expect(repro).not.toBeNull()
    expect(repro!.doc).toEqual({ n: 2 })
    expect(repro!.docHash).toBe(docHashOf({ n: 2 }))
  })

  it('is empty until a generation with a baseline lands, and clears back to empty', () => {
    const journal = new CommandJournal()
    expect(journal.repro()).toBeNull()
    journal.record({ commandId: 'x', params: null, docHashBefore: 'a', docHashAfter: 'b', at: 0 })
    // A first record that carried no before-doc has no baseline, so there is
    // still nothing to replay.
    expect(journal.repro()).toBeNull()
    journal.clear()
    journal.record({ commandId: 'x', params: null, docHashBefore: 'a', docHashAfter: 'b', at: 0 }, { n: 1 })
    expect(journal.needsBaseline()).toBe(false)
    journal.record({ commandId: 'y', params: null, docHashBefore: 'b', docHashAfter: 'c', at: 0 })
    expect(journal.repro()!.journal).toHaveLength(2)
    journal.clear()
    expect(journal.repro()).toBeNull()
  })

  it('keeps the default capacity and hands out detached copies', () => {
    const journal = new CommandJournal()
    expect(JOURNAL_CAPACITY).toBeGreaterThan(0)
    const doc = { n: 0 }
    journal.record({ commandId: 'bump', params: { deep: [1] }, docHashBefore: 'a', docHashAfter: 'b', at: 0 }, doc)
    const repro = journal.repro()!
    doc.n = 99
    expect(repro.doc).toEqual({ n: 0 })
    const entries = journal.entries()
    ;(entries[0].params as { deep: number[] }).deep.push(2)
    expect((journal.entries()[0].params as { deep: number[] }).deep).toEqual([1])
    expect(JSON.parse(JSON.stringify(repro))).toEqual(repro)
  })
})

describe('replayJournal', () => {
  function recordSession(): { repro: ReproPayload; live: { n: number } } {
    const live = { n: 0 }
    const journal = new CommandJournal()
    const registry = makeRegistry(live, journal)
    registry.execute('bump' as CommandName)
    registry.execute('bump' as CommandName)
    const repro = journal.repro()
    expect(repro).not.toBeNull()
    return { repro: repro!, live }
  }

  it('reproduces a recorded session on a fresh baseline', async () => {
    const { repro } = recordSession()
    const replayDoc = structuredClone(repro.doc) as { n: number }
    const journal = new CommandJournal()
    const registry = makeRegistry(replayDoc, journal)
    const outcome = await replayJournal(repro, registry, () => docHashOf(replayDoc))
    expect(outcome.ok).toBe(true)
    expect(outcome.baselineHash).toBe(repro.docHash)
    expect(outcome.steps.map(s => s.commandId)).toEqual(['bump', 'bump'])
    expect(outcome.finalHash).toBe(docHashOf({ n: 2 }))
  })

  it('stops with both hashes when a step lands elsewhere than the journal recorded', async () => {
    const { repro } = recordSession()
    const tampered: ReproPayload = structuredClone(repro)
    tampered.journal[1].docHashAfter = 'not-the-real-hash'
    const replayDoc = structuredClone(repro.doc) as { n: number }
    const registry = makeRegistry(replayDoc, new CommandJournal())
    const outcome = await replayJournal(tampered, registry, () => docHashOf(replayDoc))
    expect(outcome.ok).toBe(false)
    expect(outcome.steps).toHaveLength(2)
    expect(outcome.steps[1].ok).toBe(false)
    expect(outcome.steps[1].expectedHash).toBe('not-the-real-hash')
    expect(outcome.steps[1].actualHash).toBe(docHashOf({ n: 2 }))
  })

  it('rejects a baseline that does not match the repro before executing anything', async () => {
    const { repro } = recordSession()
    const replayDoc = { n: 42 }
    const registry = makeRegistry(replayDoc, new CommandJournal())
    const outcome = await replayJournal(repro, registry, () => docHashOf(replayDoc))
    expect(outcome.ok).toBe(false)
    expect(outcome.baselineHash).toBe(docHashOf({ n: 42 }))
    expect(outcome.steps).toEqual([])
  })

  it('reports a failed command Result with its error and stops', async () => {
    const { repro } = recordSession()
    const replayDoc = structuredClone(repro.doc) as { n: number }
    const outcome = await replayJournal(
      repro,
      { execute: (id) => (id === 'bump' ? { ok: false, code: 'unknown-command', message: 'gone' } : okResult()) },
      () => docHashOf(replayDoc),
    )
    expect(outcome.ok).toBe(false)
    expect(outcome.steps[0].error).toEqual({ code: 'unknown-command', message: 'gone' })
  })
})
