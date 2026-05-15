import { describe, it, expect } from 'vitest'
import type { PartDoc } from '@/types/cad'
import { applyMoveEntity, applySetConstraintValue, applyAddEntity, applyAddProjectedEntity } from '@/utils/yamlMutations/sketch'
import { applyRenamePart, applySetPartColor, applySetPartTransparency, applySetPartMetalness, applyReorderPickField } from '@/utils/yamlMutations/partStyle'
import { applyAddFillet, applyAddChamfer, applySetFilletRadius, applySetChamferDistance, applySetChamferAngle, applySetChamferKind } from '@/utils/yamlMutations/featureDefs'
import { applyAddBoolean, applySetBooleanOperation, applySetBooleanTarget, applySetBooleanKeepTools } from '@/utils/yamlMutations/featureDefs'
import { applySetArrayDirectionXQuery, applySetArrayDirectionYQuery, applySetArrayDirectionX, applySetArrayDirectionY } from '@/utils/yamlMutations/featureDefs'
import { randomId } from '@/utils/yamlMutations/helpers'

function makeSketchDoc(): PartDoc {
  return {
    version: 1,
    kind: 'part',
    features: [
      {
        id: 'Sketch1',
        kind: 'sketch',
        entities: [
          { id: 'line1', kind: 'line' },
          { id: 'circ1', kind: 'circle' },
        ],
        initial: {
          line1: [0, 0, 10, 0],
          circ1: [5, 5, 3],
        },
        constraints: [
          { id: 'c_horiz', kind: 'horizontal', target: '$line1' },
          { id: 'c_len', kind: 'length', target: '$line1', value: 10 },
        ],
      },
    ],
  }
}

describe('applyMoveEntity', () => {
  it('moves entity by delta', () => {
    const doc = makeSketchDoc()
    applyMoveEntity(doc, 'Sketch1', 'line1', [2, 3])
    expect(doc.features![0].initial!.line1).toEqual([2, 3, 12, 3])
  })

  it('no-ops when delta is zero', () => {
    const doc = makeSketchDoc()
    applyMoveEntity(doc, 'Sketch1', 'line1', [0, 0])
    expect(doc.features![0].initial!.line1).toEqual([0, 0, 10, 0])
  })

  it('no-ops for unknown entity', () => {
    const doc = makeSketchDoc()
    applyMoveEntity(doc, 'Sketch1', 'nonexistent', [5, 5])
    expect(doc.features![0].initial!.line1).toEqual([0, 0, 10, 0])
  })

  it('moves circle by delta', () => {
    const doc = makeSketchDoc()
    applyMoveEntity(doc, 'Sketch1', 'circ1', [-1, 2])
    expect(doc.features![0].initial!.circ1).toEqual([4, 7, 3])
  })
})

describe('applySetConstraintValue', () => {
  it('sets constraint value rounded to 3 decimal places', () => {
    const doc = makeSketchDoc()
    applySetConstraintValue(doc, 'Sketch1', 'c_len', 42.5678)
    expect(doc.features![0].constraints!.find(c => c.id === 'c_len')!.value).toBe(42.568)
  })

  it('no-ops for unknown constraint id', () => {
    const doc = makeSketchDoc()
    applySetConstraintValue(doc, 'Sketch1', 'nonexistent', 99)
    expect(doc.features![0].constraints!.find(c => c.id === 'c_len')!.value).toBe(10)
  })

  it('no-ops for unknown feature', () => {
    const doc = makeSketchDoc()
    applySetConstraintValue(doc, 'NoSuchFeature', 'c_len', 99)
    expect(doc.features![0].constraints!.find(c => c.id === 'c_len')!.value).toBe(10)
  })
})

