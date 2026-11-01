// @vitest-environment node
//
// Per-step id seeding: a script's ids come from the document before each step
// and the step itself, so moving a step boundary (one call, 3+3, 1x6) does not
// change what the steps mint. The real-kernel suite is the contract the MCP
// client relies on, because it chains calls through the reply's docHash; the
// command-id suite pins the other half of chunk independence, the feature ids
// the command table derives instead of drawing from the seeded source.

import { describe, it, expect } from 'vitest'
import { createHeadlessPart } from '../headlessPart'
import { docHashOf } from '../docHash'
import type { PartDoc } from '@/types/cad'
import type { ScriptStep } from '../scriptRunner'

function emptyDoc(): PartDoc {
  return { version: 1, kind: 'part', features: [] } as PartDoc
}
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
