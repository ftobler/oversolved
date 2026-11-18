import { describe, it, expect } from 'vitest'
import type { EdgeCurve, BundleFaceFact } from '@/kernel/partBundle'
import type { FaceData, PartResult } from '@/types/cad'
import type { AnchorPose } from '@/kernel/partBundle'
import { assemblyBuiltinEntityKey, assemblyEntityKey } from '@/utils/anchorCandidates'
import { partPrimitive } from '@/utils/measure/adapters/part'
import { isKernelAsk, measureOne, measurePair } from '@/utils/measure/rules'
import { formatReadouts } from '@/utils/measure/format'
import {
  computeAssemblyHud,
  computeAssemblyMeasurements,
  parseAssemblyEntityKey,
  type AssemblyMeasureContext,
} from '@/utils/assemblyMeasurements'
import type { AssemblyEntityFacts } from '@/utils/assemblyBodies'

const TWO_PI = Math.PI * 2

function shapeKey(handle: string, partIndex = 0): string {
  return `${handle}:body_${partIndex}`
}

function factsOf(edges: EdgeCurve[], faces?: BundleFaceFact[]): AssemblyEntityFacts {
  return { edges, ...(faces && { faces }) }
}

function lineEdge(a: [number, number, number], b: [number, number, number]): EdgeCurve {
  return {
    id: 'e', kind: 'line',
    point: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2],
    endpoints: [a, b],
  }
}

function circleEdge(
  center: [number, number, number],
  radius: number,
  angleStart = 0,
  angleEnd = TWO_PI,
): EdgeCurve {
  const at = (angle: number): [number, number, number] => [
    center[0] + radius * Math.cos(angle),
    center[1] + radius * Math.sin(angle),
    center[2],
  ]
  return {
    id: 'e', kind: 'circle', point: center, axis: [0, 0, 1], radius,
    endpoints: [at(angleStart), at(angleEnd)], x_axis: [1, 0, 0],
    angle_start: angleStart, angle_end: angleEnd,
  }
}

function planeFace(point: [number, number, number], normal: [number, number, number]): BundleFaceFact {
  return { surface_type: 'flatface', centroid: point, normal }
}

function cylinderFace(
  origin: [number, number, number],
  axis: [number, number, number],
  radius: number,
  length = 10,
): BundleFaceFact {
  return {
    surface_type: 'cylinderface',
    centroid: origin,
    normal: [1, 0, 0],
    frame: { origin, axis, radius },
    axial_length: length,
  }
}

/** The context for solved shapes only; a test that adds anchors builds them itself. */
function ctxOf(
  facts: Record<string, AssemblyEntityFacts>,
  extra: Partial<AssemblyMeasureContext> = {},
): AssemblyMeasureContext {
  return { entityMateRefs: {}, anchors: {}, shapeFacts: facts, ...extra }
}

/** One instance's single shape at index 0. */
function ctxForShape(handle: string, facts: AssemblyEntityFacts): AssemblyMeasureContext {
  return ctxOf({ [shapeKey(handle)]: facts })
}

function key(handle: string, kind: 'face' | 'edge' | 'vertex', index: number, partIndex = 0): string {
  return assemblyEntityKey(handle, partIndex, kind, index)
}

describe('parseAssemblyEntityKey', () => {
  it('reads the handle, part index, kind and element index', () => {
    expect(parseAssemblyEntityKey('asm-1|0|face|3')).toEqual({
      handle: 'asm-1', partIndex: 0, kind: 'face', index: 3,
    })
  })

  it('keeps a pipe inside the handle out of the positional fields', () => {
    expect(parseAssemblyEntityKey('a|b|2|edge|7')).toEqual({
      handle: 'a|b', partIndex: 2, kind: 'edge', index: 7,
    })
  })

  it('refuses a built-in key and a malformed one', () => {
    expect(parseAssemblyEntityKey(assemblyBuiltinEntityKey('Origin'))).toBeNull()
    expect(parseAssemblyEntityKey('p1|0|face')).toBeNull()
    expect(parseAssemblyEntityKey('p1|0|blob|1')).toBeNull()
  })
})

