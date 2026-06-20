import { describe, it, expect } from "vitest"
import {
  parseQuery,
  emitWire,
  local,
  absolute,
  ancestry,
  makeAncestryQuery,
} from "./query"

/** Unit tests for the typed query classes introduced in query.ts.
 * Tests are pure TypeScript -- no solver, no Repository.
 * Ported from the removed tests/kernel/test_query_types.py */

describe("LocalQuery parse subpoints", () => {
  it("parses $line1end", () =>
    expect(parseQuery("$line1end")).toEqual(local("line1", "end")))

  it("parses $line1center", () =>
    expect(parseQuery("$line1center")).toEqual(local("line1", "center")))

  it("parses $line1xy", () =>
    expect(parseQuery("$line1xy")).toEqual(local("line1", "xy")))
})

describe("LocalQuery roundtrip all subpoints", () => {
  for (const sub of ["", "start", "end", "center", "xy"]) {
    it(`roundtrips sub=${JSON.stringify(sub)}`, () => {
      const q = local("e1", sub)
      expect(parseQuery(emitWire(q))).toEqual(q)
    })
  }
})

describe("LocalQuery equality", () => {
  it("equal for same eid and sub", () =>
    expect(local("e1", "start")).toEqual(local("e1", "start")))

  it("not equal for different sub", () =>
    expect(local("e1", "start")).not.toEqual(local("e1", "end")))

  it("not equal for different eid", () =>
    expect(local("e1", "start")).not.toEqual(local("e2", "start")))
})

describe("AncestryQuery nesting", () => {
  it("inner wire appears inside outer wire", () => {
    const inner = ancestry(["@a", "@b"], "flatface")
    const outer = ancestry([inner, "@c"])
    const wire = emitWire(outer)
    expect(wire).toContain(emitWire(inner))
  })
})

describe("AncestryQuery accepts query objects", () => {
  it("wires absolute queries into ancestorIds", () => {
    const a = absolute("sk1", "a")
    const b = absolute("sk1", "b")
    const q = ancestry([a, b])
    expect(q.ancestorIds).toEqual(["@sk1/a", "@sk1/b"])
  })
})

describe("ancestry helper equality (object vs string inputs)", () => {
  it("produces identical ancestry object from query objects and strings", () => {
    const q1 = ancestry([absolute("f", "a"), absolute("f", "b")])
    const q2 = ancestry(["@f/a", "@f/b"])
    expect(q1).toEqual(q2)
  })
})

describe("parseQuery errors", () => {
  it("rejects empty string", () => {
    expect(() => parseQuery("")).toThrow("Unrecognized query string")
  })

  it("rejects unknown prefix", () => {
    expect(() => parseQuery("xbad")).toThrow("Unrecognized query string")
  })
})

describe("makeAncestryQuery / parseQuery / emitWire roundtrip", () => {
  it("full roundtrip with type restriction via parseQuery", () => {
    const ids = ["@sk1a", "@sk1b"]
    const base = makeAncestryQuery(ids, "flatface")
    const q = parseQuery(base)
    expect(emitWire(q)).toBe(base)
  })
})
