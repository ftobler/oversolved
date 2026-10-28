// @vitest-environment node
//
// Per-step id seeding: a script's ids come from the document before each step
// and the step itself, so moving a step boundary (one call, 3+3, 1x6) does not
// change what the steps mint. The real-kernel suite is the contract the MCP
// client relies on, because it chains calls through the reply's docHash; the
// command-id suite pins the other half of chunk independence, the feature ids
// the command table derives instead of drawing from the seeded source.

import { createRequire } from 'node:module'
import { beforeAll, beforeEach, afterEach, describe, it, expect } from 'vitest'
import { setOccLoader } from '@/kernel/solveLocally'
import { loadOcc } from '@/kernel/occ/loadOcc'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { loadTopology } from '@/wasm-kernel/loadTopology'
import { setSketchSolver, setSketchTopology } from '@/kernel/features/sketch'
import { createHeadlessPart } from '../headlessPart'
import { createDriveJournal } from '../journal'
import { runHeadless } from '../headlessOps'
import { docHashOf } from '../docHash'
import { DocHandleStore } from '../docHandleStore'
import { resolveDoc, runReply } from '../mcpDocRef'
import { setIdSource, setIdScope } from '@/utils/yamlMutations'
import type { PartDoc } from '@/types/cad'
import type { McpDocArguments } from '../mcpServer'
import type { ScriptStep, ScriptStepOutcome } from '../scriptRunner'

function occInstalled(): boolean {
  try {
    createRequire(import.meta.url).resolve('opencascade.js/dist/opencascade.wasm.js')
    return true
  } catch {
    return false
  }
}

function emptyDoc(): PartDoc {
  return { version: 1, kind: 'part', features: [] } as PartDoc
}

// The two steps every script starts with. add_rect mints its four lines and
// their constraints inside the handler, so a call-bound seed is visible here.
const PREFIX: ScriptStep[] = [
  { mutation: { type: 'add_sketch', featureId: 'sk1', label: 'Rectangle', plane: '@builtin_plane_front' } },
  { mutation: { type: 'add_rect', featureId: 'sk1', p0: [0, 0], p1: [10, 10] } },
]

// The six-step script: a second sketch and an ngon mint more ids, the length
// constraint stores a selection id the rect minted (the shape `select` returns
// for a sketch entity), and the extrude closes the part.
function fullScript(lineId: string): ScriptStep[] {
  return [
    ...PREFIX,
    { mutation: { type: 'add_sketch', featureId: 'sk2', label: 'Polygon', plane: '@builtin_plane_front' } },
    { mutation: { type: 'add_ngon', featureId: 'sk2', center: [20, 0], corner: [25, 0], sides: 6 } },
    {
      mutation: {
        type: 'add_constraint', featureId: 'sk1', kind: 'length',
        targets: [`entity:sk1:${lineId}`], value: 10,
      },
    },
    { mutation: { type: 'add_extrude', featureId: 'ex1', label: 'Extrude', sketchQuery: '$sk1', distance: 5 } },
  ]
}

function sketchOf(doc: PartDoc, id: string) {
  const feature = doc.features?.find(f => f.id === id)
  return feature?.kind === 'sketch' ? feature : undefined
}

// The one id a rect-minted line carries; discovered before the measured runs so
// the constraint step can name it without the test knowing the seed scheme.
async function discoverRectLine(docId: string): Promise<string> {
  const result = await runHeadless({ doc: emptyDoc(), steps: PREFIX, docId })
  const line = sketchOf(result.doc as PartDoc, 'sk1')?.entities?.find(e => e.kind === 'line')
  if (!line) throw new Error('the rect minted no line to constrain')
  return line.id
}

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

interface ChainedRun {
  doc: PartDoc
  docHash: string
  steps: ScriptStepOutcome[]
  // Every id the call's steps created, across the whole script (not only the
  // last chunk), so a split run compares to the one-call run step for step.
  created: string[]
  // The solve reached a live body set; proves the real-kernel suite is not
  // passing only because every solve failed identically.
  solved: boolean
}

