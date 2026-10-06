// Tests for geometric descriptor tokens (query-descriptor-identity): wire
// round-trip, per-kind derivation, and the tolerance-matching gates the
// resolver's legacy descriptor tier relies on.

import { describe, it, expect } from "vitest"
import {
  descriptorDistance,
  descriptorOfElement,
  edgeDescriptorOf,
  isGeomDescriptorId,
  narrowByDescriptor,
  parseGeomDescriptorId,
  type EdgeDescriptor,
  type GeomDescriptor,
} from "../geomDescriptor"

const face = (point: number[], axis: number[]): GeomDescriptor => ({ kind: "face", point, axis })

describe("wire format", () => {
  it("vertex token round-trips", () => {
    const d = parseGeomDescriptorId("@gdv|4.0,5.0,6.0")
    expect(d).toEqual({ kind: "vertex", point: [4, 5, 6] })
  })

  it("isGeomDescriptorId recognizes all three prefixes and rejects others", () => {
    expect(isGeomDescriptorId("@gdf|0.0,0.0,0.0|0.0,0.0,1.0")).toBe(true)
    expect(isGeomDescriptorId("@gde|line|0,0,0|1,0,0|2.0")).toBe(true)
    expect(isGeomDescriptorId("@gdv|0,0,0")).toBe(true)
    expect(isGeomDescriptorId("@gface_abc123")).toBe(false)
    expect(isGeomDescriptorId("@ex1")).toBe(false)
    expect(isGeomDescriptorId("@cls_zp")).toBe(false)
  })

  it("malformed tokens parse to null, never throw", () => {
    expect(parseGeomDescriptorId("@gdf|1,2|0,0,1")).toBeNull()
    expect(parseGeomDescriptorId("@gdf|1,2,x|0,0,1")).toBeNull()
    expect(parseGeomDescriptorId("@gde|line|1,2,3")).toBeNull()
    expect(parseGeomDescriptorId("@gdv|1,2")).toBeNull()
    expect(parseGeomDescriptorId("@something_else")).toBeNull()
  })

  it("tokens contain no spaces (safe for the canonical space-join)", () => {
    const tok = "@gdv|-0.0001,9999.9999,0.0"
    expect(tok.includes(" ")).toBe(false)
  })
})

