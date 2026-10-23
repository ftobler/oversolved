// @vitest-environment node
//
// Two `run` calls chained by docHash, as an MCP session makes them: the second
// starts from the document the first produced. Each call builds a fresh session
// whose id source is seeded from the document it starts on, so the second must
// not repeat the first's minted sequence, and every step must report the ids it
// created. The kernel is not injected here, so solves fail benignly; the docs
// and their hashes are what these suites read (the CLI smoke covers the real
// kernel).

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { runHeadless } from '../headlessOps'
import { createDriveJournal } from '../journal'
import { replayJournal } from '../replay'
import { docHashOf } from '../docHash'
import { driveSeedFor } from '../seededIds'
import { DocHandleStore } from '../docHandleStore'
import { resolveDoc, runReply } from '../mcpDocRef'
import { createHeadlessPart } from '../headlessPart'
import { setIdSource, setIdScope } from '@/utils/yamlMutations'
import type { PartDoc, Mutation } from '@/types/cad'
import type { McpDocArguments } from '../mcpServer'
import type { ScriptStep, ScriptStepOutcome } from '../scriptRunner'

function emptyDoc(): PartDoc {
  return { version: 1, kind: 'part', features: [] } as PartDoc
}

// A sketch plus a rect: the add_rect handler mints the lines and constraints
// internally, which is what makes the per-call seed observable.
function rectSteps(sketchId: string): ScriptStep[] {
  return [
    { mutation: { type: 'add_sketch', featureId: sketchId, label: 'Rectangle', plane: '@builtin_plane_front' } },
    { mutation: { type: 'add_rect', featureId: sketchId, p0: [0, 0], p1: [10, 10] } },
  ]
}

// Every authored id in the document, the set a document-wide lookup sees.
function everyId(doc: PartDoc): string[] {
  const ids: string[] = []
  for (const feature of doc.features ?? []) {
    ids.push(feature.id)
    if (feature.kind !== 'sketch') continue
    for (const entity of feature.entities ?? []) ids.push(entity.id)
    for (const constraint of feature.constraints ?? []) ids.push(constraint.id)
  }
  return ids
}

function sketchOf(doc: PartDoc, id: string) {
  const feature = doc.features?.find(f => f.id === id)
  return feature?.kind === 'sketch' ? feature : undefined
}

interface ChainedRun {
  doc: PartDoc
  docHash: string
  steps: ScriptStepOutcome[]
  journal: ReturnType<typeof createDriveJournal>
}

// One `run` call: resolve the doc argument, seed the journal from the document
// it starts on, run, and store the result under its handle. This is the shape
// scripts/mcpServer.ts uses.
async function runChained(
  store: DocHandleStore,
  req: McpDocArguments,
  steps: ScriptStep[],
): Promise<ChainedRun> {
  let doc: PartDoc
  if (req.doc !== undefined || req.docHash !== undefined) {
    const resolved = resolveDoc(req, store)
    if (!resolved.ok) throw new Error(resolved.error)
    doc = resolved.doc
  } else {
    doc = emptyDoc()
  }
  const journal = createDriveJournal(doc)
  const result = await runHeadless({ doc, steps, journal })
  if (!result.doc) throw new Error('run produced no document')
  const reply = runReply(result, true, store)
  return { doc: result.doc, docHash: reply.docHash as string, steps: result.outcome.steps, journal }
}

beforeEach(() => {
  setIdSource(null)
  setIdScope(null)
})

afterEach(() => {
  setIdSource(null)
  setIdScope(null)
})

