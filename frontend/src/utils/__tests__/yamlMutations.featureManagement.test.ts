import { describe, it, expect } from 'vitest'
import type { PartDoc } from '@/types/cad'
import {
  applySetFeatureVisibility, applyAddPlane, applySetPlaneDefinitionField, applyDeleteFeature,
  applyReorderFeatures,
} from '@/utils/yamlMutations'
import {
  applyRemoveExtrudeProfile, applyRemoveFilletEdge, applyRemoveDeleteBodyRef, applyRemoveTransformBody,
} from '@/utils/yamlMutations'

const makeSampleDoc = (): PartDoc => ({
  version: 1,
  kind: 'part',
  features: [
    {
      id: 'Sketch1',
      kind: 'sketch',
      initial: {
        line1: [0, 0, 10, 0],
        circ1: [5, 5, 3],
        pt1: [1, 2],
      },
      entities: [
        { id: 'line1', kind: 'line' },
        { id: 'circ1', kind: 'circle' },
        { id: 'pt1', kind: 'point' },
      ],
      constraints: [
        { id: 'c_horiz', kind: 'horizontal', target: '$line1' },
        { id: 'c_len', kind: 'length', target: '$line1', value: 10 },
      ],
    },
  ],
})

// ─── Feature visibility (applySetFeatureVisibility) ───

const docWithFeatures = (): PartDoc => ({
  version: 1, kind: 'part',
  features: [
    { id: 'Origin', kind: 'origin' },
    { id: 'Front',  kind: 'plane' },
    { id: 'sketch1', kind: 'sketch' },
  ],
})

describe('applySetFeatureVisibility', () => {
  it('sets visible:false when hiding', () => {
    const doc = docWithFeatures()
    applySetFeatureVisibility(doc, 'sketch1', false)
    expect(doc.features!.find(f => f.id === 'sketch1')!.visible).toBe(false)
  })

  it('removes the visible property when showing (keeps YAML clean)', () => {
    const doc = docWithFeatures()
    doc.features!.find(f => f.id === 'sketch1')!.visible = false
    applySetFeatureVisibility(doc, 'sketch1', true)
    expect('visible' in doc.features!.find(f => f.id === 'sketch1')!).toBe(false)
  })

  it('works on built-in features (origin)', () => {
    const doc = docWithFeatures()
    applySetFeatureVisibility(doc, 'Origin', false)
    expect(doc.features!.find(f => f.id === 'Origin')!.visible).toBe(false)
  })

  it('works on built-in features (plane)', () => {
    const doc = docWithFeatures()
    applySetFeatureVisibility(doc, 'Front', false)
    expect(doc.features!.find(f => f.id === 'Front')!.visible).toBe(false)
  })

  it('no-ops for unknown feature id', () => {
    const doc = docWithFeatures()
    applySetFeatureVisibility(doc, 'nonexistent', false)
    expect(doc.features!.every(f => f.visible === undefined)).toBe(true)
  })

  it('does not affect other features when hiding one', () => {
    const doc = docWithFeatures()
    applySetFeatureVisibility(doc, 'sketch1', false)
    expect(doc.features!.find(f => f.id === 'Origin')!.visible).toBeUndefined()
    expect(doc.features!.find(f => f.id === 'Front')!.visible).toBeUndefined()
  })
})

describe('applyAddPlane', () => {
  it('adds a plane feature with default offset mode', () => {
    const doc: PartDoc = { version: 1, kind: 'part', features: [] }
    applyAddPlane(doc, 'plane1')
    expect(doc.features).toHaveLength(1)
    expect(doc.features![0]).toEqual({ id: 'plane1', kind: 'plane', definition: { mode: 'offset', plane: '@builtin_plane_front' } })
  })

  it('creates features array if missing', () => {
    const doc: PartDoc = { version: 1, kind: 'part' }
    applyAddPlane(doc, 'plane1')
    expect(doc.features).toHaveLength(1)
  })

  it('appends to existing features', () => {
    const doc = makeSampleDoc()
    applyAddPlane(doc, 'plane1')
    expect(doc.features).toHaveLength(2)
    expect(doc.features![1].id).toBe('plane1')
  })
})