describe("edgeDescriptorOf derivation", () => {
  it("line: midpoint, unit direction, length", () => {
    const d = edgeDescriptorOf({ kind: "line", start: [0, 0, 0], end: [10, 0, 0] })
    expect(d).toEqual({ kind: "edge", edgeKind: "line", point: [5, 0, 0], axis: [1, 0, 0], scalar: 10 })
  })

  it("circle: center, axis, radius", () => {
    const d = edgeDescriptorOf({ kind: "circle", center: [1, 2, 3], radius: 4, axis: [0, 0, 1] })
    expect(d).toEqual({ kind: "edge", edgeKind: "circle", point: [1, 2, 3], axis: [0, 0, 1], scalar: 4 })
  })

  it("arc: arc midpoint, axis, radius", () => {
    // Quarter arc from 0 to 90deg in the XY plane: midpoint at 45deg.
    const d = edgeDescriptorOf({
      kind: "arc",
      center: [0, 0, 0],
      radius: 2,
      axis: [0, 0, 1],
      x_axis: [1, 0, 0],
      angle_start: 0,
      angle_end: Math.PI / 2,
    })
    expect(d?.edgeKind).toBe("arc")
    expect(d?.point[0]).toBeCloseTo(Math.SQRT2, 6)
    expect(d?.point[1]).toBeCloseTo(Math.SQRT2, 6)
    expect(d?.scalar).toBe(2)
  })

  it("contiguous arc keeps the raw-angle mean", () => {
    // The producer edgeToGeom emits contiguous raw OCC params (u0 <= u1), so a
    // plain range must anchor exactly where it did before seam handling: the
    // naive mean of its endpoints.
    const d30 = edgeDescriptorOf({
      kind: "arc",
      center: [0, 0, 0],
      radius: 2,
      axis: [0, 0, 1],
      x_axis: [1, 0, 0],
      angle_start: (30 * Math.PI) / 180,
      angle_end: (60 * Math.PI) / 180,
    })
    // Naive mean of 30..60deg is 45deg: (2*cos45, 2*sin45).
    expect(d30?.point[0]).toBeCloseTo(Math.SQRT2, 9)
    expect(d30?.point[1]).toBeCloseTo(Math.SQRT2, 9)
  })

  it("wrapped arc midpoint crosses the 2*pi seam (350deg..10deg anchors at 0deg)", () => {
    // A normalized straddling range must average across the seam, not land on
    // the middle (180deg) of the complement arc.
    const d = edgeDescriptorOf({
      kind: "arc",
      center: [0, 0, 0],
      radius: 2,
      axis: [0, 0, 1],
      x_axis: [1, 0, 0],
      angle_start: (350 * Math.PI) / 180,
      angle_end: (10 * Math.PI) / 180,
    })
    expect(d?.point[0]).toBeCloseTo(2, 6)
    expect(d?.point[1]).toBeCloseTo(0, 6)
  })

  it("wrapped degree-keyed arc and clockwise unwrap agree with sibling consumers", () => {
    // Same straddle via angle_start_deg/angle_end_deg (ccw defaults true).
    const degD = edgeDescriptorOf({
      kind: "arc",
      center: [0, 0, 0],
      radius: 3,
      axis: [0, 0, 1],
      x_axis: [1, 0, 0],
      angle_start_deg: 350,
      angle_end_deg: 10,
    })
    expect(degD?.point[0]).toBeCloseTo(3, 6)
    expect(degD?.point[1]).toBeCloseTo(0, 6)
    // ccw=false traverses 10deg down through 0deg to 350deg: the midpoint still
    // sits at 0deg, which needs the backward unwrap.
    const cwD = edgeDescriptorOf({
      kind: "arc",
      center: [0, 0, 0],
      radius: 3,
      axis: [0, 0, 1],
      x_axis: [1, 0, 0],
      angle_start_deg: 10,
      angle_end_deg: 350,
      ccw: false,
    })
    expect(cwD?.point[0]).toBeCloseTo(3, 6)
    expect(cwD?.point[1]).toBeCloseTo(0, 6)
  })

  it("partial ellipse midpoint crosses the seam too", () => {
    const d = edgeDescriptorOf({
      kind: "ellipse",
      center: [0, 0, 0],
      a: 4,
      b: 2,
      axis: [0, 0, 1],
      x_axis: [1, 0, 0],
      angle_start: (350 * Math.PI) / 180,
      angle_end: (10 * Math.PI) / 180,
    })
    // Seam midpoint param 0: point = a*cos(0)*x_axis = (4, 0, 0).
    expect(d?.point[0]).toBeCloseTo(4, 6)
    expect(d?.point[1]).toBeCloseTo(0, 6)
  })

  it("two arcs of one circle get different descriptors", () => {
    const base = { kind: "arc", center: [0, 0, 0], radius: 2, axis: [0, 0, 1], x_axis: [1, 0, 0] }
    const a = edgeDescriptorOf({ ...base, angle_start: 0, angle_end: Math.PI })
    const b = edgeDescriptorOf({ ...base, angle_start: Math.PI, angle_end: 2 * Math.PI })
    expect(a).not.toBeNull()
    expect(b).not.toBeNull()
    expect(descriptorDistance(a!, b!)).toBeGreaterThan(1)
  })

  it("full ellipse anchors on center; partial elliptical arc on its midpoint", () => {
    const base = { kind: "ellipse", center: [0, 0, 0], a: 4, b: 2, axis: [0, 0, 1], x_axis: [1, 0, 0] }
    const full = edgeDescriptorOf({ ...base, angle_start: 0, angle_end: 2 * Math.PI })
    expect(full?.point).toEqual([0, 0, 0])
    const partial = edgeDescriptorOf({ ...base, angle_start: 0, angle_end: Math.PI })
    // Midpoint eccentric angle pi/2: point = center + b*sin(pi/2)*y_axis = (0, 2, 0).
    expect(partial?.point[0]).toBeCloseTo(0, 6)
    expect(partial?.point[1]).toBeCloseTo(2, 6)
  })

  it("near-full ellipse (span within 1e-6 of 2*pi) still anchors on center", () => {
    // 4dp rounding jitter must not flip a near-full ellipse to the midpoint
    // anchor: a flip would strand persisted tokens across rebuilds.
    const base = { kind: "ellipse", center: [0, 0, 0], a: 4, b: 2, axis: [0, 0, 1], x_axis: [1, 0, 0] }
    const nearFull = edgeDescriptorOf({ ...base, angle_start: 0, angle_end: 2 * Math.PI - 1e-7 })
    expect(nearFull?.point).toEqual([0, 0, 0])
  })

  it("partial ellipse without `b` yields null (fail-safe, no colliding center anchor)", () => {
    const base = { kind: "ellipse", center: [0, 0, 0], a: 4, axis: [0, 0, 1], x_axis: [1, 0, 0] }
    expect(edgeDescriptorOf({ ...base, angle_start: 0, angle_end: Math.PI })).toBeNull()
  })

  it("circle/arc/ellipse without `axis` yields null (no world-axis fallback)", () => {
    // A missing axis is malformed geometry, not a defaultable field: a
    // world-axis fallback could match an unrelated world-axis query silently.
    expect(edgeDescriptorOf({ kind: "circle", center: [0, 0, 0], radius: 4 })).toBeNull()
    expect(
      edgeDescriptorOf({ kind: "arc", center: [0, 0, 0], radius: 2, x_axis: [1, 0, 0], angle_start: 0, angle_end: Math.PI / 2 }),
    ).toBeNull()
    expect(edgeDescriptorOf({ kind: "ellipse", center: [0, 0, 0], a: 4, b: 2, x_axis: [1, 0, 0] })).toBeNull()
  })

  it("arc without `x_axis` yields null", () => {
    // The arc midpoint needs the plane's x_axis; without it the descriptor
    // cannot be derived and must not fall back to a world axis.
    expect(
      edgeDescriptorOf({
        kind: "arc",
        center: [0, 0, 0],
        radius: 2,
        axis: [0, 0, 1],
        angle_start: 0,
        angle_end: Math.PI / 2,
      }),
    ).toBeNull()
  })

  it("spline: mean of points, chord direction, chord length", () => {
    const d = edgeDescriptorOf({
      kind: "spline",
      points: [
        [0, 0, 0],
        [1, 2, 0],
        [2, 0, 0],
      ],
    })
    expect(d?.point[0]).toBeCloseTo(1, 6)
    expect(d?.axis).toEqual([1, 0, 0])
    expect(d?.scalar).toBe(2)
  })

  it("edge dict without geometry yields null (fail-safe)", () => {
    expect(edgeDescriptorOf({ kind: "spline" })).toBeNull()
    expect(edgeDescriptorOf({ kind: "line", start: [0, 0, 0] })).toBeNull()
  })
})

