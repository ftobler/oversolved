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

function sketchDoc(): PartDoc {
  return {
    version: 1,
    kind: 'part',
    features: [{ id: 'sk', kind: 'sketch', entities: [], initial: {} }],
  } as PartDoc
}

function dxfText(lines: ReadonlyArray<readonly [number, number, number, number]>): string {
  const groups = ['0', 'SECTION', '2', 'ENTITIES']
  for (const [x1, y1, x2, y2] of lines) {
    groups.push('0', 'LINE', '10', String(x1), '20', String(y1), '11', String(x2), '21', String(y2))
  }
  groups.push('0', 'ENDSEC', '0', 'EOF')
  return groups.join('\n') + '\n'
}

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

// The imported geometry without its minted ids: two runs draw different seeds
// from different step payloads, so only the kind and params are comparable.
function importedGeometry(doc: PartDoc | null): Array<{ kind: string; params: number[] | undefined }> {
  const feature = doc?.features?.find(f => f.id === 'sk')
  if (feature === undefined || feature.kind !== 'sketch') throw new Error('fixture lost its sketch')
  return (feature.entities ?? []).map(entity => ({ kind: entity.kind, params: feature.initial?.[entity.id] }))
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
      { mutation: { type: 'add_extrude', featureId: 'ex1', label: 'Extrude', sketchQuery: '$sk1', distance: 5, operation: 'new' } },
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
      { mutation: { type: 'add_extrude', featureId: 'ex1', label: 'Extrude', sketchQuery: '$sk1', distance: 5, operation: 'new' } },
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

describe('import_dxf from the run files map', () => {
  const TEXT = dxfText([[0, 0, 10, 0], [10, 0, 10, 10]])

  it('builds the same geometry as the same content inline, as one undo entry', async () => {
    const byFile = createHeadlessPart({
      doc: sketchDoc(),
      files: new Map([['rack', utf8(TEXT)]]),
    })
    const byContent = createHeadlessPart({ doc: sketchDoc() })
    const fromFile = await byFile.run([{ mutation: { type: 'import_dxf', featureId: 'sk', file: 'rack' } }])
    const inline = await byContent.run([{ mutation: { type: 'import_dxf', featureId: 'sk', content: TEXT } }])
    expect(fromFile.ok).toBe(true)
    expect(inline.ok).toBe(true)
    expect(importedGeometry(byFile.getDoc())).toEqual(importedGeometry(byContent.getDoc()))
    expect(importedGeometry(byFile.getDoc())).toHaveLength(2)
    expect(byFile.session.historyEntries().undo).toHaveLength(1)
  })

  it('fails an unknown id, names it, and leaves the document unchanged', async () => {
    const part = createHeadlessPart({
      doc: sketchDoc(),
      files: new Map([['other', utf8(TEXT)]]),
    })
    const before = JSON.stringify(part.getDoc())
    const outcome = await part.run([
      { mutation: { type: 'import_dxf', featureId: 'sk', file: 'rack' } },
      { mutation: { type: 'add_sketch', featureId: 'later' } },
    ])
    expect(outcome.ok).toBe(false)
    expect(outcome.steps).toHaveLength(1)
    expect(outcome.steps[0].error?.code).toBe('unknown-target')
    expect(outcome.steps[0].error?.message).toContain('"rack"')
    expect(outcome.steps[0].error?.message).toContain('available: other')
    expect(JSON.stringify(part.getDoc())).toBe(before)
  })

  it('fails a file step in a part with no files map, and stops the script', async () => {
    const part = createHeadlessPart({ doc: sketchDoc() })
    const before = JSON.stringify(part.getDoc())
    const outcome = await part.run([
      { mutation: { type: 'import_dxf', featureId: 'sk', file: 'rack' } },
      { mutation: { type: 'add_sketch', featureId: 'later' } },
    ])
    expect(outcome.steps).toHaveLength(1)
    expect(outcome.steps[0].ok).toBe(false)
    expect(outcome.steps[0].error?.message).toContain('"rack"')
    expect(outcome.steps[0].error?.message).toContain("run's files map")
    expect(outcome.steps[0].error?.message).toContain('files argument')
    expect(JSON.stringify(part.getDoc())).toBe(before)
  })

  it('continues past a file step the part cannot resolve when told to', async () => {
    const part = createHeadlessPart({ doc: sketchDoc() })
    const outcome = await part.run([
      { mutation: { type: 'import_dxf', featureId: 'sk', file: 'rack' }, continueOnError: true },
      { mutation: { type: 'add_sketch', featureId: 'later' } },
    ])
    expect(outcome.steps[0].ok).toBe(false)
    expect(outcome.steps[1].ok).toBe(true)
    expect(part.getDoc()?.features?.map(f => f.id)).toContain('later')
  })

  it('journals the resolved content, so a replay needs no files map', async () => {
    const journal = new CommandJournal()
    const part = createHeadlessPart({
      doc: sketchDoc(),
      journal,
      files: new Map([['rack', utf8(TEXT)]]),
    })
    const outcome = await part.run([{ mutation: { type: 'import_dxf', featureId: 'sk', file: 'rack' } }])
    expect(outcome.ok).toBe(true)
    const payload = journal.entries()[0].payload as Record<string, unknown>
    expect(payload).toMatchObject({ type: 'import_dxf', featureId: 'sk', content: TEXT })
    expect(payload).not.toHaveProperty('file')

    const repro = journal.repro()
    expect(repro).not.toBeNull()
    const fresh = createHeadlessPart({ doc: repro!.doc as PartDoc, docId: 'replay' })
    const replay = await replayJournal(repro!, fresh.session, () => fresh.idle())
    expect(replay.ok).toBe(true)
    expect(replay.finalHash).toBe(docHashOf(part.getDoc()))
  })

  it('refuses bytes that are not UTF-8, naming the file and the encoding', async () => {
    const part = createHeadlessPart({
      doc: sketchDoc(),
      files: new Map([['bad', new Uint8Array([0x80, 0x81, 0x82])]]),
    })
    const outcome = await part.run([{ mutation: { type: 'import_dxf', featureId: 'sk', file: 'bad' } }])
    expect(outcome.ok).toBe(false)
    expect(outcome.steps[0].error?.message).toContain('"bad"')
    expect(outcome.steps[0].error?.message).toContain('UTF-8')
    expect(importedGeometry(part.getDoc())).toEqual([])
  })

  it('refuses a DXF the parser rejects instead of importing an empty sketch', async () => {
    const bad = '0\nSECTION\n2\nENTITIES\n0\nINSERT\n2\nBLOCK\n0\nENDSEC\n0\nEOF\n'
    const part = createHeadlessPart({
      doc: sketchDoc(),
      files: new Map([['bad', utf8(bad)]]),
    })
    const outcome = await part.run([{ mutation: { type: 'import_dxf', featureId: 'sk', file: 'bad' } }])
    expect(outcome.ok).toBe(false)
    expect(outcome.steps[0].error?.message).toContain('INSERT')
    expect(importedGeometry(part.getDoc())).toEqual([])
  })

  it('reports the entity count instead of a bulk id list', async () => {
    const bulk = dxfText(Array.from({ length: 512 }, (_, i) => [i, 0, i + 1, 0] as const))
    const part = createHeadlessPart({
      doc: sketchDoc(),
      files: new Map([['rack', utf8(bulk)]]),
    })
    const outcome = await part.run([{ mutation: { type: 'import_dxf', featureId: 'sk', file: 'rack' } }])
    expect(outcome.ok).toBe(true)
    expect(outcome.steps[0].createdIds).toEqual([])
    expect(outcome.steps[0].createdCount).toBe(512)
    expect(importedGeometry(part.getDoc())).toHaveLength(512)
  })
})
