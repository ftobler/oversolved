import { describe, it, expect } from "vitest"
import fixture from "./occ/__fixtures__/geomHashes.json"
import {
  pyRound4Str,
  faceGeometryHash,
  edgeGeometryHash,
  vertexGeometryHash,
  geometryClassifiers,
} from "./geomHash"
import { sha256Hex } from "./sha256"

// The cross-language hash parity gate for phase 2c: every digest the TS kernel
// computes must match the Python kernel byte-for-byte. The fixture is a frozen
// golden snapshot; its generator gen_geomhash_fixture.py was removed with the
// Python kernel in phase 4d.

describe("sha256Hex", () => {
  it("matches known FIPS-180-4 vectors", () => {
    expect(sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    )
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    )
  })
})

describe("pyRound4Str matches CPython str(round(v, 4))", () => {
  const cases: [number, string][] = [
    [5.0, "5.0"],
    [-1.0, "-1.0"],
    [0.0, "0.0"],
    [-0.0, "0.0"],
    [0.12345, "0.1235"],
    [0.123449999, "0.1234"],
    [2.675, "2.675"],
    [-2.675, "-2.675"],
    [0.00004, "0.0"],
    [0.00006, "0.0001"],
    [-0.00006, "-0.0001"],
    [1234567.89012, "1234567.8901"],
    [0.1, "0.1"],
    [0.30000000000000004, "0.3"],
    [123.45605, "123.4561"],
    [-0.0001, "-0.0001"],
    [99999.99995, "99999.9999"],
    [1.0000000001, "1.0"],
  ]
  for (const [v, want] of cases) {
    it(`${v} -> ${want}`, () => expect(pyRound4Str(v)).toBe(want))
  }
})

describe("face hashes match Python", () => {
  for (const c of fixture.faces) {
    it(`face ${c.face_geometry_hash}`, () => {
      expect(faceGeometryHash(c.centroid, c.normal)).toBe(c.face_geometry_hash)
    })
  }
})

describe("edge hashes match Python", () => {
  for (const c of fixture.edges) {
    it(`edge ${c.edge.kind} ${c.edge_geometry_hash}`, () => {
      expect(edgeGeometryHash(c.edge as Record<string, unknown>)).toBe(c.edge_geometry_hash)
    })
  }

  it("throws when an arc lacks center/radius", () => {
    expect(() => edgeGeometryHash({ kind: "arc", angle_start_deg: 0, angle_end_deg: 90 })).toThrow(
      /arc edge missing/,
    )
  })

  // Absent geometry fields fall back to Python int literals ("0"/"1"), which
  // str(round(int, 4)) renders without a decimal point -- distinct from a present
  // [0,0,0] (rendered "0.0"). These goldens are computed independently with Node's
  // crypto against the documented fallback token strings, so they cross-check the
  // project sha256 as well as the fallback branches.
  describe("absent-field fallbacks use Python int literals, not floats", () => {
    it("circle with no center -> '0|0|0', not '0.0|0.0|0.0'", () => {
      // tokens: circle|2.5|0|0|0  (radius present, center absent)
      expect(edgeGeometryHash({ kind: "circle", radius: 2.5 })).toBe("gedge_f2481a56e3e6eb47")
    })

    it("arc with no axis/x_axis -> '0|0|1' / '1|0|0'", () => {
      // tokens: arc|3.0|1.0|2.0|3.0|0.0|90.0|0|0|1|1|0|0  (axis + x_axis absent)
      expect(
        edgeGeometryHash({
          kind: "arc",
          radius: 3.0,
          center: [1, 2, 3],
          angle_start_deg: 0,
          angle_end_deg: 90,
        }),
      ).toBe("gedge_601f9d84573e555e")
    })

    it("ellipse with no center/axis/x_axis -> integer-literal fallbacks", () => {
      // tokens: ellipse|4.0|2.0|0|0|0|0|0|1|1|0|0|0|0
      expect(edgeGeometryHash({ kind: "ellipse", a: 4, b: 2 })).toBe("gedge_ba9595948e7e560c")
    })
  })
})

describe("vertex hashes match Python", () => {
  for (const c of fixture.vertices) {
    it(`vertex ${c.vertex_geometry_hash}`, () => {
      expect(vertexGeometryHash(c.pt)).toBe(c.vertex_geometry_hash)
    })
  }
})

describe("geometry classifiers match Python", () => {
  for (const c of fixture.classifiers) {
    it(`classifiers ${JSON.stringify(c.classifiers)}`, () => {
      expect(geometryClassifiers(c.point, c.center, c.half_extents)).toEqual(c.classifiers)
    })
  }
})

// JSON cannot carry negative zero (the bundler's JSON loader folds -0.0 to 0), so
// the -0 path is gated against hardcoded Python references here. A geometry hash
// must treat -0 == +0 (OCC builds disagree on the sign of a zero coordinate), so
// these inputs hash identically to their +0 counterparts. References regenerated
// from the updated Python geom_hash (`_r4str` normalizes -0.0 to "0.0").
describe("negative-zero normalization parity (Python _r4str(-0.0) == '0.0')", () => {
  it("face", () => {
    expect(faceGeometryHash([-0, 0.00004, 0.00006], [-0.00006, 1.0000000001, 0.0])).toBe(
      "gface_eb4440e4bb1f8812",
    )
  })
  it("vertex", () => {
    expect(vertexGeometryHash([-0, 1.5, -0])).toBe("gvertex_20cd7b4277207ef7")
  })
  it("edge line", () => {
    expect(
      edgeGeometryHash({ kind: "line", start: [-0, 2.25, -7.125], end: [3.33333, 4.44444, 5.55555] }),
    ).toBe("gedge_abf4d63065263756")
  })
})