describe("descriptorOfElement (registered payload shapes)", () => {
  it("face payload: centroid + normal", () => {
    const d = descriptorOfElement({ type: "flatface", centroid: [1, 2, 3], normal: [0, 1, 0] })
    expect(d).toEqual({ kind: "face", point: [1, 2, 3], axis: [0, 1, 0] })
  })

  it("vertex payload: origin", () => {
    const d = descriptorOfElement({ type: "vertex", origin: [7, 8, 9] })
    expect(d).toEqual({ kind: "vertex", point: [7, 8, 9] })
  })

  it("edge payload routes through edgeDescriptorOf", () => {
    const d = descriptorOfElement({ type: "straightedge", kind: "line", start: [0, 0, 0], end: [2, 0, 0] })
    expect(d?.kind).toBe("edge")
    expect((d as EdgeDescriptor).point).toEqual([1, 0, 0])
  })

  it("geometry-less payloads yield null", () => {
    expect(descriptorOfElement({ type: "solid", body_id: "b" })).toBeNull()
    expect(descriptorOfElement(null)).toBeNull()
    expect(descriptorOfElement("str")).toBeNull()
  })
})

describe("descriptorDistance gates", () => {
  it("face normal gate rejects misaligned normals", () => {
    const q = face([0, 0, 0], [0, 0, 1])
    expect(descriptorDistance(q, face([0, 0, 5], [0, 0, 1]))).toBeCloseTo(5, 9)
    expect(descriptorDistance(q, face([0, 0, 0], [1, 0, 0]))).toBeNull()
    // Signed: an anti-parallel face (the opposite cap) must NOT match.
    expect(descriptorDistance(q, face([0, 0, 0], [0, 0, -1]))).toBeNull()
  })

  it("edge gate: kind must match, axis is sign-insensitive", () => {
    const q: EdgeDescriptor = { kind: "edge", edgeKind: "line", point: [0, 0, 0], axis: [1, 0, 0], scalar: 4 }
    const flipped: EdgeDescriptor = { ...q, axis: [-1, 0, 0] }
    expect(descriptorDistance(q, flipped)).toBeCloseTo(0, 9)
    const circle: EdgeDescriptor = { ...q, edgeKind: "circle" }
    expect(descriptorDistance(q, circle)).toBeNull()
  })

  it("edge scalar difference folds into the distance", () => {
    const q: EdgeDescriptor = { kind: "edge", edgeKind: "circle", point: [0, 0, 0], axis: [0, 0, 1], scalar: 5 }
    const c: EdgeDescriptor = { ...q, scalar: 7 }
    expect(descriptorDistance(q, c)).toBeCloseTo(2, 9)
  })

  it("kind mismatch across descriptor kinds is null", () => {
    const q = face([0, 0, 0], [0, 0, 1])
    expect(descriptorDistance(q, { kind: "vertex", point: [0, 0, 0] })).toBeNull()
  })
})

