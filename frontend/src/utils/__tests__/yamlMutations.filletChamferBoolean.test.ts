import { describe, it, expect } from 'vitest'
import type { PartDoc } from '@/types/cad'
import {
  applyAddFilletEdge,
  applyRemoveFilletEdge,
  applyAddChamferEdge,
  applyRemoveChamferEdge,
  applyAddBooleanTool,
  applyRemoveBooleanTool,
} from '@/utils/yamlMutations'
import { featureAt } from '@/testing/featureAccess'

const boolean0 = (doc: PartDoc) => featureAt(doc, 0, 'boolean').boolean
const chamfer0 = (doc: PartDoc) => featureAt(doc, 0, 'chamfer').chamfer
const fillet0 = (doc: PartDoc) => featureAt(doc, 0, 'fillet').fillet

describe('applyAddFilletEdge toggle', () => {
  it('adds a new edge query', () => {
    const doc: PartDoc = {
      features: [
        {
          id: 'fillet1',
          kind: 'fillet',
          fillet: { edges: ['?body_ex1:edge:0'], radius: 2 },
        },
      ],
    }
    applyAddFilletEdge(doc, 'fillet1', '?body_ex1:edge:1')
    expect(fillet0(doc).edges).toEqual(['?body_ex1:edge:0', '?body_ex1:edge:1'])
  })

  it('removes an existing edge query (toggle)', () => {
    const doc: PartDoc = {
      features: [
        {
          id: 'fillet1',
          kind: 'fillet',
          fillet: { edges: ['?body_ex1:edge:0', '?body_ex1:edge:1'], radius: 2 },
        },
      ],
    }
    applyAddFilletEdge(doc, 'fillet1', '?body_ex1:edge:0')
    expect(fillet0(doc).edges).toEqual(['?body_ex1:edge:1'])
  })

  it('does nothing if fillet is undefined', () => {
    const doc: PartDoc = {
      features: [{ id: 'fillet1', kind: 'sketch' }],
    }
    const before = structuredClone(doc)
    applyAddFilletEdge(doc, 'fillet1', '?body_ex1:edge:0')
    expect(doc).toEqual(before)
    expect(doc.features![0]).not.toHaveProperty('fillet')
  })
})

describe('applyRemoveFilletEdge', () => {
  it('removes the edge at the given index', () => {
    const doc: PartDoc = {
      features: [
        {
          id: 'fillet1',
          kind: 'fillet',
          fillet: { edges: ['e0', 'e1', 'e2'], radius: 2 },
        },
      ],
    }
    applyRemoveFilletEdge(doc, 'fillet1', 1)
    expect(fillet0(doc).edges).toEqual(['e0', 'e2'])
  })
})

describe('applyAddChamferEdge toggle', () => {
  it('adds a new edge query', () => {
    const doc: PartDoc = {
      features: [
        {
          id: 'chamfer1',
          kind: 'chamfer',
          chamfer: { edges: ['?body_ex1:edge:0'], distance: 1 },
        },
      ],
    }
    applyAddChamferEdge(doc, 'chamfer1', '?body_ex1:edge:1')
    expect(chamfer0(doc).edges).toEqual(['?body_ex1:edge:0', '?body_ex1:edge:1'])
  })

  it('removes an existing edge query (toggle)', () => {
    const doc: PartDoc = {
      features: [
        {
          id: 'chamfer1',
          kind: 'chamfer',
          chamfer: { edges: ['?body_ex1:edge:0', '?body_ex1:edge:1'], distance: 1 },
        },
      ],
    }
    applyAddChamferEdge(doc, 'chamfer1', '?body_ex1:edge:0')
    expect(chamfer0(doc).edges).toEqual(['?body_ex1:edge:1'])
  })

  it('does nothing if chamfer is undefined', () => {
    const doc: PartDoc = {
      features: [{ id: 'chamfer1', kind: 'sketch' }],
    }
    const before = structuredClone(doc)
    applyAddChamferEdge(doc, 'chamfer1', '?body_ex1:edge:0')
    expect(doc).toEqual(before)
    expect(doc.features![0]).not.toHaveProperty('chamfer')
  })
})

describe('applyRemoveChamferEdge', () => {
  it('removes the edge at the given index', () => {
    const doc: PartDoc = {
      features: [
        {
          id: 'chamfer1',
          kind: 'chamfer',
          chamfer: { edges: ['e0', 'e1', 'e2'], distance: 1 },
        },
      ],
    }
    applyRemoveChamferEdge(doc, 'chamfer1', 1)
    expect(chamfer0(doc).edges).toEqual(['e0', 'e2'])
  })
})

describe('applyAddBooleanTool toggle', () => {
  it('adds a new tool', () => {
    const doc: PartDoc = {
      features: [
        {
          id: 'bool1',
          kind: 'boolean',
          boolean: { operation: 'union', target: '@body1', tools: ['@body2'] },
        },
      ],
    }
    applyAddBooleanTool(doc, 'bool1', '@body3')
    expect(boolean0(doc).tools).toEqual(['@body2', '@body3'])
  })

  it('removes an existing tool (toggle)', () => {
    const doc: PartDoc = {
      features: [
        {
          id: 'bool1',
          kind: 'boolean',
          boolean: { operation: 'union', target: '@body1', tools: ['@body2', '@body3'] },
        },
      ],
    }
    applyAddBooleanTool(doc, 'bool1', '@body2')
    expect(boolean0(doc).tools).toEqual(['@body3'])
  })

  it('does nothing if boolean is undefined', () => {
    const doc: PartDoc = {
      features: [{ id: 'bool1', kind: 'sketch' }],
    }
    const before = structuredClone(doc)
    applyAddBooleanTool(doc, 'bool1', '@body2')
    expect(doc).toEqual(before)
    expect(doc.features![0]).not.toHaveProperty('boolean')
  })
})

describe('applyRemoveBooleanTool', () => {
  it('removes the matching tool', () => {
    const doc: PartDoc = {
      features: [
        {
          id: 'bool1',
          kind: 'boolean',
          boolean: { operation: 'union', target: '@body1', tools: ['@body2', '@body3'] },
        },
      ],
    }
    applyRemoveBooleanTool(doc, 'bool1', '@body2')
    expect(boolean0(doc).tools).toEqual(['@body3'])
  })
})
