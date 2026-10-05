// Split from query.test.ts; see the original section markers for context.

import { describe, it, expect } from "vitest"
import {
  ancestry,
  constructionUuidToken,
  Repository,
} from "./query"

describe("queryAllTyped", () => {
  it("uuid-only typed query returns that uuid's elements only", () => {
    const repo = new Repository()
    repo.registerAncestor(["@feat1"], { type: "flatface", tag: "u_ele" }, "u_aaa")
    repo.registerAncestor(["@feat2"], { type: "straightedge", tag: "other" })
    const results = repo.queryAllTyped(
      ancestry([constructionUuidToken("u_aaa")]),
    ) as Record<string, unknown>[]
    expect(results.length).toBe(1)
    expect(results[0].tag).toBe("u_ele")
  })

  it("classifier-only typed query returns []", () => {
    const repo = new Repository()
    repo.registerAncestor(["@feat1"], { type: "flatface", classifiers: ["cls_zp"] })
    expect(repo.queryAllTyped(ancestry(["@cls_zp"]))).toEqual([])
  })

  it("type restriction matches subtypes", () => {
    const repo = new Repository()
    repo.registerAncestor(["@feat1"], { type: "flatface", tag: "ff" })
    const results = repo.queryAllTyped(ancestry(["@feat1"], "face")) as Record<string, unknown>[]
    expect(results.length).toBe(1)
    expect(results[0].tag).toBe("ff")
  })
})

