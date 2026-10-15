import { describe, it, expect, vi } from 'vitest'
import {
  applyAddHole,
  applySetHoleField,
} from '@/utils/yamlMutations'
import { applySetHoleSketch } from '@/utils/yamlMutations/featureDefs'
import type { PartDoc } from '@/types/cad'
import { featureAt } from '@/testing/featureAccess'

const hole0 = (doc: PartDoc) => featureAt(doc, 0, 'hole').hole

function emptyDoc(): PartDoc { return { features: [] } }

describe('applyAddHole', () => {
  it('adds a hole feature with defaults', () => {
    const doc = emptyDoc()
    applyAddHole(doc, 'h1')
    expect(doc.features).toHaveLength(1)
    expect(doc.features![0].kind).toBe('hole')
    expect(hole0(doc)?.sketch).toBe('')
    expect(hole0(doc)?.diameter).toBe(10)
    expect(hole0(doc)?.depth_mode).toBe('blind')
    expect(hole0(doc)?.depth).toBe(20)
    expect(hole0(doc)?.direction).toBe('normal')
  })

  it('uses provided label', () => {
    const doc = emptyDoc()
    applyAddHole(doc, 'h1', 'My Hole')
    expect(doc.features![0].label).toBe('My Hole')
  })
})

describe('hole setters', () => {
  it('set sketch', () => {
    const doc = emptyDoc()
    applyAddHole(doc, 'h1')
    applySetHoleField(doc, 'h1', 'sketch', '@sk1')
    expect(hole0(doc)?.sketch).toBe('@sk1')
  })

  it('set diameter', () => {
    const doc = emptyDoc()
    applyAddHole(doc, 'h1')
    applySetHoleField(doc, 'h1', 'diameter', 15)
    expect(hole0(doc)?.diameter).toBe(15)
  })

  it('set depth', () => {
    const doc = emptyDoc()
    applyAddHole(doc, 'h1')
    applySetHoleField(doc, 'h1', 'depth', 30)
    expect(hole0(doc)?.depth).toBe(30)
  })

  it('set depth mode', () => {
    const doc = emptyDoc()
    applyAddHole(doc, 'h1')
    applySetHoleField(doc, 'h1', 'depth_mode', 'through_all')
    expect(hole0(doc)?.depth_mode).toBe('through_all')
    expect(hole0(doc)?.depth).toBe(20)
  })

  it('set direction', () => {
    const doc = emptyDoc()
    applyAddHole(doc, 'h1')
    applySetHoleField(doc, 'h1', 'direction', 'reverse')
    expect(hole0(doc)?.direction).toBe('reverse')
  })

  it('set target', () => {
    const doc = emptyDoc()
    applyAddHole(doc, 'h1')
    applySetHoleField(doc, 'h1', 'target', '@body_ex1')
    expect(hole0(doc)?.target).toBe('@body_ex1')
  })

  it('ignores unknown featureId', () => {
    const doc = emptyDoc()
    const before = structuredClone(doc)
    applySetHoleField(doc, 'nope', 'sketch', '@sk1')
    applySetHoleField(doc, 'nope', 'diameter', 5)
    expect(doc).toEqual(before)
    expect(doc.features).toEqual([])
  })

  // setFeatureField guards numeric writes: a NaN diameter persisted into YAML
  // poisons every later solve, while strings and selects must keep passing
  // through untouched.
  it('ignores a non-finite number but still accepts finite values and strings', () => {
    const doc = emptyDoc()
    applyAddHole(doc, 'h1')
    applySetHoleField(doc, 'h1', 'diameter', NaN)
    expect(hole0(doc)?.diameter).toBe(10)
    applySetHoleField(doc, 'h1', 'diameter', 12.5)
    expect(hole0(doc)?.diameter).toBe(12.5)
    applySetHoleField(doc, 'h1', 'sketch', '@sk1')
    expect(hole0(doc)?.sketch).toBe('@sk1')
  })

  // The file's diagnostic convention (applySetSubFeatureField and friends): a
  // missing sub-object warns instead of returning silently.
  describe('on a feature without a hole sub-object', () => {
    function holelessDoc(): PartDoc {
      return { features: [{ id: 'h2', kind: 'extrude', extrude: { sketch: [], distance: 1 } }] }
    }

    it('applySetHoleField warns', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      const doc = holelessDoc()
      applySetHoleField(doc, 'h2', 'diameter', 5)
      expect(warnSpy).toHaveBeenCalled()
      expect(warnSpy.mock.calls[0][0]).toContain('has no hole')
      warnSpy.mockRestore()
    })

    it('applySetHoleSketch warns', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      const doc = holelessDoc()
      applySetHoleSketch(doc, 'h2', '@sk1')
      expect(warnSpy).toHaveBeenCalled()
      expect(warnSpy.mock.calls[0][0]).toContain('has no hole')
      warnSpy.mockRestore()
    })
  })
})
