// Weaker-tier guards of the ancestry resolver: the partial tier honors subtypes,
// and queryAll narrows by classifier before the type block exactly like query().

import { describe, it, expect } from "vitest"
import { Repository, makeAncestryQuery } from "../query"

type Payload = Record<string, unknown>

describe("ancestral-partial tier type restriction", () => {
  it("a :face query recovers a lone flatface through the partial tier", () => {
    const repo = new Repository()
    repo.registerAncestor(["@a"], { type: "flatface", tag: "f" })
    expect((repo.query(makeAncestryQuery(["@a", "@b"], "face")) as Payload).tag).toBe("f")
    expect(repo._lastTier).toBe("ancestral-partial")
  })

  it("an exact-type partial candidate outranks a subtype one", () => {
    const repo = new Repository()
    repo.registerAncestor(["@a"], { type: "face", tag: "exact" })
    repo.registerAncestor(["@a"], { type: "flatface", tag: "sub" })
    expect((repo.query(makeAncestryQuery(["@a", "@b"], "face")) as Payload).tag).toBe("exact")
  })

  it("an unrelated type is still filtered out", () => {
    const repo = new Repository()
    repo.registerAncestor(["@a"], { type: "straightedge" })
    expect(repo.query(makeAncestryQuery(["@a", "@b"], "face"))).toBeNull()
  })
})

describe("queryAll classifier narrowing precedes the type block", () => {
  const body = { id: "body_1", modified_by: [] }
  function repoWithEdge(classifiers: string[]): Repository {
    const repo = new Repository()
    repo.registerAncestor(["@ex1", "@body_1", "@body_1/edge0"], {
      type: "straightedge", body_id: "body_1", created_by: "ex1", classifiers,
    })
    return repo
  }

  it("a contradicted candidate does not coerce to its solid in queryAll (matches query())", () => {
    const repo = repoWithEdge(["cls_zn"])
    const q = makeAncestryQuery(["@ex1", "@body_1", "@cls_zp"], "solid")
    expect(repo.query(q, null, { body_1: body })).toBeNull()
    expect(repo.queryAll(q, null, { body_1: body })).toEqual([])
    expect(repo._lastTier).toBe("miss")
  })

  it("a non-contradicted candidate still coerces upward in both", () => {
    const repo = repoWithEdge(["cls_zp"])
    const q = makeAncestryQuery(["@ex1", "@body_1", "@cls_zp"], "solid")
    expect(repo.query(q, null, { body_1: body })).toBe(body)
    expect(repo.queryAll(q, null, { body_1: body })).toEqual([body])
  })
})
