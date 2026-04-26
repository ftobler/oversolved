import { describe, it, expect } from 'vitest'
import {
  applyAddHole,
  applySetHoleSketch,
  applySetHoleDiameter,
  applySetHoleDepth,
  applySetHoleDepthMode,
  applySetHoleDirection,
  applySetHoleTarget,
} from '../yamlMutations'
import type { PartDoc } from '../../types/cad'

function emptyDoc(): PartDoc { return { features: [] } }

describe('applyAddHole', () => {
  it('adds a hole feature with defaults', () => {
    const doc = emptyDoc()
    applyAddHole(doc, 'h1')
    expect(doc.features).toHaveLength(1)
    expect(doc.features![0].kind).toBe('hole')
    expect(doc.features![0].hole?.sketch).toBe('')
    expect(doc.features![0].hole?.diameter).toBe(10)
    expect(doc.features![0].hole?.depth_mode).toBe('blind')
    expect(doc.features![0].hole?.depth).toBe(20)
    expect(doc.features![0].hole?.direction).toBe('normal')
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
    applySetHoleSketch(doc, 'h1', '@sk1')
    expect(doc.features![0].hole?.sketch).toBe('@sk1')
  })

  it('set diameter', () => {
    const doc = emptyDoc()
    applyAddHole(doc, 'h1')
    applySetHoleDiameter(doc, 'h1', 15)
    expect(doc.features![0].hole?.diameter).toBe(15)
  })

  it('set depth', () => {
    const doc = emptyDoc()
    applyAddHole(doc, 'h1')
    applySetHoleDepth(doc, 'h1', 30)
    expect(doc.features![0].hole?.depth).toBe(30)
  })

  it('set depth mode', () => {
    const doc = emptyDoc()
    applyAddHole(doc, 'h1')
    applySetHoleDepthMode(doc, 'h1', 'through_all')
    expect(doc.features![0].hole?.depth_mode).toBe('through_all')
    expect(doc.features![0].hole?.depth).toBe(20)
  })

  it('set direction', () => {
    const doc = emptyDoc()
    applyAddHole(doc, 'h1')
    applySetHoleDirection(doc, 'h1', 'reverse')
    expect(doc.features![0].hole?.direction).toBe('reverse')
  })

  it('set target', () => {
    const doc = emptyDoc()
    applyAddHole(doc, 'h1')
    applySetHoleTarget(doc, 'h1', '@body_ex1')
    expect(doc.features![0].hole?.target).toBe('@body_ex1')
  })

  it('ignores unknown featureId', () => {
    const doc = emptyDoc()
    expect(() => applySetHoleSketch(doc, 'nope', '@sk1')).not.toThrow()
    expect(() => applySetHoleDiameter(doc, 'nope', 5)).not.toThrow()
  })
})
