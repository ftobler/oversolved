// Split from query.test.ts; see the original section markers for context.

import { describe, it, expect } from "vitest"
import {
  makeAncestryQuery,
  constructionUuidToken,
  Repository,
  AmbiguousQueryError,
} from "./query"

describe("descriptor tier resolution", () => {
  const cap = (z: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    type: "flatface",
    body_id: "body1",
    created_by: "ex1",
    centroid: [0, 0, z],
    normal: [0, 0, 1],
    ...extra,
  })

  /** The headline fix: a dimension edit moved the picked face; the persisted
   *  descriptor still finds it among ancestry siblings by nearest-with-margin,
   *  where the old digest token would have gone stale. */
  it("resolves a moved face among ancestry siblings", () => {
    const repo = new Repository()
    // Two caps of one extrude: the picked +z cap moved from z=10 to z=14.
    repo.registerAncestor(["@body1/face0", "@ex1", "@body1"], cap(0, { normal: [0, 0, -1] }))
    repo.registerAncestor(["@body1/face1", "@ex1", "@body1"], cap(14))
    const q = makeAncestryQuery(["@gdf|0,0,10|0,0,1", "@ex1", "@body1"], "flatface")
    const result = repo.query(q)
    expect(result).not.toBeNull()
    expect((result as Record<string, unknown>).centroid).toEqual([0, 0, 14])
  })

  it("signed normal gate never matches the anti-parallel cap", () => {
    const repo = new Repository()
    repo.registerAncestor(["@body1/face0", "@ex1", "@body1"], cap(0, { normal: [0, 0, -1] }))
    const q = makeAncestryQuery(["@gdf|0,0,10|0,0,1", "@ex1", "@body1"], "flatface")
    // Only candidate fails the gate -> graceful passthrough leaves 1 candidate,
    // which resolves (same as today's single-candidate behaviour), so instead
    // register a second aligned face and assert the gate picks it.
    repo.registerAncestor(["@body1/face1", "@ex1", "@body1"], cap(20))
    const result = repo.query(q)
    expect((result as Record<string, unknown>).centroid).toEqual([0, 0, 20])
  })

  it("a near-tie stays ambiguous and fails loud", () => {
    const repo = new Repository()
    repo.registerAncestor(["@body1/face0", "@ex1", "@body1"], cap(11))
    repo.registerAncestor(["@body1/face1", "@ex1", "@body1"], cap(11.5))
    const q = makeAncestryQuery(["@gdf|0,0,10|0,0,1", "@ex1", "@body1"], "flatface")
    expect(() => repo.query(q)).toThrow(AmbiguousQueryError)
  })

  it("tight window beats nearest: numeric jitter resolves exactly", () => {
    const repo = new Repository()
    repo.registerAncestor(["@body1/face0", "@ex1", "@body1"], cap(10.0002))
    repo.registerAncestor(["@body1/face1", "@ex1", "@body1"], cap(10.4))
    const q = makeAncestryQuery(["@gdf|0,0,10|0,0,1", "@ex1", "@body1"], "flatface")
    const result = repo.query(q)
    expect((result as Record<string, unknown>).centroid).toEqual([0, 0, 10.0002])
  })

  it("descriptor tokens do not poison the ancestry subset match", () => {
    const repo = new Repository()
    // Registered WITHOUT any descriptor in the key set; a query carrying a
    // descriptor must still full-subset match on its non-descriptor tokens.
    repo.registerAncestor(["@ex1", "@body1"], cap(5))
    const q = makeAncestryQuery(["@gdf|0,0,5|0,0,1", "@ex1", "@body1"])
    expect(repo.query(q)).not.toBeNull()
  })

  it("mixed garbage descriptor + UUID: UUID tier still resolves", () => {
    const repo = new Repository()
    repo.registerAncestor(["@body1/face0", "@ex1", "@body1"], cap(0), "u_old0")
    repo.registerAncestor(["@body1/face1", "@ex1", "@body1"], cap(10), "u_old1")
    // Descriptor is unparseable garbage (never narrows); the UUID
    // still disambiguates by construction identity.
    const q = makeAncestryQuery(["@gdf|garbage", constructionUuidToken("u_old1"), "@ex1", "@body1"], "flatface")
    const result = repo.query(q)
    expect((result as Record<string, unknown>).centroid).toEqual([0, 0, 10])
  })

  it("global fallback without ancestry is tight-only", () => {
    const repo = new Repository()
    repo.registerAncestor(["@body1/face0", "@ex1", "@body1"], cap(10))
    // Exact position: resolves globally (analogue of the precise-hash rule).
    const qTight = makeAncestryQuery(["@gdf|0,0,10|0,0,1", "@X", "@Y"], "flatface")
    expect(repo.query(qTight)).not.toBeNull()
    // Moved position: must NOT loose-match across lineages -> null.
    const qLoose = makeAncestryQuery(["@gdf|0,0,13|0,0,1", "@X", "@Y"], "flatface")
    expect(repo.query(qLoose)).toBeNull()
  })

  it("edge descriptors tie-break edge siblings", () => {
    const repo = new Repository()
    const edge = (y: number): Record<string, unknown> => ({
      type: "straightedge",
      body_id: "body1",
      created_by: "ex1",
      kind: "line",
      start: [0, y, 0],
      end: [10, y, 0],
    })
    repo.registerAncestor(["@body1/edge0", "@ex1", "@body1"], edge(0))
    repo.registerAncestor(["@body1/edge1", "@ex1", "@body1"], edge(20))
    const q = makeAncestryQuery(
      [
        "@gde|line|5,21,0|1,0,0|10",
        "@ex1",
        "@body1",
      ],
      "straightedge",
    )
    const result = repo.query(q)
    expect((result as Record<string, unknown>).start).toEqual([0, 20, 0])
  })

  it("queryAll ignores descriptor tokens in the subset match", () => {
    const repo = new Repository()
    repo.registerAncestor(["@ex1", "@body1"], cap(5))
    const q = makeAncestryQuery(["@gdf|9,9,9|0,0,1", "@ex1"])
    expect(repo.queryAll(q).length).toBe(1)
  })
})