describe('applyAddEntity', () => {
  it('adds an entity with computed id', () => {
    const doc = makeSketchDoc()
    applyAddEntity(doc, 'Sketch1', 'circle', [10, 10, 5])
    expect(doc.features![0].entities).toHaveLength(3)
    const added = doc.features![0].entities![2]
    expect(added.kind).toBe('circle')
    expect(doc.features![0].initial![added.id]).toEqual([10, 10, 5])
  })

  it('adds an entity with specified id', () => {
    const doc = makeSketchDoc()
    applyAddEntity(doc, 'Sketch1', 'line', [0, 0, 5, 5], 'customId')
    expect(doc.features![0].entities).toHaveLength(3)
    const added = doc.features![0].entities![2]
    expect(added.id).toBe('customId')
    expect(added.kind).toBe('line')
  })

  it('no-ops for unknown feature', () => {
    const doc = makeSketchDoc()
    applyAddEntity(doc, 'NoSuchFeature', 'circle', [0, 0, 5])
    expect(doc.features![0].entities).toHaveLength(2)
  })

  it('initializes entities and initial arrays if missing', () => {
    const doc: PartDoc = { version: 1, kind: 'part', features: [{ id: 'Sketch1', kind: 'sketch' }] }
    applyAddEntity(doc, 'Sketch1', 'line', [0, 0, 10, 0])
    expect(doc.features![0].entities).toHaveLength(1)
    expect(doc.features![0].initial).toBeDefined()
  })

  it('rounds coordinates to 6 decimal places', () => {
    const doc = makeSketchDoc()
    applyAddEntity(doc, 'Sketch1', 'line', [1.23456789, 9.87654321, 0, 0])
    const added = doc.features![0].entities![2]
    expect(doc.features![0].initial![added.id]).toEqual([1.234568, 9.876543, 0, 0])
  })
})

describe('applyAddProjectedEntity', () => {
  it('adds a projected entity with source', () => {
    const doc = makeSketchDoc()
    applyAddProjectedEntity(doc, 'Sketch1', 'line', '@otherSketch/edge/0')
    expect(doc.features![0].entities).toHaveLength(3)
    const added = doc.features![0].entities![2]
    expect(added.kind).toBe('line')
    expect(added.source).toBe('@otherSketch/edge/0')
  })

  it('no-ops for unknown feature', () => {
    const doc = makeSketchDoc()
    applyAddProjectedEntity(doc, 'NoSuchFeature', 'line', '@other/edge/0')
    expect(doc.features![0].entities).toHaveLength(2)
  })

  it('initializes entities array if missing', () => {
    const doc: PartDoc = { version: 1, kind: 'part', features: [{ id: 'S1', kind: 'sketch' }] }
    applyAddProjectedEntity(doc, 'S1', 'circle', '@other/edge/1')
    expect(doc.features![0].entities).toHaveLength(1)
  })
})

describe('applyRenamePart', () => {
  it('sets part name in part_style', () => {
    const doc: PartDoc = { version: 1, kind: 'part' }
    applyRenamePart(doc, 'body_ex1', 'My Part')
    expect(doc.part_style!.body_ex1.name).toBe('My Part')
  })

  it('trims whitespace from name', () => {
    const doc: PartDoc = { version: 1, kind: 'part' }
    applyRenamePart(doc, 'body_ex1', '  Spaced Name  ')
    expect(doc.part_style!.body_ex1.name).toBe('Spaced Name')
  })

  it('no-ops on empty name', () => {
    const doc: PartDoc = { version: 1, kind: 'part' }
    applyRenamePart(doc, 'body_ex1', '   ')
    expect(doc.part_style).toBeUndefined()
  })

  it('initialises part_style if absent', () => {
    const doc: PartDoc = { version: 1, kind: 'part' }
    applyRenamePart(doc, 'body_ex1', 'Name')
    expect(doc.part_style).toBeDefined()
  })
})

describe('applySetPartColor', () => {
  it('sets part color', () => {
    const doc: PartDoc = { version: 1, kind: 'part' }
    applySetPartColor(doc, 'body_ex1', '#ff0000')
    expect(doc.part_style!.body_ex1.color).toBe('#ff0000')
  })

  it('trims whitespace', () => {
    const doc: PartDoc = { version: 1, kind: 'part' }
    applySetPartColor(doc, 'body_ex1', '  #00ff00  ')
    expect(doc.part_style!.body_ex1.color).toBe('#00ff00')
  })

  it('no-ops on empty color', () => {
    const doc: PartDoc = { version: 1, kind: 'part' }
    applySetPartColor(doc, 'body_ex1', '   ')
    expect(doc.part_style).toBeUndefined()
  })

  it('preserves existing part_style fields', () => {
    const doc: PartDoc = { version: 1, kind: 'part', part_style: { body_ex1: { name: 'My Part' } } }
    applySetPartColor(doc, 'body_ex1', '#0000ff')
    expect(doc.part_style!.body_ex1.name).toBe('My Part')
    expect(doc.part_style!.body_ex1.color).toBe('#0000ff')
  })
})