describe('applySetPlaneDefinitionField', () => {
  it('sets plane field on a plane feature', () => {
    const doc: PartDoc = { version: 1, kind: 'part', features: [{ id: 'plane1', kind: 'plane', definition: { mode: 'offset' } }] }
    applySetPlaneDefinitionField(doc, 'plane1', 'plane', '@builtin_plane_top')
    expect(doc.features![0].definition!.plane).toBe('@builtin_plane_top')
  })

  it('sets offset field', () => {
    const doc: PartDoc = { version: 1, kind: 'part', features: [{ id: 'plane1', kind: 'plane', definition: { mode: 'offset' } }] }
    applySetPlaneDefinitionField(doc, 'plane1', 'offset', 25)
    expect(doc.features![0].definition!.offset).toBe(25)
  })

  it('creates definition if missing', () => {
    const doc: PartDoc = { version: 1, kind: 'part', features: [{ id: 'plane1', kind: 'plane' }] }
    applySetPlaneDefinitionField(doc, 'plane1', 'mode', 'three_point')
    expect(doc.features![0].definition).toBeDefined()
    expect((doc.features![0].definition as Record<string, unknown>).mode).toBe('three_point')
  })

  it('is no-op for unknown featureId', () => {
    const doc: PartDoc = { version: 1, kind: 'part', features: [] }
    expect(() => applySetPlaneDefinitionField(doc, 'nonexistent', 'plane', '@builtin_plane_top')).not.toThrow()
  })
})

describe('applyDeleteFeature', () => {
  it('deletes a user feature', () => {
    const doc = docWithFeatures()
    applyDeleteFeature(doc, 'sketch1')
    expect(doc.features!.map(f => f.id)).not.toContain('sketch1')
  })

  it('does not delete a built-in origin', () => {
    const doc = docWithFeatures()
    applyDeleteFeature(doc, 'Origin')
    expect(doc.features!.map(f => f.id)).toContain('Origin')
  })

  it('does not delete a built-in plane', () => {
    const doc = docWithFeatures()
    applyDeleteFeature(doc, 'Front')
    expect(doc.features!.map(f => f.id)).toContain('Front')
  })

  it('does not delete Top built-in', () => {
    const doc: PartDoc = { version: 1, kind: 'part', features: [
      { id: 'Origin', kind: 'origin' },
      { id: 'Top',    kind: 'plane' },
      { id: 'Front',  kind: 'plane' },
      { id: 'Right',  kind: 'plane' },
      { id: 'mySketch', kind: 'sketch' },
    ] }
    applyDeleteFeature(doc, 'Top')
    expect(doc.features!.map(f => f.id)).toContain('Top')
  })

  it('does not delete Right built-in', () => {
    const doc: PartDoc = { version: 1, kind: 'part', features: [
      { id: 'Origin', kind: 'origin' },
      { id: 'Top',    kind: 'plane' },
      { id: 'Front',  kind: 'plane' },
      { id: 'Right',  kind: 'plane' },
      { id: 'mySketch', kind: 'sketch' },
    ] }
    applyDeleteFeature(doc, 'Right')
    expect(doc.features!.map(f => f.id)).toContain('Right')
  })
})

// ─── Feature reordering ───

const docWithBuiltInsAndUser = (): PartDoc => ({
  version: 1,
  kind: 'part',
  features: [
    { id: 'Origin', kind: 'origin' },
    { id: 'Top', kind: 'plane' },
    { id: 'Front', kind: 'plane' },
    { id: 'Right', kind: 'plane' },
    { id: 'sketch1', kind: 'sketch' },
    { id: 'sketch2', kind: 'sketch' },
    { id: 'sketch3', kind: 'sketch' },
  ],
})