describe("narrowByDescriptor (graceful resolver tier)", () => {
  const cands = (
    ...list: Array<[string, GeomDescriptor | null]>
  ): Array<[string, GeomDescriptor | null]> => list

  it("tight hit narrows to it even when a sibling is close-ish", () => {
    const q = face([0, 0, 10], [0, 0, 1])
    const out = narrowByDescriptor(
      q,
      cands(["moved", face([0, 0, 10.0002], [0, 0, 1])], ["other", face([0, 0, 12], [0, 0, 1])]),
    )
    expect(out).toEqual(["moved"])
  })

  it("nearest-with-margin narrows when the runner-up is 2x farther", () => {
    const q = face([0, 0, 10], [0, 0, 1])
    const out = narrowByDescriptor(
      q,
      cands(["near", face([0, 0, 11], [0, 0, 1])], ["far", face([0, 0, 14], [0, 0, 1])]),
    )
    expect(out).toEqual(["near"])
  })

  it("near-tie refuses to narrow (fail-safe over fail-wrong)", () => {
    const q = face([0, 0, 10], [0, 0, 1])
    const out = narrowByDescriptor(
      q,
      cands(["a", face([0, 0, 11], [0, 0, 1])], ["b", face([0, 0, 11.5], [0, 0, 1])]),
    )
    expect(out.length).toBe(2)
  })

  it("gate-only narrowing drops misoriented candidates", () => {
    const q = face([0, 0, 10], [0, 0, 1])
    const out = narrowByDescriptor(
      q,
      cands(["cap", face([0, 0, 14], [0, 0, 1])], ["side", face([5, 0, 5], [1, 0, 0])]),
    )
    expect(out).toEqual(["cap"])
  })

  it("no candidate passes the gate -> input unchanged (graceful)", () => {
    const q = face([0, 0, 10], [0, 0, 1])
    const out = narrowByDescriptor(q, cands(["x", face([0, 0, 0], [1, 0, 0])], ["y", null]))
    expect(out).toEqual(["x", "y"])
  })

  it("multiple tight hits stay ambiguous (both returned)", () => {
    const q = face([0, 0, 10], [0, 0, 1])
    const out = narrowByDescriptor(
      q,
      cands(["a", face([0, 0, 10.0001], [0, 0, 1])], ["b", face([0, 0, 9.9999], [0, 0, 1])]),
    )
    expect(out.length).toBe(2)
  })
})

describe("malformed token shape guards", () => {
  it("face token with the wrong number of pipe parts is null", () => {
    // A malformed persisted @gdf token must never narrow anything: one part
    // (@gdf|1,2,3) and three parts both fail the exact-2 shape check.
    expect(parseGeomDescriptorId("@gdf|1,2,3")).toBeNull()
    expect(parseGeomDescriptorId("@gdf|1,2,3|0,0,1|extra")).toBeNull()
  })

  it("edge token with an empty edgeKind is null", () => {
    expect(parseGeomDescriptorId("@gde||0,0,0|1,0,0|2")).toBeNull()
  })

  it("edge token with a non-3 point is null", () => {
    expect(parseGeomDescriptorId("@gde|line|1,2|1,0,0|2")).toBeNull()
  })
})

