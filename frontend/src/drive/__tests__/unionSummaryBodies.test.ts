// @vitest-environment node
//
// The run summary names the live bodies after a union whose operands were
// each cut by a merge_target extrude in the same call (birdhouse F2: the reply
// said `bodies: none` while measure found body_ex1). Real kernel.

import { createRequire } from 'node:module'
import { describe, it, expect } from 'vitest'
import { runHeadless, emptyDriveDoc, measureHeadless } from '../headlessOps'
import { DocHandleStore } from '../docHandleStore'
import { runReply } from '../mcpDocRef'
import type { ScriptStep } from '../scriptRunner'
import type { PartDoc } from '@/types/cad'
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

const m = (mutation: Record<string, unknown>): ScriptStep => ({ mutation } as ScriptStep)
const field = (type: string, featureId: string, f: string, value: unknown) => m({ type, featureId, field: f, value })

// A box on Front, extruded `new`, from x0..x0+40.
function box(n: number, x0: number): ScriptStep[] {
  return [
    m({ type: 'add_sketch', featureId: `skb${n}`, plane: '@builtin_plane_front' }),
    m({ type: 'add_rect', featureId: `skb${n}`, p0: [x0, 0], p1: [x0 + 40, 30] }),
    m({ type: 'add_extrude', featureId: `ex${n}`, sketchQuery: `$skb${n}`, distance: 20 }),
    field('set_extrude_field', `ex${n}`, 'direction', 'symmetric'),
    field('set_extrude_field', `ex${n}`, 'operation', 'new'),
  ]
}

// A through-cut circle on Front into one body by merge_target.
function cut(n: number, cx: number, target: string): ScriptStep[] {
  return [
    m({ type: 'add_sketch', featureId: `skc${n}`, plane: '@builtin_plane_front' }),
    m({ type: 'add_entity', featureId: `skc${n}`, kind: 'circle', params: [cx, 15, 5] }),
    m({ type: 'add_extrude', featureId: `cut${n}`, sketchQuery: `$skc${n}`, distance: 40 }),
    field('set_extrude_field', `cut${n}`, 'direction', 'symmetric'),
    field('set_extrude_field', `cut${n}`, 'operation', 'cut'),
    field('set_extrude_field', `cut${n}`, 'merge_target', target),
  ]
}

describe.skipIf(!ready)('run summary after a union of merge_target-cut bodies', () => {
  it('lists body_ex1, as measure does', async () => {
    const store = new DocHandleStore()
    // Both calls share the server's docId, so the second rebuild reuses the
    // first one's checkpoints: the partial-rebuild path the first hypothesis
    // suspected of leaving the union's reused result body out of `bodies`.
    const first = await runHeadless({
      doc: emptyDriveDoc(),
      docId: 'mcp',
      steps: [...box(1, 0), ...cut(1, 10, 'body_ex1'), ...box(2, 30)],
    })
    const firstReply = runReply(first, false, store)
    expect(String(firstReply.summary)).toMatch(/bodies: body_ex1, body_ex2$/)
    const doc = store.get(firstReply.docHash as string) as PartDoc
    const second = await runHeadless({
      doc,
      docId: 'mcp',
      steps: [
        ...cut(2, 60, 'body_ex2'),
        m({ type: 'add_boolean', featureId: 'bo1' }),
        field('set_boolean_field', 'bo1', 'operation', 'union'),
        field('set_boolean_field', 'bo1', 'target', 'body_ex1'),
        m({ type: 'add_boolean_tool', featureId: 'bo1', tool: 'body_ex2' }),
      ],
    })
    const reply = runReply(second, false, store)
    expect(second.features).toEqual([])
    expect(String(reply.summary)).toMatch(/bodies: body_ex1$/)
    const measured = await measureHeadless(second.doc!, { docId: 'mcp' })
    expect(measured?.measures.perBody.map(body => body.id)).toEqual(['body_ex1'])
  }, 120_000)
})
