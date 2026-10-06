// Split from query.test.ts; see the original section markers for context.

import { describe, it, expect, vi } from "vitest"
import {
  parseQuery,
  emitWire,
  parseAncestry,
  makeAncestryQuery,
  local,
  absolute,
  ancestry,
  ref,
  bodyIdOf,
  Repository,
} from "../query"

describe("parse/emit round-trips", () => {
  it("local with subpoint", () => {
    expect(parseQuery("$e3start")).toEqual(local("e3", "start"))
    expect(parseQuery("$e3")).toEqual(local("e3"))
    // The wider VERTEX_POINT_KEYS suffix set (shared with utils/query) splits
    // `$mystart` into eid "my" + sub "start". The old isAlpha guard swallowed
    // real persisted sub-suffixes like `$pwfYD59xKWiSyQhmcenter`; the kernel now
    // adopts the utils set so the two serializers parse byte-identically.
    expect(parseQuery("$mystart")).toEqual(local("my", "start"))
    expect(emitWire(local("e3", "start"))).toBe("$e3start")
  })

  it("absolute feature / element / sub", () => {
    expect(parseQuery("@feat")).toEqual(absolute("feat"))
    expect(parseQuery("@feat/e0")).toEqual(absolute("feat", "e0"))
    expect(parseQuery("@feat/e0/start")).toEqual(absolute("feat", "e0", "start"))
    expect(emitWire(absolute("feat", "e0", "start"))).toBe("@feat/e0/start")
    expect(emitWire(absolute("feat"))).toBe("@feat")
  })

  it("ancestry wire round-trip with hex length headers", () => {
    const wire = makeAncestryQuery(["@feat_a", "edge:0", "@body_x"], "edge")
    const [ids, tr] = parseAncestry(wire)
    expect(ids).toEqual(["@feat_a", "edge:0", "@body_x"])
    expect(tr).toBe("edge")
    expect(emitWire(ancestry(["@feat_a", "edge:0", "@body_x"], "edge"))).toBe(wire)
  })

  // wire-format-hardening: an empty restriction IS null on the wire, so the
  // trailing ":" is never emitted. makeAncestryQuery and emitWire now agree
  // ("?2;@a:" was the old makeAncestryQuery-only asymmetry, pinned below in
  // queryWireHardening.test.ts as an accepted-but-canonicalized form).
  it("empty type restriction is null on the wire (no trailing ':')", () => {
    expect(makeAncestryQuery(["@a"], "")).toBe("?2;@a")
    expect(emitWire(ancestry(["@a"], ""))).toBe("?2;@a")
  })

  it("parseAncestry rejects truncated and bad-hex inputs", () => {
    expect(() => parseAncestry("?3;ab")).toThrow()
    expect(() => parseAncestry("?zz;abc")).toThrow()
    expect(() => parseAncestry("?3")).toThrow()
    expect(() => parseQuery("nonsense")).toThrow()
  })

  it("ref and bodyIdOf", () => {
    expect(ref("body_x")).toBe("@body_x")
    const wire = makeAncestryQuery(["@body_ex1edge0", "@body_ex1"])
    expect(bodyIdOf(wire, { body_ex1: {} })).toBe("body_ex1")
    // "body_ex1edge0" is a fabricated concatenation of the two ancestor tokens
    // ("body_ex1" + "edge0"), never a real body: it must not resolve when no
    // store (or a store holding no candidate) is present.
    expect(bodyIdOf(wire)).toBeNull()
    expect(bodyIdOf(wire, { other: {} })).toBeNull()
    expect(bodyIdOf("?1;@a")).toBeNull()

    // Slash-joined current-format token: with a store the "/face0" tail is
    // stripped and the body id verified; without one nothing is verified.
    expect(bodyIdOf(makeAncestryQuery(["@body_ex1/face0"]), { body_ex1: {} })).toBe("body_ex1")
    expect(bodyIdOf(makeAncestryQuery(["@body_ex1/face0"]))).toBeNull()
  })

  it("bodyIdOf verifies against the store and never fabricates an id", () => {
    // A legitimately-formed single body token (a split-sibling id) resolves
    // only when the store actually holds it; a no-store or no-candidate call
    // returns null rather than handing back an unverified token.
    const splitSibling = makeAncestryQuery(["@body_ex1_1"])
    expect(bodyIdOf(splitSibling, { body_ex1_1: {} })).toBe("body_ex1_1")
    expect(bodyIdOf(splitSibling)).toBeNull()
    expect(bodyIdOf(splitSibling, { body_ex1: {} })).toBeNull()
  })
})