describe('applySetPartTransparency', () => {
  it('sets transparency clamped to [0, 1]', () => {
    const doc: PartDoc = { version: 1, kind: 'part' }
    applySetPartTransparency(doc, 'body_ex1', 0.5)
    expect(doc.part_style!.body_ex1.transparency).toBe(0.5)
  })

  it('clamps values above 1', () => {
    const doc: PartDoc = { version: 1, kind: 'part' }
    applySetPartTransparency(doc, 'body_ex1', 5)
    expect(doc.part_style!.body_ex1.transparency).toBe(1)
  })

  it('clamps values below 0', () => {
    const doc: PartDoc = { version: 1, kind: 'part' }
    applySetPartTransparency(doc, 'body_ex1', -1)
    expect(doc.part_style!.body_ex1.transparency).toBe(0)
  })

  it('preserves existing part_style fields', () => {
    const doc: PartDoc = { version: 1, kind: 'part', part_style: { body_ex1: { color: '#fff' } } }
    applySetPartTransparency(doc, 'body_ex1', 0.3)
    expect(doc.part_style!.body_ex1.color).toBe('#fff')
    expect(doc.part_style!.body_ex1.transparency).toBe(0.3)
  })
})

describe('applySetPartMetalness', () => {
  it('sets metalness clamped to [0, 1]', () => {
    const doc: PartDoc = { version: 1, kind: 'part' }
    applySetPartMetalness(doc, 'body_ex1', 0.8)
    expect(doc.part_style!.body_ex1.metalness).toBe(0.8)
  })

  it('clamps values above 1', () => {
    const doc: PartDoc = { version: 1, kind: 'part' }
    applySetPartMetalness(doc, 'body_ex1', 2)
    expect(doc.part_style!.body_ex1.metalness).toBe(1)
  })

  it('clamps values below 0', () => {
    const doc: PartDoc = { version: 1, kind: 'part' }
    applySetPartMetalness(doc, 'body_ex1', -0.5)
    expect(doc.part_style!.body_ex1.metalness).toBe(0)
  })

  it('preserves existing part_style fields', () => {
    const doc: PartDoc = { version: 1, kind: 'part', part_style: { body_ex1: { name: 'Part' } } }
    applySetPartMetalness(doc, 'body_ex1', 0.5)
    expect(doc.part_style!.body_ex1.name).toBe('Part')
    expect(doc.part_style!.body_ex1.metalness).toBe(0.5)
  })
})

describe('applyAddFillet', () => {
  it('adds a fillet feature with defaults', () => {
    const doc: PartDoc = { version: 1, kind: 'part', features: [] }
    applyAddFillet(doc, 'fillet1')
    expect(doc.features).toHaveLength(1)
    expect(doc.features![0]).toMatchObject({ id: 'fillet1', kind: 'fillet', fillet: { edges: [], radius: 1 } })
  })

  it('uses label when provided', () => {
    const doc: PartDoc = { version: 1, kind: 'part', features: [] }
    applyAddFillet(doc, 'fillet1', 'My Fillet')
    expect(doc.features![0].label).toBe('My Fillet')
  })

  it('initializes features array if absent', () => {
    const doc: PartDoc = { version: 1, kind: 'part' }
    applyAddFillet(doc, 'fillet1')
    expect(doc.features).toHaveLength(1)
  })
})

