// Weaker-tier guards of the ancestry resolver: the partial tier honors subtypes.

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