describe('computeAssemblyMeasurements: singles', () => {
  it('reads a circle edge pick as its diameter (was nothing off an anchor)', () => {
    const ctx = ctxForShape('p1', factsOf([circleEdge([0, 0, 0], 4)]))
    expect(computeAssemblyMeasurements(new Set([key('p1', 'edge', 0)]), ctx))
      .toEqual(['diameter 8.000 mm'])
  })

  it('reads a straight edge as its length', () => {
    const ctx = ctxForShape('p1', factsOf([lineEdge([0, 0, 0], [3, 4, 0])]))
    expect(computeAssemblyMeasurements(new Set([key('p1', 'edge', 0)]), ctx))
      .toEqual(['length 5.000 mm'])
  })

  it('reads a cylinder face as its diameter and axial length', () => {
    const ctx = ctxForShape('p1', factsOf([], [cylinderFace([0, 0, 0], [0, 0, 1], 4, 10)]))
    expect(computeAssemblyMeasurements(new Set([key('p1', 'face', 0)]), ctx))
      .toEqual(['diameter 8.000 mm', 'length 10.000 mm'])
  })

  it('asks the kernel for a flat face area and a spline length', () => {
    const flat = ctxForShape('p1', factsOf([], [planeFace([0, 0, 0], [0, 0, 1])]))
    expect(computeAssemblyHud(new Set([key('p1', 'face', 0)]), flat).ask).toEqual({
      op: 'area',
      picks: [{ handle: 'p1', partIndex: 0, kind: 'face', index: 0 }],
    })
    const spline = ctxForShape('p1', factsOf([{
      id: 'e', kind: 'b-spline', point: [1, 1, 0],
      endpoints: [[0, 0, 0], [2, 0, 0]],
      points: [[0, 0, 0], [1, 1, 0], [2, 0, 0]],
    }]))
    expect(computeAssemblyHud(new Set([key('p1', 'edge', 0)]), spline).ask).toEqual({
      op: 'length',
      picks: [{ handle: 'p1', partIndex: 0, kind: 'edge', index: 0 }],
    })
  })

  it('reads a lone vertex nothing, as the part editor does', () => {
    const handle = 'p1'
    const anchorId = 'a_v0'
    const ctx: AssemblyMeasureContext = {
      entityMateRefs: { [key(handle, 'vertex', 0)]: [{ part: handle, anchor: anchorId }] },
      anchors: { [handle]: { [anchorId]: { kind: 'point', point: [1, 2, 3], axis: [0, 0, 1] } } },
      shapeFacts: {},
    }
    expect(computeAssemblyMeasurements(new Set([key(handle, 'vertex', 0)]), ctx)).toEqual([])
  })
})

describe('computeAssemblyMeasurements: pairs', () => {
  it('measures the distance between two parallel faces', () => {
    const ctx = ctxForShape('p1', factsOf([], [
      planeFace([0, 0, 0], [0, 0, 1]),
      planeFace([0, 0, 5], [0, 0, 1]),
    ]))
    expect(computeAssemblyMeasurements(new Set([key('p1', 'face', 0), key('p1', 'face', 1)]), ctx))
      .toEqual(['distance 5.000 mm'])
  })

  it('measures the angle between two non-parallel faces', () => {
    const ctx = ctxForShape('p1', factsOf([], [
      planeFace([0, 0, 0], [0, 0, 1]),
      planeFace([0, 0, 0], [1, 0, 0]),
    ]))
    expect(computeAssemblyMeasurements(new Set([key('p1', 'face', 0), key('p1', 'face', 1)]), ctx))
      .toEqual(['angle 90.0°', 'supplement 90.0°'])
  })

  it('measures two parallel bounded edges by their offset', () => {
    const ctx = ctxForShape('p1', factsOf([
      lineEdge([0, 0, 0], [10, 0, 0]),
      lineEdge([0, 4, 0], [10, 4, 0]),
    ]))
    expect(computeAssemblyMeasurements(new Set([key('p1', 'edge', 0), key('p1', 'edge', 1)]), ctx))
      .toEqual(['distance 4.000 mm', 'alignment offset 0.000 mm'])
  })

  it('measures coaxial rims by their axial distance and radial gap', () => {
    const ctx = ctxForShape('p1', factsOf([
      circleEdge([0, 0, 0], 4),
      circleEdge([0, 0, 10], 4),
    ]))
    expect(computeAssemblyMeasurements(new Set([key('p1', 'edge', 0), key('p1', 'edge', 1)]), ctx))
      .toEqual(['axial distance 10.000 mm', 'radial gap 0.000 mm'])
  })

  it('measures a cylinder axis against a plane', () => {
    const ctx = ctxForShape('p1', factsOf([], [
      cylinderFace([0, 0, 3], [1, 0, 0], 4),
      planeFace([0, 0, 0], [0, 0, 1]),
    ]))
    expect(computeAssemblyMeasurements(new Set([key('p1', 'face', 0), key('p1', 'face', 1)]), ctx))
      .toEqual(['axis distance 3.000 mm'])
  })

  it('reads the same lines whichever order the two picks arrive in', () => {
    const ctx = ctxForShape('p1', factsOf([
      lineEdge([0, 0, 3], [10, 0, 3]),
      lineEdge([0, 0, 0], [0, 0, 10]),
    ]))
    const a = computeAssemblyMeasurements(new Set([key('p1', 'edge', 0), key('p1', 'edge', 1)]), ctx)
    const b = computeAssemblyMeasurements(new Set([key('p1', 'edge', 1), key('p1', 'edge', 0)]), ctx)
    expect(b).toEqual(a)
  })

  it('reads a vertex against a face through the anchor path', () => {
    const handle = 'p1'
    const ctx: AssemblyMeasureContext = {
      entityMateRefs: { [key(handle, 'vertex', 0)]: [{ part: handle, anchor: 'a_v' }] },
      anchors: { [handle]: { a_v: { kind: 'point', point: [1, 2, 7], axis: [0, 0, 1] } } },
      shapeFacts: { [shapeKey(handle)]: factsOf([], [planeFace([0, 0, 0], [0, 0, 1])]) },
    }
    expect(computeAssemblyMeasurements(new Set([key(handle, 'vertex', 0), key(handle, 'face', 0)]), ctx))
      .toEqual(['distance 7.000 mm'])
  })

  it('reads a built-in plane against a face as the anchor path always has', () => {
    const builtin = assemblyBuiltinEntityKey('Top')
    const handle = 'p1'
    const anchor: AnchorPose = { kind: 'plane', point: [0, 0, 0], axis: [0, 0, 1] }
    const ctx: AssemblyMeasureContext = {
      entityMateRefs: { [builtin]: [{ part: '__assembly', anchor: 'Top' }] },
      anchors: { __assembly: { Top: anchor } },
      shapeFacts: { [shapeKey(handle)]: factsOf([], [planeFace([0, 0, 5], [0, 0, 1])]) },
    }
    expect(computeAssemblyMeasurements(new Set([builtin, key(handle, 'face', 0)]), ctx))
      .toEqual(['distance 5.000 mm'])
  })
})