describe('applyAddChamfer', () => {
  it('adds a chamfer feature with defaults', () => {
    const doc: PartDoc = { version: 1, kind: 'part', features: [] }
    applyAddChamfer(doc, 'chamfer1')
    expect(doc.features).toHaveLength(1)
    expect(doc.features![0]).toMatchObject({ id: 'chamfer1', kind: 'chamfer', chamfer: { edges: [], distance: 1, kind: 'distance', angle: 45 } })
  })

  it('uses label when provided', () => {
    const doc: PartDoc = { version: 1, kind: 'part', features: [] }
    applyAddChamfer(doc, 'chamfer1', 'My Chamfer')
    expect(doc.features![0].label).toBe('My Chamfer')
  })
})

describe('applySetFilletRadius', () => {
  it('sets fillet radius', () => {
    const doc: PartDoc = { version: 1, kind: 'part', features: [{ id: 'fillet1', kind: 'fillet', fillet: { edges: [], radius: 1 } }] }
    applySetFilletRadius(doc, 'fillet1', 5)
    expect(doc.features![0].fillet!.radius).toBe(5)
  })

  it('no-ops for feature without fillet', () => {
    const doc: PartDoc = { version: 1, kind: 'part', features: [{ id: 'ext1', kind: 'extrude', extrude: { sketch: ['s1'], distance: 10, direction: 'normal' } }] }
    applySetFilletRadius(doc, 'ext1', 5)
    expect(doc.features![0].extrude!.distance).toBe(10)
  })
})

describe('applySetChamferDistance', () => {
  it('sets chamfer distance', () => {
    const doc: PartDoc = { version: 1, kind: 'part', features: [{ id: 'chamfer1', kind: 'chamfer', chamfer: { edges: [], distance: 1, kind: 'distance', angle: 45 } }] }
    applySetChamferDistance(doc, 'chamfer1', 3)
    expect(doc.features![0].chamfer!.distance).toBe(3)
  })

  it('no-ops for feature without chamfer', () => {
    const doc: PartDoc = { version: 1, kind: 'part', features: [] }
    applySetChamferDistance(doc, 'nonexistent', 3)
    expect(doc.features).toHaveLength(0)
  })
})

describe('applySetChamferAngle', () => {
  it('sets chamfer angle', () => {
    const doc: PartDoc = { version: 1, kind: 'part', features: [{ id: 'chamfer1', kind: 'chamfer', chamfer: { edges: [], distance: 1, kind: 'distance', angle: 45 } }] }
    applySetChamferAngle(doc, 'chamfer1', 60)
    expect(doc.features![0].chamfer!.angle).toBe(60)
  })
})

describe('applySetChamferKind', () => {
  it('sets chamfer kind to angle_distance', () => {
    const doc: PartDoc = { version: 1, kind: 'part', features: [{ id: 'chamfer1', kind: 'chamfer', chamfer: { edges: [], distance: 1, kind: 'distance', angle: 45 } }] }
    applySetChamferKind(doc, 'chamfer1', 'angle_distance')
    expect(doc.features![0].chamfer!.kind).toBe('angle_distance')
  })
})

describe('applyAddBoolean', () => {
  it('adds a boolean feature with defaults', () => {
    const doc: PartDoc = { version: 1, kind: 'part', features: [] }
    applyAddBoolean(doc, 'bool1')
    expect(doc.features).toHaveLength(1)
    expect(doc.features![0]).toMatchObject({ id: 'bool1', kind: 'boolean', boolean: { operation: 'union', target: '', tools: [] } })
  })

  it('uses label when provided', () => {
    const doc: PartDoc = { version: 1, kind: 'part', features: [] }
    applyAddBoolean(doc, 'bool1', 'My Boolean')
    expect(doc.features![0].label).toBe('My Boolean')
  })

  it('initializes features array if absent', () => {
    const doc: PartDoc = { version: 1, kind: 'part' }
    applyAddBoolean(doc, 'bool1')
    expect(doc.features).toHaveLength(1)
  })
})

