import { describe, it, expect } from 'vitest'
import type { PartResult, EdgeData, FaceData } from '@/types/cad'
import { partPrimitive } from '@/utils/measure/adapters/part'
import { isKernelAsk, measureOne, measurePair, type MeasureResult } from '@/utils/measure/rules'
import { formatReadouts } from '@/utils/measure/format'

/** The HUD lines of a result the test expects to be a readout. */
function readoutLines(result: MeasureResult): string[] {
  if (result == null || isKernelAsk(result)) {
    throw new Error(`expected a readout, got ${JSON.stringify(result)}`)
  }
  return formatReadouts(result)
}

const partsOf = (part: PartResult): Record<string, PartResult> => ({ [part.id]: part })

const line = (start: [number, number, number], end: [number, number, number]): EdgeData =>
  ({ kind: 'line', start, end })

function partOf(fields: Partial<PartResult>): PartResult {
  return { id: 'body_1', created_by: 'ex', modified_by: [], ...fields }
}

describe('bodyPrimitive: face classification', () => {
  // The probe's misread: a hole's cylinder face carries the radial normal at its
  // centroid, which here points the same way as a flat side face's normal. It
  // must still classify as a cylinder from surface_type + surface_frame, so the
  // pair is an axis distance (20) and not a plane distance (24 through the two
  // centroids).
  const probe = partOf({
    mesh: {
      vertices: [], faces: [],
      face_data: [
        { centroid: [0, 5, 0], normal: [-1, 0, 0], surface_type: 'flatface' },
        {
          centroid: [24, 5, 15], normal: [1, 0, 0], surface_type: 'cylinderface',
          surface_frame: { axis: [0, 1, 0], origin: [20, 0, 15], radius: 4 },
        },
      ] as FaceData[],
      face_queries: ['?f0:flatface', '?f1:cylinderface'],
    },
  })
  const parts = partsOf(probe)

  it('classifies a curved face by surface_type and uses the frame axis, never the radial normal', () => {
    const cylinder = partPrimitive('?f1:cylinderface', parts)
    expect(cylinder).toMatchObject({ type: 'cylinder', axis: [0, 1, 0], radius: 4 })
  })

  it('reads the flat face + hole face pair as an axis distance, not a plane distance', () => {
    const flat = partPrimitive('?f0:flatface', parts)
    const cylinder = partPrimitive('?f1:cylinderface', parts)
    expect(flat).not.toBeNull()
    expect(cylinder).not.toBeNull()
    const result = measurePair(flat!, cylinder!)
    expect(result).not.toBeNull()
    expect(readoutLines(result)).toEqual(['axis distance 20.000 mm'])
  })

  it('classifies a cone, sphere and torus face from their analytic frames', () => {
    const faces = partOf({
      mesh: {
        vertices: [], faces: [],
        face_data: [
          { centroid: [0, 0, 0], normal: [1, 0, 0], surface_type: 'coneface', surface_frame: { axis: [0, 0, 1], origin: [0, 0, 0], radius: 2, semi_angle: Math.PI / 6 } },
          { centroid: [0, 0, 0], normal: [0, 0, 1], surface_type: 'sphereface', surface_frame: { axis: [0, 0, 1], origin: [0, 0, 5], radius: 7 } },
          { centroid: [0, 0, 0], normal: [1, 0, 0], surface_type: 'torusface', surface_frame: { axis: [0, 1, 0], origin: [0, 0, 0], radius: 10, minor_radius: 3 } },
        ] as FaceData[],
        face_queries: ['?c', '?s', '?t'],
      },
    })
    const map = partsOf(faces)
    expect(partPrimitive('?c', map)).toMatchObject({ type: 'cone', axis: [0, 0, 1], semiAngle: Math.PI / 6 })
    expect(partPrimitive('?s', map)).toMatchObject({ type: 'sphere', center: [0, 0, 5], radius: 7 })
    expect(partPrimitive('?t', map)).toMatchObject({ type: 'torus', axis: [0, 1, 0], majorRadius: 10, minorRadius: 3 })
    expect(measureOne(partPrimitive('?s', map)!)).toEqual({ kind: 'diameter', value: 14, label: 'diameter' })
    // The two singles the new frame fields make readable.
    const coneReadout = measureOne(partPrimitive('?c', map)!) as { kind: string; value: number; label: string }
    expect(coneReadout.kind).toBe('angle')
    expect(coneReadout.label).toBe('angle')
    expect(coneReadout.value).toBeCloseTo(30, 9)
    expect(measureOne(partPrimitive('?t', map)!)).toEqual({
      kind: 'radius',
      value: 10,
      label: 'major radius',
      extra: [{ kind: 'radius', value: 3, label: 'minor radius' }],
    })
  })

  it('treats a curved face without an analytic frame as opaque, so it reads no wrong number', () => {
    const old = partOf({
      mesh: {
        vertices: [], faces: [],
        face_data: [{ centroid: [0, 0, 0], normal: [1, 0, 0], surface_type: 'cylinderface' }],
        face_queries: ['?old'],
      },
    })
    expect(partPrimitive('?old', partsOf(old))).toMatchObject({ type: 'opaque' })
    expect(measureOne(partPrimitive('?old', partsOf(old))!)).toEqual({ kernel: 'length' })
  })

  it('keeps the flat-face reading for a body solved before surface_type existed', () => {
    const old = partOf({
      mesh: {
        vertices: [], faces: [],
        face_data: [{ centroid: [0, 0, 3], normal: [0, 0, 1] }],
        face_queries: ['?old'],
      },
    })
    expect(partPrimitive('?old', partsOf(old))).toMatchObject({
      type: 'plane', point: [0, 0, 3], normal: [0, 0, 1],
    })
  })
})

