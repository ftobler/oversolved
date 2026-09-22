import { describe, it, expect } from 'vitest'
import type { PartDoc } from '@/types/cad'
import { applyMoveEntity, applySetConstraintValue, applyAddEntity, applyAddProjectedEntity } from '@/utils/yamlMutations/sketch'
import { applyRenamePart, applySetPartColor, applySetPartTransparency, applySetPartMetalness, applySetPartRoughness, applySetPartTransmission, applyReorderPickField } from '@/utils/yamlMutations/partStyle'
import { applyAddFillet, applyAddChamfer, applySetFilletField, applySetChamferField } from '@/utils/yamlMutations/featureDefs'
import { applyAddBoolean, applySetBooleanField } from '@/utils/yamlMutations/featureDefs'
import { applySetArrayField } from '@/utils/yamlMutations/featureDefs'
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

  // round(NaN) is NaN: a non-finite value must be rejected, not persisted.
  it('ignores a non-finite value instead of persisting NaN', () => {
    const doc = makeSketchDoc()
    applySetConstraintValue(doc, 'Sketch1', 'c_len', NaN)
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

  it('honours a caller-supplied entity id', () => {
    const doc = makeSketchDoc()
    applyAddProjectedEntity(doc, 'Sketch1', 'line', '@otherSketch/edge/0', 'proj1')
    expect(doc.features![0].entities![2].id).toBe('proj1')
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

// The four clamped [0, 1] part-style fields differ only by field name, so the
// set / clamp-high / clamp-low / preserve shape is one table, not four blocks.
describe('applySetPart* clamped fields', () => {
  const fields = [
    ['transparency', applySetPartTransparency],
    ['roughness', applySetPartRoughness],
    ['transmission', applySetPartTransmission],
    ['metalness', applySetPartMetalness],
  ] as const

  it.each(fields)('%s sets a finite value', (field, setter) => {
    const doc: PartDoc = { version: 1, kind: 'part' }
    setter(doc, 'body_ex1', 0.5)
    expect(doc.part_style!.body_ex1[field]).toBe(0.5)
  })

  it.each(fields)('%s clamps values above 1', (field, setter) => {
    const doc: PartDoc = { version: 1, kind: 'part' }
    setter(doc, 'body_ex1', 5)
    expect(doc.part_style!.body_ex1[field]).toBe(1)
  })

  it.each(fields)('%s clamps values below 0', (field, setter) => {
    const doc: PartDoc = { version: 1, kind: 'part' }
    setter(doc, 'body_ex1', -1)
    expect(doc.part_style!.body_ex1[field]).toBe(0)
  })

  it.each(fields)('%s preserves existing part_style fields', (field, setter) => {
    const doc: PartDoc = { version: 1, kind: 'part', part_style: { body_ex1: { name: 'Part' } } }
    setter(doc, 'body_ex1', 0.5)
    expect(doc.part_style!.body_ex1.name).toBe('Part')
    expect(doc.part_style!.body_ex1[field]).toBe(0.5)
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

describe('applySetFilletField', () => {
  it('sets fillet radius', () => {
    const doc: PartDoc = { version: 1, kind: 'part', features: [{ id: 'fillet1', kind: 'fillet', fillet: { edges: [], radius: 1 } }] }
    applySetFilletField(doc, 'fillet1', 'radius', 5)
    expect(doc.features![0].fillet!.radius).toBe(5)
  })

  it('no-ops for feature without fillet', () => {
    const doc: PartDoc = { version: 1, kind: 'part', features: [{ id: 'ext1', kind: 'extrude', extrude: { sketch: ['s1'], distance: 10, direction: 'normal' } }] }
    applySetFilletField(doc, 'ext1', 'radius', 5)
    expect(doc.features![0].extrude!.distance).toBe(10)
  })
})

describe('applySetChamferField', () => {
  it('sets chamfer distance', () => {
    const doc: PartDoc = { version: 1, kind: 'part', features: [{ id: 'chamfer1', kind: 'chamfer', chamfer: { edges: [], distance: 1, kind: 'distance', angle: 45 } }] }
    applySetChamferField(doc, 'chamfer1', 'distance', 3)
    expect(doc.features![0].chamfer!.distance).toBe(3)
  })

  it('no-ops for feature without chamfer', () => {
    const doc: PartDoc = { version: 1, kind: 'part', features: [] }
    applySetChamferField(doc, 'nonexistent', 'distance', 3)
    expect(doc.features).toHaveLength(0)
  })
})

describe('applySetChamferField angle', () => {
  it('sets chamfer angle', () => {
    const doc: PartDoc = { version: 1, kind: 'part', features: [{ id: 'chamfer1', kind: 'chamfer', chamfer: { edges: [], distance: 1, kind: 'distance', angle: 45 } }] }
    applySetChamferField(doc, 'chamfer1', 'angle', 60)
    expect(doc.features![0].chamfer!.angle).toBe(60)
  })
})

describe('applySetChamferField kind', () => {
  it('sets chamfer kind to angle_distance', () => {
    const doc: PartDoc = { version: 1, kind: 'part', features: [{ id: 'chamfer1', kind: 'chamfer', chamfer: { edges: [], distance: 1, kind: 'distance', angle: 45 } }] }
    applySetChamferField(doc, 'chamfer1', 'kind', 'angle_distance')
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

describe('applySetBooleanField operation', () => {
  it('sets boolean operation', () => {
    const doc: PartDoc = { version: 1, kind: 'part', features: [{ id: 'bool1', kind: 'boolean', boolean: { operation: 'union', target: '', tools: [] } }] }
    applySetBooleanField(doc, 'bool1', 'operation', 'subtract')
    expect(doc.features![0].boolean!.operation).toBe('subtract')
  })

  it('no-ops for feature without boolean', () => {
    const doc: PartDoc = { version: 1, kind: 'part', features: [{ id: 'ext1', kind: 'extrude', extrude: { sketch: ['s1'], distance: 10, direction: 'normal' } }] }
    applySetBooleanField(doc, 'ext1', 'operation', 'intersect')
    expect(doc.features![0].extrude!.distance).toBe(10)
  })
})

describe('applySetBooleanField target', () => {
  it('sets boolean target', () => {
    const doc: PartDoc = { version: 1, kind: 'part', features: [{ id: 'bool1', kind: 'boolean', boolean: { operation: 'union', target: '', tools: [] } }] }
    applySetBooleanField(doc, 'bool1', 'target', '@body_ex1')
    expect(doc.features![0].boolean!.target).toBe('@body_ex1')
  })
})

describe('applySetBooleanField keep_tools', () => {
  it('sets boolean keep_tools', () => {
    const doc: PartDoc = { version: 1, kind: 'part', features: [{ id: 'bool1', kind: 'boolean', boolean: { operation: 'union', target: '', tools: [] } }] }
    applySetBooleanField(doc, 'bool1', 'keep_tools', true)
    expect(doc.features![0].boolean!.keep_tools).toBe(true)
  })

  it('can set keep_tools to false', () => {
    const doc: PartDoc = { version: 1, kind: 'part', features: [{ id: 'bool1', kind: 'boolean', boolean: { operation: 'union', target: '', tools: [] } }] }
    applySetBooleanField(doc, 'bool1', 'keep_tools', false)
    expect(doc.features![0].boolean!.keep_tools).toBe(false)
  })
})

describe('applySetArrayField direction_x_query', () => {
  it('sets direction_x_query on array feature', () => {
    const doc: PartDoc = { version: 1, kind: 'part', features: [{ id: 'arr1', kind: 'array', array: { mode: 'linear', count_x: 2, pitch_x: 20, direction_x: [1, 0, 0], operation: 'add', include_source: true } }] }
    applySetArrayField(doc, 'arr1', 'direction_x_query', '@body_ex1/edge/0')
    expect(doc.features![0].array!.direction_x_query).toBe('@body_ex1/edge/0')
  })

  it('no-ops for feature without array', () => {
    const doc: PartDoc = { version: 1, kind: 'part', features: [{ id: 'ext1', kind: 'extrude', extrude: { sketch: ['s1'], distance: 10, direction: 'normal' } }] }
    applySetArrayField(doc, 'ext1', 'direction_x_query', '@body_ex1/edge/0')
    expect(doc.features![0].extrude!.distance).toBe(10)
  })
})

describe('applySetArrayField direction_y_query', () => {
  it('sets direction_y_query on array feature', () => {
    const doc: PartDoc = { version: 1, kind: 'part', features: [{ id: 'arr1', kind: 'array', array: { mode: 'rectangular', count_x: 2, pitch_x: 20, count_y: 2, pitch_y: 20, direction_x: [1, 0, 0], direction_y: [0, 1, 0], operation: 'add', include_source: true } }] }
    applySetArrayField(doc, 'arr1', 'direction_y_query', '@body_ex1/edge/1')
    expect(doc.features![0].array!.direction_y_query).toBe('@body_ex1/edge/1')
  })
})

describe('applySetArrayField direction_x', () => {
  it('sets direction_x on array feature', () => {
    const doc: PartDoc = { version: 1, kind: 'part', features: [{ id: 'arr1', kind: 'array', array: { mode: 'linear', count_x: 2, pitch_x: 20, direction_x: [1, 0, 0], operation: 'add', include_source: true } }] }
    applySetArrayField(doc, 'arr1', 'direction_x', [0, 1, 0])
    expect(doc.features![0].array!.direction_x).toEqual([0, 1, 0])
  })
})

describe('applySetArrayField direction_y', () => {
  it('sets direction_y on array feature', () => {
    const doc: PartDoc = { version: 1, kind: 'part', features: [{ id: 'arr1', kind: 'array', array: { mode: 'rectangular', count_x: 2, pitch_x: 20, count_y: 2, pitch_y: 20, direction_x: [1, 0, 0], direction_y: [0, 1, 0], operation: 'add', include_source: true } }] }
    applySetArrayField(doc, 'arr1', 'direction_y', [1, 0, 0])
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

  it('reorders sweep profile sketches', () => {
    const doc: PartDoc = { version: 1, kind: 'part', features: [{ id: 'sw1', kind: 'sweep', sweep: { sketch: ['s1', 's2', 's3'], path: ['p1'] } }] }
    applyReorderPickField(doc, 'sw1', 'sketch', 0, 2)
    expect(doc.features![0].sweep!.sketch).toEqual(['s2', 's3', 's1'])
  })

  it('reorders sweep paths', () => {
    const doc: PartDoc = { version: 1, kind: 'part', features: [{ id: 'sw2', kind: 'sweep', sweep: { sketch: ['s1'], path: ['p1', 'p2', 'p3'] } }] }
    applyReorderPickField(doc, 'sw2', 'path', 2, 0)
    expect(doc.features![0].sweep!.path).toEqual(['p3', 'p1', 'p2'])
  })

  it('leaves sweep picks untouched when the requested order already holds', () => {
    const doc: PartDoc = { version: 1, kind: 'part', features: [{ id: 'sw5', kind: 'sweep', sweep: { sketch: ['s1', 's2'], path: ['p1'] } }] }
    applyReorderPickField(doc, 'sw5', 'sketch', 1, 1)
    applyReorderPickField(doc, 'sw5', 'path', 0, 0)
    expect(doc.features![0].sweep!.sketch).toEqual(['s1', 's2'])
    expect(doc.features![0].sweep!.path).toEqual(['p1'])
  })

  it('normalizes a bare-string extrude sketch onto the live document instead of a throwaway array', () => {
    const doc: PartDoc = { version: 1, kind: 'part', features: [{ id: 'ext2', kind: 'extrude', extrude: { sketch: 's1', distance: 10, direction: 'normal' } }] }
    applyReorderPickField(doc, 'ext2', 'sketch', 0, 0)
    expect(doc.features![0].extrude!.sketch).toEqual(['s1'])
  })

  it('normalizes a bare-string revolve sketch onto the live document instead of a throwaway array', () => {
    const doc: PartDoc = { version: 1, kind: 'part', features: [{ id: 'rev2', kind: 'revolve', revolve: { sketch: 's1', angle: 90, axis_origin: [0, 0, 0], axis_direction: [0, 0, 1] } }] }
    applyReorderPickField(doc, 'rev2', 'sketch', 0, 0)
    expect(doc.features![0].revolve!.sketch).toEqual(['s1'])
  })

  it('normalizes a bare-string sweep sketch onto the live document instead of a throwaway array', () => {
    const doc: PartDoc = { version: 1, kind: 'part', features: [{ id: 'sw3', kind: 'sweep', sweep: { sketch: 's1', path: ['p1'] } }] }
    applyReorderPickField(doc, 'sw3', 'sketch', 0, 0)
    expect(doc.features![0].sweep!.sketch).toEqual(['s1'])
  })

  it('normalizes a bare-string sweep path onto the live document instead of a throwaway array', () => {
    const doc: PartDoc = { version: 1, kind: 'part', features: [{ id: 'sw4', kind: 'sweep', sweep: { sketch: ['s1'], path: 'p1' } }] }
    applyReorderPickField(doc, 'sw4', 'path', 0, 0)
    expect(doc.features![0].sweep!.path).toEqual(['p1'])
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