describe('computeAssemblyMeasurements: resolution rules', () => {
  it('blanks a selection that holds an entity the bundle does not resolve', () => {
    const ctx = ctxForShape('p1', factsOf([lineEdge([0, 0, 0], [1, 0, 0])]))
    expect(computeAssemblyMeasurements(new Set([key('p1', 'edge', 0), 'ghost']), ctx)).toEqual([])
    expect(computeAssemblyMeasurements(new Set(['ghost']), ctx)).toEqual([])
  })

  it('blanks a face pick when the bundle carries no face facts', () => {
    // A schema-5 bundle (or one from before the facts existed) cannot classify a
    // face; the selection reads nothing rather than an invented number.
    const ctx = ctxForShape('p1', factsOf([]))
    expect(computeAssemblyMeasurements(new Set([key('p1', 'face', 0)]), ctx)).toEqual([])
  })

  it('reads nothing for three or more picks', () => {
    const ctx = ctxForShape('p1', factsOf([
      lineEdge([0, 0, 0], [1, 0, 0]),
      lineEdge([0, 1, 0], [1, 1, 0]),
      lineEdge([0, 2, 0], [1, 2, 0]),
    ]))
    expect(computeAssemblyMeasurements(
      new Set([key('p1', 'edge', 0), key('p1', 'edge', 1), key('p1', 'edge', 2)]),
      ctx,
    )).toEqual([])
  })

  it('treats an anchor whose direction cannot be normalized as unmeasurable', () => {
    const builtin = assemblyBuiltinEntityKey('Top')
    const ctx: AssemblyMeasureContext = {
      entityMateRefs: { [builtin]: [{ part: '__assembly', anchor: 'Top' }] },
      anchors: { __assembly: { Top: { kind: 'plane', point: [0, 0, 0], axis: [0, 0, 0] } } },
      shapeFacts: {},
    }
    expect(computeAssemblyMeasurements(new Set([builtin]), ctx)).toEqual([])
  })

  it('asks the kernel for a freeform face, and states no analytic number', () => {
    const ctx = ctxForShape('p1', factsOf([], [{ surface_type: 'bsplineface', centroid: [0, 0, 0], normal: [0, 0, 1] }]))
    expect(computeAssemblyHud(new Set([key('p1', 'face', 0)]), ctx).ask).toEqual({
      op: 'length',
      picks: [{ handle: 'p1', partIndex: 0, kind: 'face', index: 0 }],
    })
  })

  it('reads a whole instance from the tree subject as a kernel volume', () => {
    const ctx = ctxOf({}, { subjectHandle: 'p1' })
    expect(computeAssemblyHud(new Set(), ctx).ask).toEqual({
      op: 'volume',
      picks: [{ handle: 'p1', kind: 'body' }],
    })
    // An entity selection wins over the tree subject; the two are never mixed.
    expect(computeAssemblyHud(new Set(), { ...ctx, subjectHandle: null }).ask).toBeNull()
  })

  it('reads a body entity key as a whole-instance kernel pick', () => {
    // The drive names a whole instance with the same key grammar; it is how an
    // agent asks for an instance clearance.
    const ctx = ctxOf({})
    expect(computeAssemblyHud(new Set(['a|0|body|0', 'b|0|body|0']), ctx).ask).toEqual({
      op: 'clearance',
      picks: [{ handle: 'a', kind: 'body' }, { handle: 'b', kind: 'body' }],
    })
  })
})