describe('bodyPrimitive: edges and vertices', () => {
  const edges: EdgeData[] = [
    line([0, 0, 0], [3, 4, 0]),
    { kind: 'circle', center: [3, 4, 0], radius: 4, axis: [0, 0, 1], x_axis: [1, 0, 0], angle_start: 0, angle_end: Math.PI * 2 },
    { kind: 'arc', center: [0, 0, 0], radius: 2, axis: [0, 0, 1], x_axis: [1, 0, 0], angle_start: 0, angle_end: Math.PI / 2 },
    { kind: 'ellipse', center: [1, 2, 0], a: 4, b: 2, axis: [0, 0, 1], x_axis: [1, 0, 0], angle_start: 0, angle_end: Math.PI * 2 },
    { kind: 'spline', points: [[0, 0, 0], [1, 1, 0], [2, 0, 0]] },
  ]
  const part = partOf({ edges, vertices: [[1, 2, 3]], vertex_queries: ['?v0'] })
  const parts = partsOf(part)

  it('reads a line edge length and a circle edge diameter', () => {
    expect(measureOne(partPrimitive('@body_1/edge/0', parts)!))
      .toEqual({ kind: 'length', value: 5, label: 'length' })
    expect(measureOne(partPrimitive('@body_1/edge/1', parts)!))
      .toEqual({ kind: 'diameter', value: 8, label: 'diameter' })
  })

  it('reads an arc edge radius and sweep in radians', () => {
    const arc = measureOne(partPrimitive('@body_1/edge/2', parts)!)
    expect(arc).toMatchObject({ kind: 'radius', value: 2, label: 'radius' })
    expect((arc as { extra: { value: number }[] }).extra[0].value).toBeCloseTo(90, 9)
  })

  it('reads a full ellipse edge as both semi-axes and marks a partial one for the kernel', () => {
    expect(measureOne(partPrimitive('@body_1/edge/3', parts)!)).toMatchObject({
      kind: 'radius', value: 4, label: 'major radius',
    })
    const partial = partOf({
      edges: [
        { kind: 'ellipse', center: [0, 0, 0], a: 4, b: 2, axis: [0, 0, 1], x_axis: [1, 0, 0], angle_start: 0, angle_end: Math.PI },
      ],
      edge_queries: ['?partial'],
    })
    expect(partPrimitive('?partial', partsOf(partial))).toMatchObject({ type: 'opaque' })
    expect(measureOne(partPrimitive('?partial', partsOf(partial))!)).toEqual({ kernel: 'length' })
  })

  it('marks a spline edge for the kernel', () => {
    expect(measureOne(partPrimitive('@body_1/edge/4', parts)!)).toEqual({ kernel: 'length' })
  })

  it('resolves a body vertex as a point, with no single-pick readout', () => {
    const vertex = partPrimitive('?v0', parts)
    expect(vertex).toEqual({ type: 'point', p: [1, 2, 3] })
    expect(measureOne(vertex!)).toBeNull()
  })

  it('an empty-string query placeholder resolves to nothing', () => {
    // The kernel pads its query arrays with '' for unnamed elements; a plain
    // indexOf('') would resolve the first unnamed slot and measure the wrong
    // element.
    const padded = partOf({ edges: [line([0, 0, 0], [1, 0, 0])], edge_queries: ['', '?named'] })
    const map = partsOf(padded)
    expect(partPrimitive('', map)).toBeNull()
    expect(partPrimitive('@missing/edge/0', map)).toBeNull()
  })
})

// The topo fallback (`@<body>/<kind>/<idx>`) is keyed by BODY id: one feature
// owns N bodies after a split, and the index is per body, so the token must name
// the sibling the user picked.
describe('bodyPrimitive: topo-fallback ids across split siblings', () => {
  const siblings = (): Record<string, PartResult> => ({
    body_ex: partOf({ id: 'body_ex', edges: [line([0, 0, 0], [10, 0, 0])] }),
    body_ex_1: partOf({ id: 'body_ex_1', edges: [line([0, 5, 0], [3, 5, 0])] }),
  })

  it('measures the sibling named by the query, not the first body of the feature', () => {
    expect(measureOne(partPrimitive('@body_ex/edge/0', siblings())!))
      .toEqual({ kind: 'length', value: 10, label: 'length' })
    expect(measureOne(partPrimitive('@body_ex_1/edge/0', siblings())!))
      .toEqual({ kind: 'length', value: 3, label: 'length' })
  })

  it('measures between the two siblings own edges', () => {
    const a = partPrimitive('@body_ex/edge/0', siblings())!
    const b = partPrimitive('@body_ex_1/edge/0', siblings())!
    expect(readoutLines(measurePair(a, b))).toEqual(['distance 5.000 mm'])
  })
})