describe("edgeDescriptorOf derivation fallbacks", () => {
  it("a coincident-endpoint line normalizes to a zero axis with zero length", () => {
    // normalize() must not divide by a zero norm; the zero axis is the honest
    // reading, and the zero scalar keeps it from matching a real segment.
    const d = edgeDescriptorOf({ kind: "line", start: [1, 1, 1], end: [1, 1, 1] })
    expect(d).toEqual({ kind: "edge", edgeKind: "line", point: [1, 1, 1], axis: [0, 0, 0], scalar: 0 })
  })

  it("a line endpoint with a non-finite coordinate yields null", () => {
    expect(edgeDescriptorOf({ kind: "line", start: [0, 0, 0], end: [1, 0, Number.NaN] })).toBeNull()
  })

  it("an arc with no angle fields anchors at the zero parameter", () => {
    // edgeAngle's fallback (0) keeps the descriptor derivable for a payload a
    // producer forgot to stamp; the anchor is center + radius * x_axis.
    const d = edgeDescriptorOf({ kind: "arc", center: [0, 0, 0], radius: 2, axis: [0, 0, 1], x_axis: [1, 0, 0] })
    expect(d).not.toBeNull()
    expect(d!.point[0]).toBeCloseTo(2, 9)
    expect(d!.point[1]).toBeCloseTo(0, 9)
  })

  it("a kindless payload with points derives the point-set descriptor", () => {
    // No string `kind` and no start/end: the sampled-points arm is the only
    // geometry left, and edgeKind falls back to "spline".
    const d = edgeDescriptorOf({ points: [[0, 0, 0], [2, 0, 0]] })
    expect(d).toEqual({ kind: "edge", edgeKind: "spline", point: [1, 0, 0], axis: [1, 0, 0], scalar: 2 })
  })

  it("a kindless payload with start/end falls back to the segment descriptor", () => {
    const d = edgeDescriptorOf({ kind: "bezier", start: [0, 0, 0], end: [2, 0, 0] })
    expect(d).toEqual({ kind: "edge", edgeKind: "bezier", point: [1, 0, 0], axis: [1, 0, 0], scalar: 2 })
    const noKind = edgeDescriptorOf({ start: [0, 0, 0], end: [2, 0, 0] })
    expect(noKind).toEqual({ kind: "edge", edgeKind: "spline", point: [1, 0, 0], axis: [1, 0, 0], scalar: 2 })
  })

  it("sampled points carrying a malformed entry yield null", () => {
    expect(edgeDescriptorOf({ kind: "spline", points: [[0, 0, 0], [1, 0]] })).toBeNull()
  })

  it("circle and ellipse without a center yield null", () => {
    expect(edgeDescriptorOf({ kind: "circle", radius: 4, axis: [0, 0, 1] })).toBeNull()
    expect(edgeDescriptorOf({ kind: "ellipse", a: 4, b: 2, axis: [0, 0, 1] })).toBeNull()
  })

  it("a partial ellipse without x_axis yields null (no colliding center anchor)", () => {
    expect(
      edgeDescriptorOf({
        kind: "ellipse",
        center: [0, 0, 0],
        a: 4,
        b: 2,
        axis: [0, 0, 1],
        angle_start: 0,
        angle_end: Math.PI,
      }),
    ).toBeNull()
  })
})

describe("descriptorOfElement guards", () => {
  it("a vertex payload without an origin yields null", () => {
    expect(descriptorOfElement({ type: "vertex" })).toBeNull()
  })
})

describe("descriptorDistance edge and vertex arms", () => {
  it("perpendicular edge axes are rejected by the sign-insensitive gate", () => {
    const q: EdgeDescriptor = { kind: "edge", edgeKind: "line", point: [0, 0, 0], axis: [1, 0, 0], scalar: 4 }
    const perp: EdgeDescriptor = { ...q, axis: [0, 1, 0] }
    expect(descriptorDistance(q, perp)).toBeNull()
  })

  it("vertex descriptors measure the plain point distance", () => {
    expect(
      descriptorDistance({ kind: "vertex", point: [0, 0, 0] }, { kind: "vertex", point: [3, 4, 0] }),
    ).toBeCloseTo(5, 9)
  })
})

