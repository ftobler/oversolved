// The union editor's one "Parts to join" list writes the stored target + tools
// pair: the first pick becomes the base (target), every later pick a tool.
// Removing the base promotes the next body, so the list keeps its order and the
// solve still has a base. Subtract and intersect keep their explicit target
// field and must not read these union-only rules.

import { describe, it, expect } from 'vitest'
import type { PartDoc } from '@/types/cad'
import { applyAddBooleanTool, applyRemoveBooleanTool } from '@/utils/yamlMutations'
import { featureAt } from '@/testing/featureAccess'

const boolean0 = (doc: PartDoc) => featureAt(doc, 0, 'boolean').boolean

function unionDoc(target: string, tools: string[]): PartDoc {
  return {
    features: [{
      id: 'bool1', kind: 'boolean',
      boolean: { operation: 'union', target, tools },
    }],
  }
}

describe('the union join list writes target then tools', () => {
  it('makes the first pick of an empty list the base', () => {
    const doc = unionDoc('', [])
    applyAddBooleanTool(doc, 'bool1', '@body_a')
    expect(boolean0(doc).target).toBe('@body_a')
    expect(boolean0(doc).tools).toEqual([])
  })

  it('adds later picks as tools', () => {
    const doc = unionDoc('@body_a', [])
    applyAddBooleanTool(doc, 'bool1', '@body_b')
    applyAddBooleanTool(doc, 'bool1', '@body_c')
    expect(boolean0(doc).target).toBe('@body_a')
    expect(boolean0(doc).tools).toEqual(['@body_b', '@body_c'])
  })

  it('still toggles a listed tool off', () => {
    const doc = unionDoc('@body_a', ['@body_b', '@body_c'])
    applyAddBooleanTool(doc, 'bool1', '@body_b')
    expect(boolean0(doc).tools).toEqual(['@body_c'])
  })

  it('promotes the next body when the base is removed', () => {
    const doc = unionDoc('@body_a', ['@body_b', '@body_c'])
    applyRemoveBooleanTool(doc, 'bool1', '@body_a')
    expect(boolean0(doc).target).toBe('@body_b')
    expect(boolean0(doc).tools).toEqual(['@body_c'])
  })

  it('picking the base again toggles it off and promotes the next body', () => {
    const doc = unionDoc('@body_a', ['@body_b', '@body_c'])
    applyAddBooleanTool(doc, 'bool1', '@body_a')
    expect(boolean0(doc).target).toBe('@body_b')
    expect(boolean0(doc).tools).toEqual(['@body_c'])
  })

  it('empties the base when it was the only pick', () => {
    const doc = unionDoc('@body_a', [])
    applyRemoveBooleanTool(doc, 'bool1', '@body_a')
    expect(boolean0(doc).target).toBe('')
    expect(boolean0(doc).tools).toEqual([])
  })
})

describe('a non-union boolean keeps the old tool semantics', () => {
  it('an empty subtract target does not take the first pick', () => {
    const doc: PartDoc = {
      features: [{
        id: 'bool1', kind: 'boolean',
        boolean: { operation: 'subtract', target: '', tools: [] },
      }],
    }
    applyAddBooleanTool(doc, 'bool1', '@body_b')
    expect(boolean0(doc).target).toBe('')
    expect(boolean0(doc).tools).toEqual(['@body_b'])
  })

  it('removing the target ref from a subtract does not promote a tool', () => {
    const doc: PartDoc = {
      features: [{
        id: 'bool1', kind: 'boolean',
        boolean: { operation: 'subtract', target: '@body_a', tools: ['@body_b'] },
      }],
    }
    applyRemoveBooleanTool(doc, 'bool1', '@body_a')
    expect(boolean0(doc).target).toBe('@body_a')
    expect(boolean0(doc).tools).toEqual(['@body_b'])
  })
})
