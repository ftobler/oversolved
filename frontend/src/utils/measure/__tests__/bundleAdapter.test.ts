import { describe, it, expect } from 'vitest'
import type { EdgeCurve, BundleFaceFact } from '@/kernel/partBundle'
import type { EdgeData, FaceData, PartResult } from '@/types/cad'
import { partPrimitive } from '@/utils/measure/adapters/part'
import { bundleEntityPrimitive, type BundleEntityFacts } from '@/utils/measure/adapters/bundle'
import { isKernelAsk, measureOne, measurePair, type MeasureResult } from '@/utils/measure/rules'
import { formatReadouts } from '@/utils/measure/format'

function readoutLines(result: MeasureResult): string[] {
  if (result == null || isKernelAsk(result)) {
    throw new Error(`expected a readout, got ${JSON.stringify(result)}`)
  }
  return formatReadouts(result)
}

const TWO_PI = Math.PI * 2

function edgeCurve(fields: Partial<EdgeCurve> & Pick<EdgeCurve, 'kind' | 'point' | 'endpoints'>): EdgeCurve {
  return { id: 'e', ...fields }
}

function lineCurve(a: [number, number, number], b: [number, number, number]): EdgeCurve {
  return edgeCurve({
    kind: 'line',
    point: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2],
    endpoints: [a, b],
  })
}

function circleCurve(
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
  return edgeCurve({
    kind: 'circle',
    point: center,
    axis: [0, 0, 1],
    radius,
    endpoints: [at(angleStart), at(angleEnd)],
    x_axis: [1, 0, 0],
    angle_start: angleStart,
    angle_end: angleEnd,
  })
}

const CYLINDER_FRAME = { origin: [20, 0, 15] as [number, number, number], axis: [0, 1, 0] as [number, number, number], radius: 4 }

/** The probe's hole face: its radial normal points the same way as the flat
 *  side face's normal, and classifying from it would report a plane distance. */
function holeFace(centroid: [number, number, number] = [24, 5, 15]): BundleFaceFact {
  return {
    surface_type: 'cylinderface',
    centroid,
    normal: [1, 0, 0],
    frame: { ...CYLINDER_FRAME, origin: [...CYLINDER_FRAME.origin] },
    axial_length: 10,
  }
}

const FLAT_FACE: BundleFaceFact = {
  surface_type: 'flatface',
  centroid: [0, 5, 0],
  normal: [-1, 0, 0],
}

describe('bundle edge picks', () => {
  const facts: BundleEntityFacts = {
    edges: [
      lineCurve([0, 0, 0], [3, 4, 0]),
      circleCurve([3, 4, 0], 4),
      circleCurve([0, 0, 0], 2, 0, Math.PI / 2),
      edgeCurve({
        kind: 'ellipse',
        point: [1, 2, 0],
        axis: [0, 0, 1],
        radius: 4,
        minor_radius: 2,
        endpoints: [[5, 2, 0], [5, 2, 0]],
        x_axis: [1, 0, 0],
        angle_start: 0,
        angle_end: TWO_PI,
      }),
      edgeCurve({
        kind: 'ellipse',
        point: [1, 2, 0],
        axis: [0, 0, 1],
        radius: 4,
        minor_radius: 2,
        endpoints: [[5, 2, 0], [1, 4, 0]],
        x_axis: [1, 0, 0],
        angle_start: 0,
        angle_end: Math.PI,
      }),
      edgeCurve({
        kind: 'b-spline',
        point: [1, 1, 0],
        endpoints: [[0, 0, 0], [2, 0, 0]],
        points: [[0, 0, 0], [1, 1, 0], [2, 0, 0]],
      }),
    ],
  }

  it('reads a line as a bounded segment with the right length', () => {
    const primitive = bundleEntityPrimitive(facts, 'edge', 0, 'e0')
    expect(primitive).toMatchObject({ type: 'line', bounded: true, p0: [0, 0, 0], p1: [3, 4, 0] })
    expect(measureOne(primitive!)).toEqual({ kind: 'length', value: 5, label: 'length' })
  })

  it('reads a full circle edge as a diameter', () => {
    expect(measureOne(bundleEntityPrimitive(facts, 'edge', 1, 'e1')!))
      .toEqual({ kind: 'diameter', value: 8, label: 'diameter' })
  })

  it('reads a quarter arc as a radius plus its sweep', () => {
    const arc = measureOne(bundleEntityPrimitive(facts, 'edge', 2, 'e2')!)
    expect(arc).toMatchObject({ kind: 'radius', value: 2, label: 'radius' })
    expect((arc as { extra: { value: number }[] }).extra[0].value).toBeCloseTo(90, 9)
  })

  it('reads a full ellipse as both semi-axes and marks a partial one for the kernel', () => {
    expect(measureOne(bundleEntityPrimitive(facts, 'edge', 3, 'e3')!)).toMatchObject({
      kind: 'radius', value: 4, label: 'major radius',
    })
    expect(bundleEntityPrimitive(facts, 'edge', 4, 'e4')).toMatchObject({ type: 'opaque' })
    expect(measureOne(bundleEntityPrimitive(facts, 'edge', 4, 'e4')!)).toEqual({ kernel: 'length' })
  })

  it('marks a b-spline edge for the kernel', () => {
    expect(bundleEntityPrimitive(facts, 'edge', 5, 'e5')).toMatchObject({ type: 'opaque' })
    expect(measureOne(bundleEntityPrimitive(facts, 'edge', 5, 'e5')!)).toEqual({ kernel: 'length' })
  })
})

