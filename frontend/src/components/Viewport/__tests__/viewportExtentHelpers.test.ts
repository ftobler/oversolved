// The extent helpers behind Viewport camera fitting and plane sizing are pure
// math/lookup, so they are unit tested directly instead of rendering the Canvas.
// They are exported only for that reason.
import { describe, it, expect } from 'vitest'
import {
  calculateMeshExtentFromFlat,
  calculateMeshExtent,
  getModelBoundingBoxExtent,
  getFaceExtent,
  calculatePlaneSize,
  isActive,
} from '@/components/Viewport'
import type { BodyResult, Feature, PlaneDef } from '@/types/cad'

function body(id: string, vertices: Float32Array | [number, number, number][] | undefined): BodyResult {
  return {
    id,
    created_by: 'test',
    modified_by: [],
    mesh: vertices ? { vertices, faces: new Uint32Array() } : undefined,
  }
}

// Corners of an axis-aligned box from (0,0,0) to (x,y,z): the largest axis is
// the extent the helpers must report.
function boxFlat(x: number, y: number, z: number): Float32Array {
  return new Float32Array([0, 0, 0, x, y, z])
}

describe('calculateMeshExtentFromFlat', () => {
  it('returns 0 for an empty buffer', () => {
    expect(calculateMeshExtentFromFlat(new Float32Array([]))).toBe(0)
  })

  it('returns the largest axis span', () => {
    expect(calculateMeshExtentFromFlat(boxFlat(2, 3, 1))).toBe(3)
    expect(calculateMeshExtentFromFlat(boxFlat(5, 3, 1))).toBe(5)
  })

  it('skips non-finite vertices', () => {
    const vertices = new Float32Array([NaN, 0, 0, 0, 0, 0, 4, 0, 0, Infinity, 9, 9])
    expect(calculateMeshExtentFromFlat(vertices)).toBe(4)
  })

  it('returns 0 when every vertex is non-finite', () => {
    expect(calculateMeshExtentFromFlat(new Float32Array([NaN, NaN, NaN, Infinity, -Infinity, 0]))).toBe(0)
  })
})

describe('calculateMeshExtent', () => {
  it('delegates Float32Array input to the flat path', () => {
    expect(calculateMeshExtent(boxFlat(2, 7, 1))).toBe(7)
  })

  it('returns 0 for an empty tuple array', () => {
    expect(calculateMeshExtent([])).toBe(0)
  })

  it('returns the largest axis span over tuples', () => {
    expect(calculateMeshExtent([[0, 0, 0], [2, 3, 1]])).toBe(3)
  })

  it('skips non-finite tuples and returns 0 when all are non-finite', () => {
    expect(calculateMeshExtent([[NaN, 0, 0], [0, 0, 0], [4, 0, 0]])).toBe(4)
    expect(calculateMeshExtent([[NaN, 0, 0], [0, Infinity, 0]])).toBe(0)
  })
})

describe('getModelBoundingBoxExtent', () => {
  it('returns 0 for undefined, empty or meshless bodies', () => {
    expect(getModelBoundingBoxExtent(undefined)).toBe(0)
    expect(getModelBoundingBoxExtent({})).toBe(0)
    expect(getModelBoundingBoxExtent({ b1: body('b1', undefined) })).toBe(0)
  })

  it('takes the largest body extent', () => {
    const bodies = {
      b1: body('b1', boxFlat(2, 2, 2)),
      b2: body('b2', boxFlat(10, 3, 1)),
    }
    expect(getModelBoundingBoxExtent(bodies)).toBe(10)
  })
})

describe('getFaceExtent', () => {
  it('returns 0 when the query names no body', () => {
    expect(getFaceExtent('face_1', {})).toBe(0)
  })

  it('returns 0 when the named body is absent or meshless', () => {
    expect(getFaceExtent('@missing/face0', {})).toBe(0)
    expect(getFaceExtent('@b1/face0', { b1: body('b1', undefined) })).toBe(0)
  })

  it('reads the body id off the query and measures that body', () => {
    expect(getFaceExtent('@b1/face0', { b1: body('b1', boxFlat(4, 1, 1)) })).toBe(4)
  })
})

describe('calculatePlaneSize', () => {
  it('falls back to 100 without a definition or bodies', () => {
    expect(calculatePlaneSize(undefined, {})).toBe(100)
    expect(calculatePlaneSize({ mode: 'offset' }, undefined)).toBe(100)
  })

  it('expands the on_face referenced body extent by 1.1', () => {
    const def: PlaneDef = { mode: 'on_face', face: '@b1/face0' }
    expect(calculatePlaneSize(def, { b1: body('b1', boxFlat(10, 4, 4)) })).toBeCloseTo(11)
  })

  it('falls back to the model extent when the face body is missing', () => {
    const def: PlaneDef = { mode: 'on_face', face: '@missing/face0' }
    expect(calculatePlaneSize(def, { b1: body('b1', boxFlat(6, 2, 2)) })).toBeCloseTo(6.6)
  })

  it('expands the model extent for a non on_face plane', () => {
    expect(calculatePlaneSize({ mode: 'offset' }, { b1: body('b1', boxFlat(20, 2, 2)) })).toBeCloseTo(22)
  })

  it('returns 100 when no body carries a mesh', () => {
    expect(calculatePlaneSize({ mode: 'offset' }, { b1: body('b1', undefined) })).toBe(100)
  })
})

describe('isActive', () => {
  const features = [{ id: 'a' }, { id: 'b' }, { id: 'c' }] as Feature[]

  it('treats a doc without features as fully active', () => {
    expect(isActive('a', undefined, undefined, undefined)).toBe(true)
    expect(isActive('a', [], undefined, undefined)).toBe(true)
  })

  it('deactivates a feature not present in the doc', () => {
    expect(isActive('missing', features, undefined, undefined)).toBe(false)
  })

  it('respects the rollback position', () => {
    expect(isActive('a', features, 2, undefined)).toBe(true)
    expect(isActive('c', features, 2, undefined)).toBe(false)
    expect(isActive('c', features, undefined, undefined)).toBe(true)
  })

  it('respects the visibility set', () => {
    expect(isActive('a', features, undefined, new Set(['a']))).toBe(true)
    expect(isActive('a', features, undefined, new Set(['b']))).toBe(false)
  })
})