describe('chained drive runs', () => {
  it('derives a fresh id sequence per starting document and reports every created id', async () => {
    const store = new DocHandleStore()
    const first = await runChained(store, {}, rectSteps('sk2'))
    const second = await runChained(store, { docHash: first.docHash }, rectSteps('sk3'))

    // The rect and its constraints are minted inside the handler: each step
    // must name what it made, which it only can when the id is genuinely new.
    for (const step of [...first.steps, ...second.steps]) {
      expect(step.ok).toBe(true)
      expect(step.createdIds.length).toBeGreaterThan(0)
    }
    expect(first.steps[0].createdIds).toEqual(['sk2'])
    expect(second.steps[0].createdIds).toEqual(['sk3'])
    const rectIds = second.steps[1].createdIds
    expect(rectIds).toContain(sketchOf(second.doc, 'sk3')?.entities?.[0].id)

    // The seed differs per starting document, which is what keeps the second
    // call's sequence distinct rather than replayed from index 0.
    expect(first.journal.repro()!.seed).toBe(driveSeedFor(docHashOf(emptyDoc())))
    expect(second.journal.repro()!.seed).toBe(driveSeedFor(first.docHash))
    expect(second.journal.repro()!.seed).not.toBe(first.journal.repro()!.seed)

    // Both rectangles live in the final document, and no id repeats: the second
    // call started from the first call's output, so its seed differs and its
    // mints cannot collide with what is already there.
    expect(second.doc.features?.map(f => f.id)).toEqual(['sk2', 'sk3'])
    const ids = everyId(second.doc)
    expect(ids.length).toBeGreaterThan(0)
    expect(new Set(ids).size).toBe(ids.length)
    expect(sketchOf(second.doc, 'sk3')?.entities?.length).toBe(4)
  })

  it('builds the same chained pair byte-identically on a repeat', async () => {
    const runPair = async (): Promise<string> => {
      const store = new DocHandleStore()
      const first = await runChained(store, {}, rectSteps('sk2'))
      const second = await runChained(store, { docHash: first.docHash }, rectSteps('sk3'))
      return second.docHash
    }
    expect(await runPair()).toBe(await runPair())
  })

  it('replays both journals of a chained pair onto one document chain', async () => {
    const store = new DocHandleStore()
    const first = await runChained(store, {}, rectSteps('sk2'))
    const second = await runChained(store, { docHash: first.docHash }, rectSteps('sk3'))
    const firstRepro = first.journal.repro()
    const secondRepro = second.journal.repro()
    expect(firstRepro).not.toBeNull()
    expect(secondRepro).not.toBeNull()
    // The second repro's baseline is the document the first run produced: the
    // pair is a chain, not two independent recordings.
    expect(secondRepro!.docHash).toBe(first.docHash)
    expect(docHashOf(secondRepro!.doc)).toBe(first.docHash)

    const replayedFirst = createHeadlessPart({ doc: firstRepro!.doc as PartDoc, docId: 'replay' })
    const firstOutcome = await replayJournal(firstRepro!, replayedFirst.session, () => replayedFirst.idle())
    expect(firstOutcome.ok).toBe(true)
    expect(firstOutcome.finalHash).toBe(first.docHash)

    const replayedSecond = createHeadlessPart({ doc: replayedFirst.getDoc()!, docId: 'replay' })
    const secondOutcome = await replayJournal(secondRepro!, replayedSecond.session, () => replayedSecond.idle())
    expect(secondOutcome.ok).toBe(true)
    expect(secondOutcome.finalHash).toBe(second.docHash)

    const replayedIds = everyId(replayedSecond.getDoc()!)
    expect(replayedIds).toEqual(everyId(second.doc))
    expect(new Set(replayedIds).size).toBe(replayedIds.length)
  })

  it('reports a refused step as not solved instead of the stale part_style bodies', async () => {
    // A document whose part_style still names a body a boolean consumed. The
    // first step succeeds, the second is refused (a duplicate id), so the script
    // stops and no final solve runs; the reply must not fall back to the colour
    // keys and name the dead body.
    const consumed = {
      ...emptyDoc(),
      features: [{ id: 'sk1', kind: 'sketch' }],
      part_style: { body_ex1: { name: 'part 1' }, body_ex2: { name: 'part 2' } },
    } as unknown as PartDoc
    const steps: ScriptStep[] = [
      { mutation: { type: 'add_sketch', featureId: 'sk2', label: 'second', plane: '@builtin_plane_front' } },
      // An unknown mutation type is refused at the drive boundary, so step 1
      // (the second of three) stops the script before the extrude.
      { mutation: { type: 'add_nonsense', featureId: 'broken' } as unknown as Mutation },
      { mutation: { type: 'add_extrude', featureId: 'ex1', sketchQuery: '$sk2', distance: 5 } },
    ]
    const result = await runHeadless({ doc: consumed, steps })
    expect(result.outcome.steps.map(step => step.ok)).toEqual([true, false])
    expect(result.doc).not.toBeNull()
    const summary = runReply(result, false, new DocHandleStore()).summary as string
    expect(summary).toContain('bodies: not solved (step 1 refused)')
    expect(summary).not.toContain('body_ex2')
  })
})