// ─── Parity with the part editor ───

function partOf(fields: Partial<PartResult>): PartResult {
  return { id: 'body_1', created_by: 'ex', modified_by: [], ...fields }
}

function holeFaceData(origin: [number, number, number]): FaceData {
  return {
    centroid: origin, normal: [1, 0, 0], surface_type: 'cylinderface',
    surface_frame: { axis: [0, 0, 1], origin, radius: 4 },
  }
}

function partReadout(part: PartResult, a: string, b?: string): string[] {
  const parts = { body_1: part }
  const result = b === undefined
    ? null
    : measurePair(partPrimitive(a, parts)!, partPrimitive(b, parts)!)
  if (result === null || isKernelAsk(result)) throw new Error('expected a readout')
  return formatReadouts(result)
}

describe('computeAssemblyMeasurements: parity with the part adapter', () => {
  // Two coaxial hole faces in one part versus the same two faces in two
  // instances, the second translated 40 along the shared axis. The readout must
  // be identical, because it is the same measurement.
  const part = partOf({
    mesh: {
      vertices: [], faces: [],
      face_data: [holeFaceData([0, 0, 0]), holeFaceData([0, 0, 40])],
      face_queries: ['?holeA', '?holeB'],
    },
  })
  const ctx = ctxOf({
    [shapeKey('p1')]: factsOf([], [cylinderFace([0, 0, 0], [0, 0, 1], 4)]),
    [shapeKey('p2')]: factsOf([], [cylinderFace([0, 0, 40], [0, 0, 1], 4)]),
  }, {})

  it('reads two coaxial faces in two instances like the two in one part', () => {
    const instance = computeAssemblyMeasurements(
      new Set([key('p1', 'face', 0), key('p2', 'face', 0)]),
      ctx,
    )
    expect(instance).toEqual(partReadout(part, '?holeA', '?holeB'))
  })

  it('reads the pair the same when the second instance axis is rotated 90 degrees', () => {
    const rotated = ctxOf({
      [shapeKey('p1')]: factsOf([], [cylinderFace([0, 0, 0], [0, 0, 1], 4)]),
      [shapeKey('p2')]: factsOf([], [cylinderFace([0, 40, 0], [0, 1, 0], 4)]),
    })
    const rotatedPart = partOf({
      mesh: {
        vertices: [], faces: [],
        face_data: [
          holeFaceData([0, 0, 0]),
          {
            centroid: [0, 40, 0], normal: [1, 0, 0], surface_type: 'cylinderface',
            surface_frame: { axis: [0, 1, 0], origin: [0, 40, 0], radius: 4 },
          },
        ],
        face_queries: ['?holeA', '?holeB'],
      },
    })
    expect(computeAssemblyMeasurements(
      new Set([key('p1', 'face', 0), key('p2', 'face', 0)]),
      rotated,
    )).toEqual(partReadout(rotatedPart, '?holeA', '?holeB'))
  })

  it('reads a circle edge single like the part editor', () => {
    const assembly = ctxForShape('p1', factsOf([circleEdge([3, 4, 0], 4)]))
    const partEdge = partOf({
      edges: [{
        kind: 'circle', center: [3, 4, 0], radius: 4, axis: [0, 0, 1],
        x_axis: [1, 0, 0], angle_start: 0, angle_end: TWO_PI,
      }],
      edge_queries: ['?rim'],
    })
    const partResult = measureOne(partPrimitive('?rim', { body_1: partEdge })!)
    if (partResult === null || isKernelAsk(partResult)) throw new Error('expected a readout')
    expect(computeAssemblyMeasurements(new Set([key('p1', 'edge', 0)]), assembly))
      .toEqual(formatReadouts(partResult))
  })
})
