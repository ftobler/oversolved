import { describe, it, expect } from 'vitest'
import { parseYamlDoc, applyMoveVertex, applyAddConstraint, applyDeleteElements } from '../yamlMutations'

const SAMPLE_YAML = `version: 1
kind: part

features:
  - id: Sketch1
    kind: sketch
    initial:
      line1: [0, 0, 10, 0]
      circ1: [5, 5, 3]
      pt1: [1, 2]
    entities:
      - id: line1
        kind: line_segment
      - id: circ1
        kind: circle
      - id: pt1
        kind: point
    constraints:
      - id: c_horiz
        kind: horizontal
        target: {entity: line1}
      - id: c_len
        kind: length
        target: {entity: line1}
        value: 10
`

describe('applyMoveVertex', () => {
  it('moves line_segment start', () => {
    const doc = parseYamlDoc(SAMPLE_YAML)
    applyMoveVertex(doc, 'Sketch1', 'line1', 'start', [2, 3])
    const result = doc.toJSON()
    expect(result.features[0].initial.line1).toEqual([2, 3, 10, 0])
  })

  it('moves line_segment end', () => {
    const doc = parseYamlDoc(SAMPLE_YAML)
    applyMoveVertex(doc, 'Sketch1', 'line1', 'end', [15, 5])
    const result = doc.toJSON()
    expect(result.features[0].initial.line1).toEqual([0, 0, 15, 5])
  })

  it('moves circle center', () => {
    const doc = parseYamlDoc(SAMPLE_YAML)
    applyMoveVertex(doc, 'Sketch1', 'circ1', 'center', [7, 8])
    const result = doc.toJSON()
    expect(result.features[0].initial.circ1).toEqual([7, 8, 3])
  })

  it('moves point xy', () => {
    const doc = parseYamlDoc(SAMPLE_YAML)
    applyMoveVertex(doc, 'Sketch1', 'pt1', 'xy', [9.5, 10.5])
    const result = doc.toJSON()
    expect(result.features[0].initial.pt1).toEqual([9.5, 10.5])
  })

  it('no-ops for unknown entity', () => {
    const doc = parseYamlDoc(SAMPLE_YAML)
    applyMoveVertex(doc, 'Sketch1', 'nonexistent', 'start', [0, 0])
    const result = doc.toJSON()
    expect(result.features[0].initial.line1).toEqual([0, 0, 10, 0])
  })

  it('rounds coordinates to 6 decimal places', () => {
    const doc = parseYamlDoc(SAMPLE_YAML)
    applyMoveVertex(doc, 'Sketch1', 'line1', 'start', [1.23456789, 9.87654321])
    const result = doc.toJSON()
    expect(result.features[0].initial.line1[0]).toBe(1.234568)
    expect(result.features[0].initial.line1[1]).toBe(9.876543)
  })
})

describe('applyAddConstraint', () => {
  it('adds a single-target constraint', () => {
    const doc = parseYamlDoc(SAMPLE_YAML)
    applyAddConstraint(doc, 'Sketch1', 'vertical', ['entity:Sketch1:line1'])
    const result = doc.toJSON()
    const constraints = result.features[0].constraints
    const added = constraints.find((c: { id: string }) => c.id.startsWith('c_vertical'))
    expect(added).toBeDefined()
    expect(added.kind).toBe('vertical')
    expect(added.target).toEqual({ entity: 'line1' })
  })

  it('adds a two-target constraint', () => {
    const doc = parseYamlDoc(SAMPLE_YAML)
    applyAddConstraint(doc, 'Sketch1', 'perpendicular', ['entity:Sketch1:line1', 'entity:Sketch1:circ1'])
    const result = doc.toJSON()
    const constraints = result.features[0].constraints
    const added = constraints.find((c: { id: string }) => c.id.startsWith('c_perpendicular'))
    expect(added).toBeDefined()
    expect(added.a).toEqual({ entity: 'line1' })
    expect(added.b).toEqual({ entity: 'circ1' })
  })

  it('adds constraint with vertex point reference', () => {
    const doc = parseYamlDoc(SAMPLE_YAML)
    applyAddConstraint(doc, 'Sketch1', 'coincident', ['vertex:Sketch1:line1:end', 'vertex:Sketch1:circ1:center'])
    const result = doc.toJSON()
    const constraints = result.features[0].constraints
    const added = constraints.find((c: { id: string }) => c.id.startsWith('c_coincident'))
    expect(added).toBeDefined()
    expect(added.a).toEqual({ entity: 'line1', point: 'end' })
    expect(added.b).toEqual({ entity: 'circ1', point: 'center' })
  })

  it('generates unique constraint ids', () => {
    const doc = parseYamlDoc(SAMPLE_YAML)
    applyAddConstraint(doc, 'Sketch1', 'vertical', ['entity:Sketch1:line1'])
    applyAddConstraint(doc, 'Sketch1', 'vertical', ['entity:Sketch1:circ1'])
    const result = doc.toJSON()
    const ids = result.features[0].constraints.map((c: { id: string }) => c.id)
    const vertIds = ids.filter((id: string) => id.startsWith('c_vertical'))
    expect(new Set(vertIds).size).toBe(vertIds.length)
  })
})

describe('applyDeleteElements', () => {
  it('deletes an entity from entities list and initial', () => {
    const doc = parseYamlDoc(SAMPLE_YAML)
    applyDeleteElements(doc, ['entity:Sketch1:circ1'])
    const result = doc.toJSON()
    expect(result.features[0].entities).toHaveLength(2)
    expect(result.features[0].entities.map((e: { id: string }) => e.id)).not.toContain('circ1')
    expect(result.features[0].initial.circ1).toBeUndefined()
    expect(result.features[0].initial.line1).toBeDefined()
  })

  it('deletes a constraint', () => {
    const doc = parseYamlDoc(SAMPLE_YAML)
    applyDeleteElements(doc, ['constraint:Sketch1:c_horiz'])
    const result = doc.toJSON()
    expect(result.features[0].constraints).toHaveLength(1)
    expect(result.features[0].constraints[0].id).toBe('c_len')
  })

  it('deletes multiple elements at once', () => {
    const doc = parseYamlDoc(SAMPLE_YAML)
    applyDeleteElements(doc, ['entity:Sketch1:line1', 'constraint:Sketch1:c_len'])
    const result = doc.toJSON()
    expect(result.features[0].entities).toHaveLength(2)
    expect(result.features[0].constraints).toHaveLength(1)
    expect(result.features[0].initial.line1).toBeUndefined()
  })
})
