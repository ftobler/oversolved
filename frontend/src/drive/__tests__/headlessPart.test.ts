// @vitest-environment node
//
// The headless session wiring: the part command table runs against a real
// DocSession, command-driven adds mint deterministic feature ids, and the
// journal records the session mutations. The solves fail benignly here (OCC is
// not injected in this suite), which is exactly the "solve failed" path the CLI
// tolerates; the CLI smoke suite covers the real kernel.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createHeadlessPart } from '../headlessPart'
import { CommandJournal } from '../journal'
import { replayJournal } from '../replay'
import { docHashOf } from '../docHash'
import { seededIdSource } from '../seededIds'
import { setIdSource } from '@/utils/yamlMutations'
import type { Mutation, PartDoc } from '@/types/cad'
import type { CommandName } from '@/utils/core/commandNames'
import type { ScriptStep } from '../scriptRunner'

function emptyDoc(): PartDoc {
  return { version: 1, kind: 'part', features: [] } as PartDoc
}

beforeEach(() => {
  setIdSource(null)
})

afterEach(() => {
  setIdSource(null)
})

describe('createHeadlessPart', () => {
  it('runs command steps through the registry and mints deterministic feature ids', async () => {
    const part = createHeadlessPart({ doc: emptyDoc() })
    const result = part.registry.execute('add_extrude' as CommandName)
    expect(result.ok).toBe(true)
    expect(result).toMatchObject({ createdIds: ['extrude_1'] })
    await part.idle()
    expect(part.getDoc()?.features?.map(f => f.id)).toEqual(['extrude_1'])
  })

  it('records session mutations, and an undo restarts the journal suffix', async () => {
    const journal = new CommandJournal()
    const part = createHeadlessPart({ doc: emptyDoc(), journal })
    part.registry.execute('add_extrude' as CommandName)
    await part.idle()
    expect(journal.entries().map(e => e.payload)).toMatchObject([{ type: 'add_extrude' }])
    expect(journal.entries()[0].kind).toBe('mutation')
    // An undo installs a doc no mutation chain produced, so the suffix is
    // dropped rather than left as a torn history.
    part.registry.execute('undo' as CommandName)
    await part.idle()
    expect(journal.repro()).toBeNull()
    part.registry.execute('redo' as CommandName)
    await part.idle()
    expect(journal.repro()).toBeNull()
    expect(part.getDoc()?.features?.map(f => f.id)).toEqual(['extrude_1'])
  })

  it('refuses delete_selected instead of reporting an ok that did nothing', () => {
    const part = createHeadlessPart({ doc: emptyDoc() })
    const result = part.registry.execute('delete_selected' as CommandName)
    expect(result.ok).toBe(false)
    expect(result).toMatchObject({ code: 'unsupported' })
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

  it('records a browser-context journal and replays it from the payload alone', async () => {
    // The journal is the browser's kind: no source installed, the generation
    // seed drawn from crypto. The script mints the rect's entities and
    // constraints inside the handler, so only the recorded seed can reproduce
    // them on replay.
    const journal = new CommandJournal()
    const part = createHeadlessPart({ doc: emptyDoc(), journal })
    const outcome = await part.run([
      { mutation: { type: 'add_sketch', featureId: 'sk1', label: 'Rectangle', plane: '@builtin_plane_front' } },
      { mutation: { type: 'add_rect', featureId: 'sk1', p0: [0, 0], p1: [10, 10] } },
      { mutation: { type: 'add_extrude', featureId: 'ex1', label: 'Extrude', sketchQuery: '$sk1', distance: 5 } },
    ])
    expect(outcome.ok).toBe(true)
    const repro = journal.repro()
    expect(repro).not.toBeNull()
    expect(Number.isInteger(repro!.seed)).toBe(true)
    const recordedHash = docHashOf(part.getDoc())

    const fresh = createHeadlessPart({ doc: repro!.doc as PartDoc, docId: 'replay' })
    const replay = await replayJournal(repro!, fresh.session, () => fresh.idle())
    expect(replay.ok).toBe(true)
    expect(replay.finalHash).toBe(recordedHash)
    expect(fresh.getDoc()?.features?.map(f => f.id)).toEqual(['sk1', 'ex1'])
  })

  it('replays a mid-stack insertion from the mutation payload alone', async () => {
    // The add records doc.rollback just past the inserted row. Replay has no
    // page store to supply that position, so the payload's insertAt must drive
    // the same mirror write or the after-hash diverges.
    const doc: PartDoc = {
      version: 1,
      kind: 'part',
      rollback: 1,
      features: [
        { id: 'f1', kind: 'sketch', label: 'First' },
        { id: 'f2', kind: 'sketch', label: 'Second' },
      ],
    }
    const journal = new CommandJournal()
    const part = createHeadlessPart({ doc, journal })
    // The app produces insertAt; the script boundary refuses it (see
    // mutationValidation), so this test applies the internal payload directly
    // and then pins that its replay accepts the internal field.
    const result = part.session.execute({
      type: 'add_sketch', featureId: 'f1b', label: 'Inserted', insertAt: 1,
    } as Mutation)
    expect(result.ok).toBe(true)
    expect(part.getDoc()?.features?.map(f => f.id)).toEqual(['f1', 'f1b', 'f2'])
    expect(part.getDoc()?.rollback).toBe(2)

    const repro = journal.repro()
    expect(repro).not.toBeNull()
    const fresh = createHeadlessPart({ doc: repro!.doc as PartDoc, docId: 'replay' })
    const replay = await replayJournal(repro!, fresh.session, () => fresh.idle())
    expect(replay.ok).toBe(true)
    expect(replay.finalHash).toBe(docHashOf(part.getDoc()))
  })

  it('builds the canonical script byte-identically across two seeded runs', async () => {
    // The box script mints its rect entities inside the handler, so the doc
    // hash can only repeat when the id source is seeded. A fresh source per
    // run makes this the same guarantee the CLI gives two processes.
    const canonical: ScriptStep[] = [
      { mutation: { type: 'add_sketch', featureId: 'sk1', label: 'Rectangle', plane: '@builtin_plane_front' } },
      { mutation: { type: 'add_rect', featureId: 'sk1', p0: [0, 0], p1: [10, 10] } },
      { mutation: { type: 'add_extrude', featureId: 'ex1', label: 'Extrude', sketchQuery: '$sk1', distance: 5 } },
    ]
    const runOnce = async (): Promise<string> => {
      setIdSource(seededIdSource())
      const part = createHeadlessPart({ doc: emptyDoc() })
      const outcome = await part.run(canonical)
      expect(outcome.ok).toBe(true)
      return docHashOf(part.getDoc())
    }
    const first = await runOnce()
    const second = await runOnce()
    expect(second).toBe(first)
  })
})
