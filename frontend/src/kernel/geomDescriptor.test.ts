// Tests for geometric descriptor tokens (query-descriptor-identity): wire
// round-trip, per-kind derivation, and the tolerance-matching gates the
// resolver and fillet/chamfer consumers rely on.

import { describe, it, expect } from "vitest"
import {
  bestDescriptorMatch,
  DEFAULT_DESCRIPTOR_MATCH,
  descriptorDistance,
  descriptorOfElement,
  edgeDescriptorOf,
  emitEdgeDescriptor,
  emitFaceDescriptor,
  emitVertexDescriptor,
  isGeomDescriptorId,
  narrowByDescriptor,
  parseGeomDescriptorId,
  type EdgeDescriptor,
  type GeomDescriptor,
} from "./geomDescriptor"

const face = (point: number[], axis: number[]): GeomDescriptor => ({ kind: "face", point, axis })

describe("wire format", () => {
  it("face token round-trips", () => {
    const tok = emitFaceDescriptor([1.5, -2, 0.00004], [0, 0, 1])
    expect(tok.startsWith("@gdf|")).toBe(true)
    const d = parseGeomDescriptorId(tok)
    expect(d).toEqual({ kind: "face", point: [1.5, -2, 0], axis: [0, 0, 1] })
  })

  it("edge token round-trips", () => {
    const src: EdgeDescriptor = { kind: "edge", edgeKind: "circle", point: [1, 2, 3], axis: [0, 0, 1], scalar: 5 }
    const d = parseGeomDescriptorId(emitEdgeDescriptor(src))
    expect(d).toEqual(src)
  })

  it("vertex token round-trips", () => {
    const d = parseGeomDescriptorId(emitVertexDescriptor([4, 5, 6]))
    expect(d).toEqual({ kind: "vertex", point: [4, 5, 6] })
  })

  it("isGeomDescriptorId recognizes all three prefixes and rejects others", () => {
    expect(isGeomDescriptorId(emitFaceDescriptor([0, 0, 0], [0, 0, 1]))).toBe(true)
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
    const toks = [
      emitFaceDescriptor([1.25, -3.5, 10], [0.7071, 0.7071, 0]),
      emitEdgeDescriptor({ kind: "edge", edgeKind: "arc", point: [1, 2, 3], axis: [0, 0, 1], scalar: 2.5 }),
      emitVertexDescriptor([-0.0001, 9999.9999, 0]),
    ]
    for (const t of toks) expect(t.includes(" ")).toBe(false)
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

describe("bestDescriptorMatch (strict actuating consumers)", () => {
  it("unique tight hit wins", () => {
    const q = face([0, 0, 10], [0, 0, 1])
    const winner = bestDescriptorMatch(q, [
      ["a", face([0, 0, 10.0002], [0, 0, 1])],
      ["b", face([0, 0, 12], [0, 0, 1])],
    ])
    expect(winner).toBe("a")
  })

  it("two tight hits are ambiguous -> undefined", () => {
    const q = face([0, 0, 10], [0, 0, 1])
    const winner = bestDescriptorMatch(q, [
      ["a", face([0, 0, 10.0001], [0, 0, 1])],
      ["b", face([0, 0, 9.9999], [0, 0, 1])],
    ])
    expect(winner).toBeUndefined()
  })

  it("near-tie outside the tight window -> undefined", () => {
    const q = face([0, 0, 10], [0, 0, 1])
    const winner = bestDescriptorMatch(q, [
      ["a", face([0, 0, 11], [0, 0, 1])],
      ["b", face([0, 0, 11.5], [0, 0, 1])],
    ])
    expect(winner).toBeUndefined()
  })

  it("nothing passes the gate -> undefined (never a wild guess)", () => {
    const q = face([0, 0, 10], [0, 0, 1])
    expect(bestDescriptorMatch(q, [["a", face([0, 0, 10], [1, 0, 0])]])).toBeUndefined()
    expect(bestDescriptorMatch(q, [])).toBeUndefined()
  })

  it("respects a custom config", () => {
    const q = face([0, 0, 10], [0, 0, 1])
    const loose = { ...DEFAULT_DESCRIPTOR_MATCH, ratioMargin: 1.1 }
    const winner = bestDescriptorMatch(
      q,
      [
        ["a", face([0, 0, 11], [0, 0, 1])],
        ["b", face([0, 0, 11.5], [0, 0, 1])],
      ],
      loose,
    )
    expect(winner).toBe("a")
  })
})