// One `run` call in the client's shape: resolve the doc argument, journal from
// the document it starts on, run, and publish the result under its hash.
async function runCall(
  store: DocHandleStore,
  req: McpDocArguments,
  steps: ScriptStep[],
  docId: string,
): Promise<ChainedRun> {
  let doc: PartDoc
  if (req.doc !== undefined || req.docHash !== undefined) {
    const resolved = resolveDoc(req, store)
    if (!resolved.ok) throw new Error(resolved.error)
    if (resolved.kind !== 'part') throw new Error('expected a part document')
    doc = resolved.doc
  } else {
    doc = emptyDoc()
  }
  const result = await runHeadless({ doc, steps, docId, journal: createDriveJournal(doc) })
  if (!result.doc) throw new Error('run produced no document')
  const reply = runReply(result, false, store)
  return {
    doc: result.doc,
    docHash: reply.docHash as string,
    steps: result.outcome.steps,
    created: createdIds(result.outcome.steps),
    solved: result.bodies !== null,
  }
}

// A script split at the given call sizes, each chunk chained by the previous
// reply's docHash exactly as an MCP client chains `run` calls.
async function runSplit(steps: ScriptStep[], sizes: readonly number[], docIdBase: string): Promise<ChainedRun> {
  const store = new DocHandleStore()
  let req: McpDocArguments = {}
  let last: ChainedRun | null = null
  const created: string[] = []
  let offset = 0
  for (const [call, size] of sizes.entries()) {
    last = await runCall(store, req, steps.slice(offset, offset + size), `${docIdBase}-${call}`)
    created.push(...last.created)
    req = { docHash: last.docHash }
    offset += size
  }
  if (!last) throw new Error('runSplit needs at least one chunk')
  return { ...last, created }
}

function createdIds(steps: readonly ScriptStepOutcome[]): string[] {
  return steps.flatMap(step => step.createdIds)
}

beforeEach(() => {
  setIdSource(null)
  setIdScope(null)
})

afterEach(() => {
  setIdSource(null)
  setIdScope(null)
})

describe('command feature ids', () => {
  it('derives the next id from the document so a chunked script cannot duplicate it', async () => {
    const steps: ScriptStep[] = [{ command: 'add_extrude' }, { command: 'add_extrude' }]
    const once = createHeadlessPart({ doc: emptyDoc(), docId: 'cmd-once' })
    expect((await once.run(steps)).ok).toBe(true)
    expect(once.getDoc()?.features?.map(f => f.id)).toEqual(['extrude_1', 'extrude_2'])

    const first = createHeadlessPart({ doc: emptyDoc(), docId: 'cmd-first' })
    expect((await first.run([steps[0]])).ok).toBe(true)
    const second = createHeadlessPart({ doc: first.getDoc() as PartDoc, docId: 'cmd-second' })
    expect((await second.run([steps[1]])).ok).toBe(true)

    expect(second.getDoc()?.features?.map(f => f.id)).toEqual(['extrude_1', 'extrude_2'])
    expect(docHashOf(second.getDoc())).toBe(docHashOf(once.getDoc()))
  })
})

const oc = occInstalled()
const solveBytes = loadSolver()

describe.skipIf(!oc || !solveBytes)('per-step seeding (real OCC + Rust solver)', () => {
  beforeAll(() => {
    setOccLoader(loadOcc)
    setSketchSolver(loadSolver())
    setSketchTopology(loadTopology())
  })

  it('mints identical ids and a final doc hash as one call, 3+3 and 1x6', async () => {
    const lineId = await discoverRectLine('seed-discover')
    const steps = fullScript(lineId)

    const once = await runSplit(steps, [6], 'seed-once')
    const halves = await runSplit(steps, [3, 3], 'seed-halves')
    const singles = await runSplit(steps, [1, 1, 1, 1, 1, 1], 'seed-singles')

    // Each chunk's step indexes restart at 0; together they are the same six
    // steps, in order and all accepted.
    for (const run of [once, halves, singles]) {
      expect(run.steps.length).toBeGreaterThan(0)
      expect(run.steps.every(step => step.ok)).toBe(true)
    }
    expect(once.created.length).toBeGreaterThan(10)
    expect(once.solved).toBe(true)
    // The chunk boundary is invisible: every step mints the same ids and the
    // final authored/solved document hashes the same.
    expect(halves.created).toEqual(once.created)
    expect(singles.created).toEqual(once.created)
    expect(halves.docHash).toBe(once.docHash)
    expect(singles.docHash).toBe(once.docHash)
    expect(everyId(halves.doc)).toEqual(everyId(once.doc))
    expect(everyId(singles.doc)).toEqual(everyId(once.doc))
  }, 180_000)
})
