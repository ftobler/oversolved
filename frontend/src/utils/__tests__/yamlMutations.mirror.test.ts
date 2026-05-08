import { describe, it, expect } from 'vitest'
import type { PartDoc } from '../../types/cad'
import {
  applyAddMirror,
  applySetMirrorField,
  applyMirrorEntities,
} from '../../utils/yamlMutations'

const baseDoc: PartDoc = { features: [] }

const makeDoc = (): PartDoc => JSON.parse(JSON.stringify(baseDoc))

const makeSketchDoc = (): PartDoc => ({
  features: [
    {
      id: 'sk1',
      kind: 'sketch',
      plane: '@builtin_plane_front',
      entities: [
        { id: 'line1', kind: 'line' },
        { id: 'mirror_line', kind: 'line' },
      ],
      initial: {
        line1: [1, 1, 4, 1],
        mirror_line: [2, 0, 2, 4],
      },
    },
  ],
})

describe('Mirror mutations', () => {
  describe('applyAddMirror', () => {
    it('inserts a feature with correct defaults', () => {
      const doc = makeDoc()
      applyAddMirror(doc, 'mir1')
      expect(doc.features).toHaveLength(1)
      expect(doc.features![0]).toMatchObject({
        id: 'mir1',
        kind: 'mirror',
        label: 'Mirror',
        mirror: {
          body: '',
          plane: '',
          keep_original: true,
          merge: true,
        },
      })
    })

    it('uses custom label when provided', () => {
      const doc = makeDoc()
      applyAddMirror(doc, 'mir1', 'My Mirror')
      expect(doc.features![0].label).toBe('My Mirror')
    })
  })

  describe('applySetMirrorField', () => {
    it('updates body field', () => {
      const doc = makeDoc()
      applyAddMirror(doc, 'mir1')
      applySetMirrorField(doc, 'mir1', 'body', '@extrude1')
      expect(doc.features![0].mirror!.body).toBe('@extrude1')
    })

    it('updates plane field', () => {
      const doc = makeDoc()
      applyAddMirror(doc, 'mir1')
      applySetMirrorField(doc, 'mir1', 'plane', '@builtin_plane_front')
      expect(doc.features![0].mirror!.plane).toBe('@builtin_plane_front')
    })

    it('updates keep_original field', () => {
      const doc = makeDoc()
      applyAddMirror(doc, 'mir1')
      applySetMirrorField(doc, 'mir1', 'keep_original', false)
      expect(doc.features![0].mirror!.keep_original).toBe(false)
    })

    it('updates merge field', () => {
      const doc = makeDoc()
      applyAddMirror(doc, 'mir1')
      applySetMirrorField(doc, 'mir1', 'merge', false)
      expect(doc.features![0].mirror!.merge).toBe(false)
    })

    it('does nothing when feature is missing', () => {
      const doc = makeDoc()
      applySetMirrorField(doc, 'missing', 'body', '@extrude1')
      expect(doc.features).toHaveLength(0)
    })
  })

  describe('applyMirrorEntities', () => {
    it('mirrors a line across a vertical mirror line', () => {
      const doc = makeSketchDoc()
      const feature = doc.features![0]
      const initialCount = feature.entities!.length

      applyMirrorEntities(doc, 'sk1', ['line1'], 'mirror_line')

      expect(feature.entities).toHaveLength(initialCount + 1)
      const newEntity = feature.entities![feature.entities!.length - 1]
      expect(newEntity.kind).toBe('line')
      const newParams = feature.initial![newEntity.id]
      expect(newParams).toBeDefined()
      // line1 goes from (1,1) to (4,1), mirror_line is x=2 vertical
      // Reflected: (1,1) -> (3,1), (4,1) -> (0,1)
      // The reflected x is: 2*2 - x
      expect(newParams[0]).toBe(3)  // 4 - 1 = 3
      expect(newParams[1]).toBe(1)
      expect(newParams[2]).toBe(0)  // 4 - 4 = 0
      expect(newParams[3]).toBe(1)
    })

    it('mirrors a horizontal line across a diagonal mirror line', () => {
      const doc: PartDoc = {
        features: [
          {
            id: 'sk1',
            kind: 'sketch',
            plane: '@builtin_plane_front',
            entities: [
              { id: 'line1', kind: 'line' },
              { id: 'diag', kind: 'line' },
            ],
            initial: {
              line1: [0, 0, 4, 0],
              diag: [0, 0, 4, 4],
            },
          },
        ],
      }

      applyMirrorEntities(doc, 'sk1', ['line1'], 'diag')

      const feature = doc.features![0]
      const newEntity = feature.entities![feature.entities!.length - 1]
      const params = feature.initial![newEntity.id]
      // Mirroring (0,0) across y=x gives (0,0), (4,0) gives (0,4)
      expect(params[0]).toBeCloseTo(0)
      expect(params[1]).toBeCloseTo(0)
      expect(params[2]).toBeCloseTo(0)
      expect(params[3]).toBeCloseTo(4)
    })

    it('does nothing when mirror line params are missing', () => {
      const doc: PartDoc = {
        features: [
          {
            id: 'sk1',
            kind: 'sketch',
            plane: '@builtin_plane_front',
            entities: [
              { id: 'line1', kind: 'line' },
            ],
            initial: {
              line1: [0, 0, 4, 0],
            },
          },
        ],
      }

      applyMirrorEntities(doc, 'sk1', ['line1'], 'nonexistent_line')
      const feature = doc.features![0]
      expect(feature.entities).toHaveLength(1)
    })
  })
})