describe('applySetBooleanOperation', () => {
  it('sets boolean operation', () => {
    const doc: PartDoc = { version: 1, kind: 'part', features: [{ id: 'bool1', kind: 'boolean', boolean: { operation: 'union', target: '', tools: [] } }] }
    applySetBooleanOperation(doc, 'bool1', 'difference')
    expect(doc.features![0].boolean!.operation).toBe('difference')
  })

  it('no-ops for feature without boolean', () => {
    const doc: PartDoc = { version: 1, kind: 'part', features: [{ id: 'ext1', kind: 'extrude', extrude: { sketch: ['s1'], distance: 10, direction: 'normal' } }] }
    applySetBooleanOperation(doc, 'ext1', 'intersection')
    expect(doc.features![0].extrude!.distance).toBe(10)
  })
})

describe('applySetBooleanTarget', () => {
  it('sets boolean target', () => {
    const doc: PartDoc = { version: 1, kind: 'part', features: [{ id: 'bool1', kind: 'boolean', boolean: { operation: 'union', target: '', tools: [] } }] }
    applySetBooleanTarget(doc, 'bool1', '@body_ex1')
    expect(doc.features![0].boolean!.target).toBe('@body_ex1')
  })
})

describe('applySetBooleanKeepTools', () => {
  it('sets boolean keep_tools', () => {
    const doc: PartDoc = { version: 1, kind: 'part', features: [{ id: 'bool1', kind: 'boolean', boolean: { operation: 'union', target: '', tools: [] } }] }
    applySetBooleanKeepTools(doc, 'bool1', true)
    expect(doc.features![0].boolean!.keep_tools).toBe(true)
  })

  it('can set keep_tools to false', () => {
    const doc: PartDoc = { version: 1, kind: 'part', features: [{ id: 'bool1', kind: 'boolean', boolean: { operation: 'union', target: '', tools: [] } }] }
    applySetBooleanKeepTools(doc, 'bool1', false)
    expect(doc.features![0].boolean!.keep_tools).toBe(false)
  })
})

describe('applySetArrayDirectionXQuery', () => {
  it('sets direction_x_query on array feature', () => {
    const doc: PartDoc = { version: 1, kind: 'part', features: [{ id: 'arr1', kind: 'array', array: { mode: 'linear', count_x: 2, pitch_x: 20, direction_x: [1, 0, 0], operation: 'add', include_source: true } }] }
    applySetArrayDirectionXQuery(doc, 'arr1', '@body_ex1/edge/0')
    expect(doc.features![0].array!.direction_x_query).toBe('@body_ex1/edge/0')
  })

  it('no-ops for feature without array', () => {
    const doc: PartDoc = { version: 1, kind: 'part', features: [{ id: 'ext1', kind: 'extrude', extrude: { sketch: ['s1'], distance: 10, direction: 'normal' } }] }
    applySetArrayDirectionXQuery(doc, 'ext1', '@body_ex1/edge/0')
    expect(doc.features![0].extrude!.distance).toBe(10)
  })
})

describe('applySetArrayDirectionYQuery', () => {
  it('sets direction_y_query on array feature', () => {
    const doc: PartDoc = { version: 1, kind: 'part', features: [{ id: 'arr1', kind: 'array', array: { mode: 'rectangular', count_x: 2, pitch_x: 20, count_y: 2, pitch_y: 20, direction_x: [1, 0, 0], direction_y: [0, 1, 0], operation: 'add', include_source: true } }] }
    applySetArrayDirectionYQuery(doc, 'arr1', '@body_ex1/edge/1')
    expect(doc.features![0].array!.direction_y_query).toBe('@body_ex1/edge/1')
  })
})

describe('applySetArrayDirectionX', () => {
  it('sets direction_x on array feature', () => {
    const doc: PartDoc = { version: 1, kind: 'part', features: [{ id: 'arr1', kind: 'array', array: { mode: 'linear', count_x: 2, pitch_x: 20, direction_x: [1, 0, 0], operation: 'add', include_source: true } }] }
    applySetArrayDirectionX(doc, 'arr1', [0, 1, 0])
    expect(doc.features![0].array!.direction_x).toEqual([0, 1, 0])
  })
})

