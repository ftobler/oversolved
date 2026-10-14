// @vitest-environment node
//
// The headless session wiring: the part command table runs against a real
// DocSession, command-driven adds mint deterministic feature ids, and the
// journaling registry records the commands. The solves fail benignly here
// (OCC is not injected in this suite), which is exactly the "solve failed"
// path the CLI tolerates; the CLI smoke suite covers the real kernel.

import { describe, it, expect, beforeEach } from 'vitest'
import { createHeadlessPart } from '../headlessPart'
import { CommandJournal, resetCommandJournal } from '../journal'
import type { PartDoc } from '@/types/cad'
import type { CommandName } from '@/utils/core/commandNames'

function emptyDoc(): PartDoc {
  return { version: 1, kind: 'part', features: [] } as PartDoc
}

beforeEach(() => {
  resetCommandJournal()
})

describe('createHeadlessPart', () => {
  it('runs command steps through the registry and mints deterministic feature ids', async () => {
    const journal = new CommandJournal()
    const part = createHeadlessPart({ doc: emptyDoc(), journal })
    const result = part.registry.execute('add_extrude' as CommandName)
    expect(result.ok).toBe(true)
    expect(result).toMatchObject({ createdIds: ['extrude_1'] })
    await part.idle()
    expect(part.getDoc()?.features?.map(f => f.id)).toEqual(['extrude_1'])
  })

  it('records journaled commands and replays undo/redo state through the session', async () => {
    const journal = new CommandJournal()
    const part = createHeadlessPart({ doc: emptyDoc(), journal })
    part.registry.execute('add_extrude' as CommandName)
    await part.idle()
    part.registry.execute('undo' as CommandName)
    await part.idle()
    part.registry.execute('redo' as CommandName)
    await part.idle()
    expect(journal.entries().map(e => e.commandId)).toEqual(['add_extrude', 'undo', 'redo'])
    expect(part.getDoc()?.features?.map(f => f.id)).toEqual(['extrude_1'])
  })

  it('runs mutation steps through the session and command steps through the registry', async () => {
    const part = createHeadlessPart({ doc: emptyDoc() })
    const outcome = await part.run([
      { mutation: { type: 'add_sketch', featureId: 'sk1', label: 'Rectangle' } },
      { mutation: { type: 'add_rect', featureId: 'sk1', p0: [0, 0], p1: [10, 10] } },
      { command: 'undo' },
    ])
    expect(outcome.ok).toBe(true)
    expect(outcome.steps.map(s => s.kind)).toEqual(['mutation', 'mutation', 'command'])
    // The undo removed the whole rect (one entry), leaving the sketch.
    expect(part.getDoc()?.features?.map(f => f.id)).toEqual(['sk1'])
  })

  it('reports unknown commands as Results and keeps the session usable', async () => {
    const part = createHeadlessPart({ doc: emptyDoc() })
    const outcome = await part.run([{ command: 'not_a_command' }])
    expect(outcome.ok).toBe(false)
    expect(outcome.steps[0].error?.code).toBe('unknown-command')
  })
})
