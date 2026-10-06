// Split from query.test.ts; see the original section markers for context.

import { describe, it, expect } from "vitest"
import {
  getPoint3d,
  Repository,
} from "../query"
import { isPlaneType, isPointType } from "../solverConstants"

describe("isPlaneType", () => {
  it("accepts plane and face types", () => {
    expect(isPlaneType({ type: "plane" })).toBe(true)
    expect(isPlaneType({ type: "face" })).toBe(true)
    expect(isPlaneType({ type: "flatface" })).toBe(true)
  })

  it("rejects non-plane types", () => {
    expect(isPlaneType({ type: "vertex" })).toBe(false)
    expect(isPlaneType({ type: "edge" })).toBe(false)
    expect(isPlaneType({})).toBe(false)
  })
})

describe("isPointType", () => {
  it("accepts point and vertex types", () => {
    expect(isPointType({ type: "point" })).toBe(true)
    expect(isPointType({ type: "vertex" })).toBe(true)
  })

  it("rejects non-point types", () => {
    expect(isPointType({ type: "plane" })).toBe(false)
    expect(isPointType({ type: "face" })).toBe(false)
    expect(isPointType({})).toBe(false)
  })
})

describe("getPoint3d", () => {
  it("handles vertex type with origin", () => {
    const repo = new Repository()
    const vertex = { type: "vertex", origin: [1.0, 2.0, 3.0] }
    const result = getPoint3d(vertex, repo)
    expect(result[0]).toBeCloseTo(1.0)
    expect(result[1]).toBeCloseTo(2.0)
    expect(result[2]).toBeCloseTo(3.0)
  })

  it("handles origin without normal", () => {
    const repo = new Repository()
    const pt = { origin: [4.0, 5.0, 6.0] }
    const result = getPoint3d(pt, repo)
    expect(result[0]).toBeCloseTo(4.0)
    expect(result[1]).toBeCloseTo(5.0)
    expect(result[2]).toBeCloseTo(6.0)
  })

  it("rejects origin with normal (plane, not a point)", () => {
    const repo = new Repository()
    const planeLike = { origin: [0.0, 0.0, 0.0], normal: [0.0, 0.0, 1.0] }
    expect(() => getPoint3d(planeLike, repo)).toThrow("reference is a plane, not a point")
  })

  it("lifts an external_xy point through its registered sketch plane", () => {
    // A sketch point is stored in 2D; when the sketch's plane transform is
    // registered under `_pt_<sketchId>` the result must be the 3D point, not
    // the bare [x, y, 0] fallback.
    const repo = new Repository()
    repo.register("_pt_sk1", {
      origin: [10, 20, 30],
      x_axis: [1, 0, 0],
      y_axis: [0, 1, 0],
      normal: [0, 0, 1],
    })
    const pt = { external_xy: [2, 3], sketch_id: "sk1" }
    expect(getPoint3d(pt, repo)).toEqual([12, 23, 30])
  })

  it("falls back to [x, y, 0] for external_xy with no plane registered", () => {
    const repo = new Repository()
    const pt = { external_xy: [2, 3], sketch_id: "sk_missing" }
    expect(getPoint3d(pt, repo)).toEqual([2, 3, 0])
  })

  it("throws when the reference carries no coordinates", () => {
    const repo = new Repository()
    expect(() => getPoint3d({ type: "face", id: "f1" }, repo)).toThrow(
      "point reference has no coordinates",
    )
  })
})