describe('applySetArrayDirectionY', () => {
  it('sets direction_y on array feature', () => {
    const doc: PartDoc = { version: 1, kind: 'part', features: [{ id: 'arr1', kind: 'array', array: { mode: 'rectangular', count_x: 2, pitch_x: 20, count_y: 2, pitch_y: 20, direction_x: [1, 0, 0], direction_y: [0, 1, 0], operation: 'add', include_source: true } }] }
    applySetArrayDirectionY(doc, 'arr1', [1, 0, 0])
    expect(doc.features![0].array!.direction_y).toEqual([1, 0, 0])
  })
})

describe('applyReorderPickField', () => {
  it('reorders fillet edges', () => {
    const doc: PartDoc = { version: 1, kind: 'part', features: [{ id: 'fillet1', kind: 'fillet', fillet: { edges: ['e1', 'e2', 'e3'], radius: 1 } }] }
    applyReorderPickField(doc, 'fillet1', 'edges', 0, 2)
    expect(doc.features![0].fillet!.edges).toEqual(['e2', 'e3', 'e1'])
  })

  it('reorders chamfer edges', () => {
    const doc: PartDoc = { version: 1, kind: 'part', features: [{ id: 'chamfer1', kind: 'chamfer', chamfer: { edges: ['e1', 'e2'], distance: 1, kind: 'distance', angle: 45 } }] }
    applyReorderPickField(doc, 'chamfer1', 'edges', 1, 0)
    expect(doc.features![0].chamfer!.edges).toEqual(['e2', 'e1'])
  })

  it('reorders boolean tools', () => {
    const doc: PartDoc = { version: 1, kind: 'part', features: [{ id: 'bool1', kind: 'boolean', boolean: { operation: 'union', target: '', tools: ['@body_a', '@body_b', '@body_c'] } }] }
    applyReorderPickField(doc, 'bool1', 'tools', 2, 0)
    expect(doc.features![0].boolean!.tools).toEqual(['@body_c', '@body_a', '@body_b'])
  })

  it('reorders extrude sketch', () => {
    const doc: PartDoc = { version: 1, kind: 'part', features: [{ id: 'ext1', kind: 'extrude', extrude: { sketch: ['s1', 's2', 's3'], distance: 10, direction: 'normal' } }] }
    applyReorderPickField(doc, 'ext1', 'sketch', 0, 2)
    expect(doc.features![0].extrude!.sketch).toEqual(['s2', 's3', 's1'])
  })

  it('reorders revolve sketch', () => {
    const doc: PartDoc = { version: 1, kind: 'part', features: [{ id: 'rev1', kind: 'revolve', revolve: { sketch: ['s1', 's2'], angle: 90, axis_origin: [0, 0, 0], axis_direction: [0, 0, 1] } }] }
    applyReorderPickField(doc, 'rev1', 'sketch', 1, 0)
    expect(doc.features![0].revolve!.sketch).toEqual(['s2', 's1'])
  })

  it('no-ops for unknown feature id', () => {
    const doc: PartDoc = { version: 1, kind: 'part', features: [] }
    expect(() => applyReorderPickField(doc, 'nonexistent', 'edges', 0, 1)).not.toThrow()
  })

  it('no-ops for unknown field', () => {
    const doc: PartDoc = { version: 1, kind: 'part', features: [{ id: 'f1', kind: 'fillet', fillet: { edges: ['e1'], radius: 1 } }] }
    applyReorderPickField(doc, 'f1', 'unknown_field', 0, 0)
    expect(doc.features![0].fillet!.edges).toEqual(['e1'])
  })
})

describe('randomId', () => {
  it('returns a string of expected length', () => {
    const id = randomId(18)
    expect(id).toHaveLength(24)  // base64url of 18 bytes: 18*4/3 = 24, no padding
  })

  it('returns unique ids', () => {
    const ids = new Set(Array.from({ length: 100 }, () => randomId(12)))
    expect(ids.size).toBe(100)
  })

  it('produces URL-safe base64 (no +, / or =)', () => {
    const id = randomId(18)
    expect(id).not.toContain('+')
    expect(id).not.toContain('/')
    expect(id).not.toContain('=')
  })

  it('returns different lengths for different byte counts', () => {
    const id12 = randomId(12)
    const id18 = randomId(18)
    expect(id12.length).toBeLessThan(id18.length)
  })
})
