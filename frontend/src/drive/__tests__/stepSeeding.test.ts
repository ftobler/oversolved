// @vitest-environment node
//
// The pure half of per-step id seeding: the feature ids the command table
// derives from the document, so a chunked script cannot duplicate one. The
// chunk-boundary contract through a real solve, chained by the reply's docHash,
// is stepSeedingReal.test.ts.

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