describe("emitWire wire-ambiguity warning (dev/test only)", () => {
  // The `$eid[sub]` grammar cannot distinguish a bare minted id ending in a
  // vertex-key word from an id+sub pair. emitWire picks the deterministic
  // reading but must surface the divergence in dev/test so it is never
  // silently hidden; production stays quiet because a minted id can land on
  // either side.
  it("warns when the emitted local re-parses to a different eid/sub", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      // A bare id ending in "center": the wire re-parses as eid + sub.
      emitWire(local("pwfYD59xKWiSyQhmcenter"))
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0][0])).toContain("ambiguous on the wire")
    } finally {
      warn.mockRestore()
    }
  })

  it("stays silent when the emitted local re-parses identically", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      expect(emitWire(local("e3", "start"))).toBe("$e3start")
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })
})


describe("makeAncestryQuery construction details", () => {
  // Result starts with '?' and ends with ':face'.
  it("produces wire format with type restriction suffix", () => {
    const ids = ["@sketchA/lineX", "@sketchA/lineY"]
    const q = makeAncestryQuery(ids, "face")
    expect(q.startsWith("?")).toBe(true)
    expect(q.endsWith(":face")).toBe(true)
  })

  // Caller is responsible for sort order - different order → different string.
  it("preserves caller-determined sort order", () => {
    const q_ab = makeAncestryQuery(["@a", "@b"], "face")
    const q_ba = makeAncestryQuery(["@b", "@a"], "face")
    expect(q_ab).not.toBe(q_ba)
    const ids = ["@b", "@a"]
    const q_sorted = makeAncestryQuery([...ids].sort(), "face")
    const q_sorted2 = makeAncestryQuery([...ids].sort(), "face")
    expect(q_sorted).toBe(q_sorted2)
  })

  it("supports nested ancestry query strings", () => {
    const inner = makeAncestryQuery(["AAAAAAAAAAAA", "BBBBBBBBBBBB"])
    const outer = makeAncestryQuery([inner, "AAAAAAAAAAAA"])
    const [ids] = parseAncestry(outer)
    expect(ids[0]).toBe(inner)
    expect(ids[1]).toBe("AAAAAAAAAAAA")
  })
})


describe("parseAncestry edge cases", () => {
  // wire-format-hardening: unconsumed trailing data that is not a ":type" /
  // "@cls" suffix used to be dropped silently; it now fails loud (pinned in
  // queryWireHardening.test.ts). The old lenient behavior hid typos.
  it("rejects unconsumed trailing data beyond the parsed length", () => {
    expect(() => parseAncestry("?3;abcdef")).toThrow()
  })
})

/** Geometry simplification scenario: a query was built with ancestors {A, B, C}
 * (e.g. three concurrent lines), but after a geometry change the element is
 * re-registered with only {A, B}. The old query must still resolve because
 * {A, B} ⊆ {A, B, C}.
 *
 * If a query matches more than one element, it is ambiguous and must raise. */

describe("parseQuery validation", () => {
  it("rejects absolute format with too many path parts", () => {
    expect(() => parseQuery("@a/b/c/d")).toThrow("Unrecognized absolute query")
  })
})


describe("empty query handling", () => {
  it("empty string query returns null", () => {
    const repo = new Repository()
    expect(repo.query("")).toBeNull()
  })
})


describe("typed query object dispatch", () => {
  it("repo.query accepts LocalQuery via local() helper", () => {
    const repo = new Repository()
    const obj = { v: 1 }
    repo.register("AAAAAAAAAAAAAAAAAA/e1", obj)
    expect(repo.query(local("e1"), "AAAAAAAAAAAAAAAAAA/")).toBe(obj)
  })

  it("repo.query accepts AbsoluteQuery via absolute() helper", () => {
    const repo = new Repository()
    const obj = { v: 2 }
    repo.register("AAAAAAAAAAAAAAAAAA/BBBBBBBBBBBB", obj)
    expect(repo.query(absolute("AAAAAAAAAAAAAAAAAA", "BBBBBBBBBBBB"))).toBe(obj)
  })

  it("repo.query accepts AncestryQuery via ancestry() helper", () => {
    const repo = new Repository()
    const obj = { type: "pt" }
    const ids = ["@a", "@b"]
    repo.registerAncestor(ids, obj)
    const aq = ancestry(ids, "pt")
    expect(repo.query(aq)).toBe(obj)
  })
})

