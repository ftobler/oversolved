// @vitest-environment node
//
// add_pattern_source through the headless session, the drive the MCP surface
// calls: the instance and curve patterns take the source (they silently no-opped
// before the kind resolver), and a row with no pattern is a refused step with a
// message, never an ok reply that changed nothing.
import { describe, it, expect } from 'vitest'
import { createHeadlessPart } from '../headlessPart'
import { docHashOf } from '../docHash'
import { patternSubOf, type PartDoc, type PartFeature, type PatternKind } from '@/types/cad'

/** A doc whose only interesting row is the pattern: solving is not the subject. */
function docWithPattern(kind: PatternKind): PartDoc {
  return {
    version: 1,
    kind: 'part',
    features: [
      { id: 'sk1', kind: 'sketch', plane: '@builtin_plane_front', entities: [], initial: {} },
      { id: 'ex1', kind: 'extrude', extrude: { sketch: ['@sk1'], distance: 5 } },
      { id: 'pt1', kind, [kind]: { subject: 'feature' } },
    ] as unknown as PartFeature[],
  }
}

function subOf(doc: PartDoc | null): Record<string, unknown> {
  const sub = patternSubOf(doc?.features?.find(f => f.id === 'pt1'))
  if (sub === null) throw new Error('the pattern lost its sub-definition')
  return sub
}

describe('add_pattern_source through the headless drive', () => {
  it.each(['curve_pattern', 'instance_pattern'] as const)('%s takes the source', async (kind) => {
    const part = createHeadlessPart({ doc: docWithPattern(kind) })
    const run = await part.run([
      { mutation: { type: 'add_pattern_source', featureId: 'pt1', sourceFeature: '@ex1' } },
    ])
    expect(run.ok).toBe(true)
    expect(run.steps[0].error).toBeUndefined()
    expect(subOf(part.getDoc()).source_features).toEqual(['@ex1'])
  })

  it('refuses a feature with no pattern instead of an ok no-op', async () => {
    const part = createHeadlessPart({ doc: docWithPattern('instance_pattern') })
    const before = docHashOf(part.getDoc()!)
    const run = await part.run([
      { mutation: { type: 'add_pattern_source', featureId: 'ex1', sourceFeature: '@ex1' } },
    ])
    expect(run.ok).toBe(false)
    expect(run.steps[0].error?.code).toBe('refused')
    expect(run.steps[0].error?.message).toContain('not a pattern')
    expect(docHashOf(part.getDoc()!)).toBe(before)
  })
})