describe('bundle face picks', () => {
  it('classifies a cylinder from surface_type and frame, never from the radial normal', () => {
    const facts: BundleEntityFacts = { edges: [], faces: [FLAT_FACE, holeFace()] }
    expect(bundleEntityPrimitive(facts, 'face', 1, 'f1')).toMatchObject({
      type: 'cylinder', axis: [0, 1, 0], radius: 4, length: 10,
    })
    const flat = bundleEntityPrimitive(facts, 'face', 0, 'f0')
    expect(readoutLines(measurePair(flat!, bundleEntityPrimitive(facts, 'face', 1, 'f1')!)))
      .toEqual(['axis distance 20.000 mm'])
  })

  it('reads a plain flat face as a bounded plane', () => {
    const facts: BundleEntityFacts = { edges: [], faces: [FLAT_FACE] }
    expect(bundleEntityPrimitive(facts, 'face', 0, 'f0')).toEqual({
      type: 'plane', point: [0, 5, 0], normal: [-1, 0, 0], bounded: true,
    })
  })

  it('reads a disc face bounded by a full circle as its diameter', () => {
    const facts: BundleEntityFacts = {
      edges: [circleCurve([0, 0, 0], 4)],
      faces: [{
        surface_type: 'flatface', centroid: [0, 0, 0], normal: [0, 0, 1],
        area: Math.PI * 16, face_edges: [0],
      }],
    }
    expect(bundleEntityPrimitive(facts, 'face', 0, 'f0')).toMatchObject({
      type: 'circle', radius: 4, sweep: TWO_PI,
    })
  })

  it('merges a split circle on one face into one rim', () => {
    const facts: BundleEntityFacts = {
      edges: [circleCurve([0, 0, 0], 4, 0, Math.PI), circleCurve([0, 0, 0], 4, Math.PI, TWO_PI)],
      faces: [{
        surface_type: 'flatface', centroid: [0, 0, 0], normal: [0, 0, 1],
        area: Math.PI * 16, face_edges: [0, 1],
      }],
    }
    expect(measureOne(bundleEntityPrimitive(facts, 'edge', 0, 'e0')!))
      .toEqual({ kind: 'diameter', value: 8, label: 'diameter' })
    expect(measureOne(bundleEntityPrimitive(facts, 'edge', 1, 'e1')!))
      .toEqual({ kind: 'diameter', value: 8, label: 'diameter' })
    expect(bundleEntityPrimitive(facts, 'face', 0, 'f0')).toMatchObject({ type: 'circle', radius: 4 })
  })

  it('keeps a face without facts unresolvable rather than guessing', () => {
    expect(bundleEntityPrimitive({ edges: [] }, 'face', 0, 'f0')).toBeNull()
    expect(bundleEntityPrimitive(undefined, 'edge', 0, 'e0')).toBeNull()
    expect(bundleEntityPrimitive({ edges: [] }, 'vertex', 0, 'v0')).toBeNull()
  })
})

// ─── Parity with the part adapter ───

function partOf(fields: Partial<PartResult>): PartResult {
  return { id: 'body_1', created_by: 'ex', modified_by: [], ...fields }
}

function partWithHole(): PartResult {
  return partOf({
    mesh: {
      vertices: [], faces: [],
      face_data: [
        FLAT_FACE as unknown as FaceData,
        {
          centroid: [24, 5, 15], normal: [1, 0, 0], surface_type: 'cylinderface',
          surface_frame: { axis: [0, 1, 0], origin: [20, 0, 15], radius: 4 },
        },
      ],
      face_queries: ['?f0', '?f1'],
    },
  })
}

function bundleWithHole(): BundleEntityFacts {
  return { edges: [], faces: [FLAT_FACE, holeFace()] }
}

describe('bundle adapter parity with the part adapter', () => {
  it('reads the same single-readout lines for the same edge geometry', () => {
    const edge: EdgeData = {
      kind: 'arc', center: [0, 0, 0], radius: 2, axis: [0, 0, 1], x_axis: [1, 0, 0],
      angle_start: 0, angle_end: Math.PI / 2,
    }
    const part = partOf({ edges: [edge], edge_queries: ['?e0'] })
    const bundle: BundleEntityFacts = { edges: [circleCurve([0, 0, 0], 2, 0, Math.PI / 2)] }
    expect(readoutLines(measureOne(bundleEntityPrimitive(bundle, 'edge', 0, 'e0')!)))
      .toEqual(readoutLines(measureOne(partPrimitive('?e0', { body_1: part })!)))
  })

  it('reads the same pair lines for a flat face and a seated coaxial hole', () => {
    const parts = { body_1: partWithHole() }
    const bundle = bundleWithHole()
    const partReadout = measurePair(partPrimitive('?f0', parts)!, partPrimitive('?f1', parts)!)
    const bundleReadout = measurePair(
      bundleEntityPrimitive(bundle, 'face', 0, 'f0')!,
      bundleEntityPrimitive(bundle, 'face', 1, 'f1')!,
    )
    expect(readoutLines(bundleReadout)).toEqual(readoutLines(partReadout))
  })
})
