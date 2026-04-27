import { describe, it, expect } from 'vitest'
import type { PartDoc } from '../../types/cad'
import {
  applyAddFilletEdge,
  applyRemoveFilletEdge,
  applyAddChamferEdge,
  applyRemoveChamferEdge,
  applyAddBooleanTool,
  applyRemoveBooleanTool,
} from '../yamlMutations'

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
    expect(doc.features![0].fillet!.edges).toEqual(['?body_ex1:edge:0', '?body_ex1:edge:1'])
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
    expect(doc.features![0].fillet!.edges).toEqual(['?body_ex1:edge:1'])
  })

  it('does nothing if fillet is undefined', () => {
    const doc: PartDoc = {
      features: [{ id: 'fillet1', kind: 'sketch' }],
    }
    expect(() => applyAddFilletEdge(doc, 'fillet1', '?body_ex1:edge:0')).not.toThrow()
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
    expect(doc.features![0].fillet!.edges).toEqual(['e0', 'e2'])
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
    expect(doc.features![0].chamfer!.edges).toEqual(['?body_ex1:edge:0', '?body_ex1:edge:1'])
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
    expect(doc.features![0].chamfer!.edges).toEqual(['?body_ex1:edge:1'])
  })

  it('does nothing if chamfer is undefined', () => {
    const doc: PartDoc = {
      features: [{ id: 'chamfer1', kind: 'sketch' }],
    }
    expect(() => applyAddChamferEdge(doc, 'chamfer1', '?body_ex1:edge:0')).not.toThrow()
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
    expect(doc.features![0].chamfer!.edges).toEqual(['e0', 'e2'])
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
    expect(doc.features![0].boolean!.tools).toEqual(['@body2', '@body3'])
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
    expect(doc.features![0].boolean!.tools).toEqual(['@body3'])
  })

  it('does nothing if boolean is undefined', () => {
    const doc: PartDoc = {
      features: [{ id: 'bool1', kind: 'sketch' }],
    }
    expect(() => applyAddBooleanTool(doc, 'bool1', '@body2')).not.toThrow()
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
    expect(doc.features![0].boolean!.tools).toEqual(['@body3'])
  })
})