describe('applyReorderFeatures', () => {
  it('moves a feature to a later index', () => {
    const doc = docWithBuiltInsAndUser()
    applyReorderFeatures(doc, 'sketch1', 6)
    const ids = doc.features!.map(f => f.id)
    expect(ids).toEqual(['Origin', 'Top', 'Front', 'Right', 'sketch2', 'sketch1', 'sketch3'])
  })

  it('moves a feature to an earlier index', () => {
    const doc = docWithBuiltInsAndUser()
    applyReorderFeatures(doc, 'sketch3', 4)
    const ids = doc.features!.map(f => f.id)
    expect(ids).toEqual(['Origin', 'Top', 'Front', 'Right', 'sketch3', 'sketch1', 'sketch2'])
  })

  it('no-ops when dropping a feature on itself', () => {
    const doc = docWithBuiltInsAndUser()
    applyReorderFeatures(doc, 'sketch2', 5)
    const ids = doc.features!.map(f => f.id)
    expect(ids).toEqual(['Origin', 'Top', 'Front', 'Right', 'sketch1', 'sketch2', 'sketch3'])
  })

  it('protects built-in features from being moved', () => {
    const doc = docWithBuiltInsAndUser()
    applyReorderFeatures(doc, 'Origin', 6)
    const ids = doc.features!.map(f => f.id)
    expect(ids).toEqual(['Origin', 'Top', 'Front', 'Right', 'sketch1', 'sketch2', 'sketch3'])
  })

  it('clamps drop target before built-ins to after built-ins', () => {
    const doc = docWithBuiltInsAndUser()
    applyReorderFeatures(doc, 'sketch2', 2)
    const ids = doc.features!.map(f => f.id)
    expect(ids).toEqual(['Origin', 'Top', 'Front', 'Right', 'sketch2', 'sketch1', 'sketch3'])
  })

  it('no-ops for unknown feature id', () => {
    const doc = docWithBuiltInsAndUser()
    applyReorderFeatures(doc, 'nonexistent', 5)
    const ids = doc.features!.map(f => f.id)
    expect(ids).toEqual(['Origin', 'Top', 'Front', 'Right', 'sketch1', 'sketch2', 'sketch3'])
  })

  it('works with empty features array', () => {
    const doc: PartDoc = { version: 1, kind: 'part', features: [] }
    applyReorderFeatures(doc, 'sketch1', 0)
    expect(doc.features).toHaveLength(0)
  })
})

// One remover per shared splice site: the ref-list, edge-list and both body-list
// removers each had their own unchecked splice. splice(-1, 1) drops the LAST
// element, so an out-of-range index used to delete the wrong entry.
describe('remove-by-index mutators refuse out-of-range indices', () => {
  const cases: {
    name: string
    makeDoc: () => PartDoc
    remove: (doc: PartDoc, index: number) => void
    list: (doc: PartDoc) => string[] | undefined
  }[] = [
    {
      name: 'applyRemoveExtrudeProfile',
      makeDoc: () => ({
        version: 1,
        kind: 'part',
        features: [{ id: 'ex1', kind: 'extrude', extrude: { sketch: ['a', 'b'], distance: 10 } }],
      }),
      remove: (doc, index) => applyRemoveExtrudeProfile(doc, 'ex1', index),
      list: (doc) => {
        const sketch = doc.features![0].extrude!.sketch
        return Array.isArray(sketch) ? sketch : undefined
      },
    },
    {
      name: 'applyRemoveFilletEdge',
      makeDoc: () => ({
        version: 1,
        kind: 'part',
        features: [{ id: 'f1', kind: 'fillet', fillet: { edges: ['a', 'b'], radius: 2 } }],
      }),
      remove: (doc, index) => applyRemoveFilletEdge(doc, 'f1', index),
      list: (doc) => doc.features![0].fillet!.edges,
    },
    {
      name: 'applyRemoveDeleteBodyRef',
      makeDoc: () => ({
        version: 1,
        kind: 'part',
        features: [{ id: 'db1', kind: 'delete_body', delete_body: { bodies: ['a', 'b'] } }],
      }),
      remove: (doc, index) => applyRemoveDeleteBodyRef(doc, 'db1', index),
      list: (doc) => doc.features![0].delete_body!.bodies,
    },
    {
      name: 'applyRemoveTransformBody',
      makeDoc: () => ({
        version: 1,
        kind: 'part',
        features: [{
          id: 'xf1',
          kind: 'transform',
          transform: { bodies: ['a', 'b'], operation: 'new', translation: [0, 0, 0], rotation_angle: 0, scale: 1 },
        }],
      }),
      remove: (doc, index) => applyRemoveTransformBody(doc, 'xf1', index),
      list: (doc) => doc.features![0].transform!.bodies,
    },
  ]

  it.each(cases.map(c => c.name))('%s is a silent no-op for index -1 and index 5', (name) => {
    const c = cases.find(x => x.name === name)!
    for (const index of [-1, 5]) {
      const doc = c.makeDoc()
      expect(() => c.remove(doc, index)).not.toThrow()
      expect(c.list(doc)).toEqual(['a', 'b'])
    }
  })

  it.each(cases.map(c => c.name))('%s still removes at valid indices 0 and 1', (name) => {
    const c = cases.find(x => x.name === name)!
    const doc0 = c.makeDoc()
    c.remove(doc0, 0)
    expect(c.list(doc0)).toEqual(['b'])
    const doc1 = c.makeDoc()
    c.remove(doc1, 1)
    expect(c.list(doc1)).toEqual(['a'])
  })
})
