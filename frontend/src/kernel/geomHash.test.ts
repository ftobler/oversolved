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

describe("geometryClassifiers boundary policy", () => {
  // The threshold `offset === rel*h` is a knife-edge: strict comparisons mint no
  // token there, so a face sitting exactly on the classifier boundary (e.g. the
  // 45 deg rotated square prism side faces) used to mint no classifiers at all.
  // The boundary is inclusive (>= / <=): an offset exactly at rel*h is
  // deterministically "on that side" and never silently minted as nothing.
  it("an offset exactly at rel*h mints the + axis token", () => {
    expect(geometryClassifiers([5, 0, 0], [0, 0, 0], [10, 10, 5])).toEqual(["cls_xp"])
    expect(geometryClassifiers([0, 5, 0], [0, 0, 0], [10, 10, 5])).toEqual(["cls_yp"])
    expect(geometryClassifiers([0, 0, 2.5], [0, 0, 0], [10, 10, 5])).toEqual(["cls_zp"])
  })

  it("an offset exactly at -rel*h mints the - axis token", () => {
    expect(geometryClassifiers([-5, 0, 0], [0, 0, 0], [10, 10, 5])).toEqual(["cls_xn"])
    expect(geometryClassifiers([0, -5, 0], [0, 0, 0], [10, 10, 5])).toEqual(["cls_yn"])
    expect(geometryClassifiers([0, 0, -2.5], [0, 0, 0], [10, 10, 5])).toEqual(["cls_zn"])
  })

  it("an offset just inside the boundary still mints nothing", () => {
    expect(geometryClassifiers([5 - 1e-6, 0, 0], [0, 0, 0], [10, 10, 5])).toEqual([])
    expect(geometryClassifiers([-5 + 1e-6, 0, 0], [0, 0, 0], [10, 10, 5])).toEqual([])
  })
})

describe("world-frame classifier minting (best-effort contract)", () => {
  // The cls_* tokens are minted against the WORLD-FRAME body AABB (`bodyFrame`
  // in tessellation.ts), never a body-local frame, so a given solid's tokens
  // depend on its orientation in the document: the 45 deg and 60 deg rotations
  // of one square prism mint different sets. This is accepted and documented:
  // the classifier tier is secondary, and every element also carries a
  // construction `@u|` UUID, the primary tier, so a rotated body still resolves
  // when its classifiers collapse (pinned in query.test.ts).
  function rotatedSquareSideCentroids(s: number, angleDeg: number): number[][] {
    const th = (angleDeg * Math.PI) / 180
    const c = Math.cos(th)
    const sn = Math.sin(th)
    const rot = (x: number, y: number): number[] => [x * c - y * sn, x * sn + y * c]
    const verts = [rot(s / 2, s / 2), rot(-s / 2, s / 2), rot(-s / 2, -s / 2), rot(s / 2, -s / 2)]
    const mids: number[][] = []
    for (let i = 0; i < 4; i++) {
      const a = verts[i]
      const b = verts[(i + 1) % 4]
      mids.push([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, 0])
    }
    return mids
  }

  function worldHalfExtents(s: number, h: number, angleDeg: number): number[] {
    const th = (angleDeg * Math.PI) / 180
    const span = Math.abs(Math.cos(th)) + Math.abs(Math.sin(th))
    const r = (s * span) / 2
    return [r, r, h / 2]
  }

  it("the 45 deg rotated square prism side faces sit exactly on the rel*h boundary and mint on the inclusive policy", () => {
    const s = 2
    const half = worldHalfExtents(s, 1, 45)
    const tokens = rotatedSquareSideCentroids(s, 45).map(m =>
      geometryClassifiers(m, [0, 0, 0], half).sort(),
    )
    expect(tokens).toEqual([
      ["cls_xn", "cls_yp"],
      ["cls_xn", "cls_yn"],
      ["cls_xp", "cls_yn"],
      ["cls_xp", "cls_yp"],
    ])
  })

  it("the 60 deg rotated square prism side faces mint a distinct rotation-dependent set", () => {
    const s = 2
    const half = worldHalfExtents(s, 1, 60)
    const tokens = rotatedSquareSideCentroids(s, 60).map(m =>
      geometryClassifiers(m, [0, 0, 0], half).sort(),
    )
    // Every side-face centroid has one component at 0.25s (inside rel*h =
    // 0.342s, no token) and one at 0.433s (outside, one token), so each side
    // face mints exactly one rotation-dependent token and none mint zero.
    // Different from the 45 deg set above (two tokens per face), which is
    // exactly why the uuid tier must be the primary identity.
    expect(tokens).toEqual([
      ["cls_xn"],
      ["cls_yn"],
      ["cls_xp"],
      ["cls_yp"],
    ])
  })
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


