// @vitest-environment node
//
// A reply's docHash is a fixed point: inspecting a document (`run` with
// `steps: []`) on it, by handle or as a YAML round-tripped payload, returns the
// same hash. The solver write-back (applySolveToDoc) is the one doc write a
// no-op run makes, so it must be idempotent (din_clip F5, birdhouse F4, ANC101
// F1). Real kernel, gated like the other drive real suites.

import { createRequire } from 'node:module'
import { describe, it, expect } from 'vitest'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import type { PartDoc } from '@/types/cad'
import { runHeadless, emptyDriveDoc } from '../headlessOps'
import { MUTATION_EXAMPLES } from '../mutationExamples'
import { DocHandleStore } from '../docHandleStore'
import { resolveDoc, runReply } from '../mcpDocRef'
import { createDriveJournal } from '../journal'
import type { McpDocArguments } from '../mcpServer'
import type { ScriptStep } from '../scriptRunner'
import { loadOcc } from '@/kernel/occ/loadOcc'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { loadTopology } from '@/wasm-kernel/loadTopology'
import { setOccLoader } from '@/kernel/solveLocally'
import { setSketchSolver, setSketchTopology } from '@/kernel/features/sketch'

function occInstalled(): boolean {
  try {
    createRequire(import.meta.url).resolve('opencascade.js/dist/opencascade.wasm.js')
    return true
  } catch {
    return false
  }
}

const oc = occInstalled()
const solveBytes = loadSolver()
if (oc && solveBytes) {
  setOccLoader(loadOcc)
  setSketchSolver(solveBytes)
  setSketchTopology(loadTopology())
}
const ready = oc && solveBytes

// One `run` call in the shape scripts/mcpServer.ts makes it.
async function mcpRun(store: DocHandleStore, req: Partial<McpDocArguments>, steps: ScriptStep[]): Promise<string> {
  let doc: PartDoc
  if (req.doc !== undefined || req.docHash !== undefined) {
    const resolved = resolveDoc(req as McpDocArguments, store)
    if (!resolved.ok) throw new Error(resolved.error)
    if (resolved.kind !== 'part') throw new Error('expected a part document')
    doc = resolved.doc
  } else {
    doc = emptyDriveDoc()
  }
  const result = await runHeadless({ doc, steps, docId: 'mcp', journal: createDriveJournal(doc) })
  const reply = runReply(result, false, store)
  expect(reply.ok).toBe(true)
  return reply.docHash as string
}

describe.skipIf(!ready)('a run reply docHash is a fixed point (real OCC + Rust solver)', () => {
  // The fillet chain bakes sketch geometry and reconciles part_style across a
  // body the solve modifies, the write-back's whole surface.
  for (const name of ['box', 'filleted-box']) {
    it(`${name}: inspecting h1 by handle returns h1`, async () => {
      const store = new DocHandleStore()
      const example = MUTATION_EXAMPLES.find(entry => entry.name === name)!
      const h1 = await mcpRun(store, {}, example.steps)
      expect(await mcpRun(store, { docHash: h1 }, [])).toBe(h1)
    }, 120_000)

    it(`${name}: inspecting the YAML export of h1 returns h1`, async () => {
      const store = new DocHandleStore()
      const example = MUTATION_EXAMPLES.find(entry => entry.name === name)!
      const h1 = await mcpRun(store, {}, example.steps)
      const parsed = parseYaml(stringifyYaml(store.get(h1))) as PartDoc
      expect(await mcpRun(store, { doc: parsed }, [])).toBe(h1)
    }, 120_000)
  }

  // A payload stamped before the ladder's version (a practice run's saved
  // bug-1.yaml, or a browser document) migrates once on the way in; the reply
  // it yields, edited further by `$`-writing mutations, must then hold still.
  it('a version-1 payload settles: its reply hash survives a YAML reload', async () => {
    const store = new DocHandleStore()
    const box = MUTATION_EXAMPLES.find(entry => entry.name === 'box')!
    const old = { ...emptyDriveDoc(), version: 1 }
    const h0 = await mcpRun(store, { doc: old }, box.steps.slice(0, 2))
    const h1 = await mcpRun(store, { docHash: h0 }, box.steps.slice(2))
    const parsed = parseYaml(stringifyYaml(store.get(h1))) as PartDoc
    expect(await mcpRun(store, { doc: parsed }, [])).toBe(h1)
  }, 120_000)
})
