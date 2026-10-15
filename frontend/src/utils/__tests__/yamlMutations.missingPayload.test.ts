// Stored YAML can name a feature kind without carrying its payload: the
// document loader validates a payload when one is present, it does not require
// one, and older hand-edited documents are exactly the input the migration
// ladder exists for. Before the union, every mutation guard probed the payload
// itself (`if (!feature?.array)`), so that shape warned and no-opped. The union
// moved the guard onto `kind`, which is stricter than the record it reads; these
// pin that the missing payload still warns and no-ops instead of throwing into
// the undo path.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PartDoc, PartFeature } from '@/types/cad'
import {
  applyAddBooleanTool,
  applyRemoveBooleanTool,
  applyReorderPickField,
  applySetArrayField,
  applySetHoleField,
} from '@/utils/yamlMutations'
import { applySetArrayMode, applySetHoleSketch } from '@/utils/yamlMutations/featureDefs'

// A record that names a kind but carries no def; only the loader can reject it,
// and it does not, so this cast mirrors what a loaded document can contain.
const kindOnly = (kind: string): PartFeature => ({ id: 'x1', kind }) as unknown as PartFeature

const docWith = (feature: PartFeature): PartDoc => ({ features: [feature] })

const expectWarnNoThrow = (run: () => void): void => {
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  expect(run).not.toThrow()
  expect(warnSpy).toHaveBeenCalled()
}

describe('mutations tolerate a kind without its payload', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('boolean tool toggles warn', () => {
    expectWarnNoThrow(() => applyAddBooleanTool(docWith(kindOnly('boolean')), 'x1', '@b1'))
    expectWarnNoThrow(() => applyRemoveBooleanTool(docWith(kindOnly('boolean')), 'x1', '@b1'))
  })

  it('array field and mode setters warn', () => {
    expectWarnNoThrow(() => applySetArrayField(docWith(kindOnly('array')), 'x1', 'count_x', 3))
    expectWarnNoThrow(() => applySetArrayMode(docWith(kindOnly('array')), 'x1', 'rectangular'))
  })

  it('hole field and sketch setters warn', () => {
    expectWarnNoThrow(() => applySetHoleField(docWith(kindOnly('hole')), 'x1', 'diameter', 6))
    expectWarnNoThrow(() => applySetHoleSketch(docWith(kindOnly('hole')), 'x1', '@sk1'))
  })

  it('pick-field reorder is a no-op', () => {
    for (const [kind, field] of [['fillet', 'edges'], ['boolean', 'tools'], ['delete_body', 'bodies'], ['extrude', 'sketch'], ['sweep', 'path']] as const) {
      const doc = docWith(kindOnly(kind))
      expect(() => applyReorderPickField(doc, 'x1', field, 0, 1)).not.toThrow()
    }
  })
})
