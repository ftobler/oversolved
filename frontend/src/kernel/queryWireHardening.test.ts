// wire-format-hardening: canonical parse/emit round-trip identity plus the
// edge cases that used to be asymmetric or over-lenient. The canonical rules
// are documented at their parse/emit sites in kernel/query.ts:
//   - local: a suffix word splits only when unambiguous. A pure-word suffix
//     (start/end/center/xy) always splits, so "$a1xy" reads eid "a1" sub "xy";
//     a digit-bearing suffix (c1/c2/major1/...) splits only when the residual
//     is a plausible legacy id (lowercase alnum + digit), so "$arc1" and minted
//     base64url ids stay one id. The parser is context-free; a bare id that
//     lands on the split side is read as eid+sub here and the knownIds readers
//     (resolveLocal / resolveQueryRef) disambiguate by full entity-id
//     membership. emitWire never throws for a minted id -- it warns in
//     dev/test when the two readings diverge.
//   - ancestry: "?0;" frames zero ids; a zero-length segment (a "0" in any
//     other position) and unconsumed trailing data that is not a ":type" or
//     "@cls" suffix both throw.
//   - absolute: 1-3 non-empty slash parts only; anything else throws.
import { describe, it, expect, vi } from "vitest"
import {
  parseQuery,
  emitWire,
  local,
  ancestry,
  makeAncestryQuery,
  parseAncestry,
  Repository,
} from "./query"

// emitWire(parseQuery(s)) === s for every canonical wire string. These cover
// eids ending in each suffix word, single-char eids, empty id lists, "?0;",
// ids containing ";" / ":" / "@", base64url eids, and legacy concatenated
// absolute form.
const CANONICAL: string[] = [
  // bare locals and single-char eids
  "$a", "$x", "$1", "$e3",
  // real ids ending in the digit-bearing suffix "c1" stay bare
  "$arc1", "$circ1",
  // sub-suffixed locals, one per suffix word (residual "a1" is plausible)
  "$a1start", "$a1end", "$a1center", "$a1xy",
  "$a1major1", "$a1major2", "$a1minor1", "$a1minor2", "$a1c1", "$a1c2",
  // eids whose tail is itself a suffix word: the parse splits, the string
  // still round-trips
  "$e1xy", "$e1start", "$mystart", "$pwfYD59xKWiSyQhmcenter",
  // single-char eids equal to a suffix word (length guard: no split)
  "$start", "$end", "$center", "$xy",
  // base64url eids (alphanumeric plus - and _)
  "$k-g9YNviFC85Z-7Kstart", "$k-g9YNviFC85Z-7Kend", "$8fWd2cM38yAeIlQ6start",
  // minted base64url bare id ending in a pure-word suffix: the kernel reads it
  // as eid+sub (deterministic rule), the string still round-trips, and the
  // knownIds readers resolve it as the whole id (see partDocToSketches.test.ts)
  "$k-g9YNviFC85Z-7Kxy",
  // absolute: bare feature, feature/eid, feature/eid/sub, builtin
  "@sk1", "@sk1/l1", "@sk1/l1/start", "@feat_a/e0", "@builtin_plane_front",
  // legacy concatenated absolute (featureId = whole tail, no slash to split)
  "@sketch2line1",
  // ancestry: bare, multi, type, classifier, both
  "?1;x", "?2;@a", "?7;@feat_a",
  "?2,2;@a@b", "?2,2;@a@b:flatface", "?2,2;@a@b@inner", "?2,2;@a@b:flatface@inner",
  "?7,7;@feat_a@body_x",
  // ids containing ":" / "@" / ";" (length-framed, so the chars are safe)
  "?2,6;@aedge:0", "?4;@a@b", "?3;a;b",
  // empty id list canonical form, with and without type/classifier suffix
  "?0;", "?0;:face", "?0;@inner", "?0;:face@inner",
]

describe("round-trip identity: emitWire(parseQuery(s)) === s", () => {
  for (const s of CANONICAL) {
    it(JSON.stringify(s), () => {
      expect(emitWire(parseQuery(s))).toBe(s)
    })
  }
})

// Accepted non-canonical strings canonicalize on re-emit; both module surfaces
// must agree on the canonical form.
describe("accepted non-canonical strings canonicalize on re-emit", () => {
  it('"?2;@a:" (empty restriction) re-emits "?2;@a" and parses to the same query', () => {
    expect(parseQuery("?2;@a:")).toEqual(parseQuery("?2;@a"))
    expect(emitWire(parseQuery("?2;@a:"))).toBe("?2;@a")
    expect(emitWire(parseQuery("?2;@a"))).toBe("?2;@a")
  })

  it('"?00;" (a zero length with a leading zero) is the empty form and re-emits "?0;"', () => {
    expect(parseQuery("?00;")).toEqual(ancestry([], null, null))
    expect(emitWire(parseQuery("?00;"))).toBe("?0;")
  })
})

// The ...1xy decision (canonical local-parse rule): "$a1xy" splits because "xy"
// is a pure English word. The counterpart "$arc1" (a real, common entity id
// ending in the digit-bearing suffix "c1") must NOT split -- its residual "ar"
// is not a plausible minted id -- so real ids stay representable. The split
// side wins for pure-word suffixes (start/end/center/xy) because a real eid
// ending in an English word is contrived. A bare id that lands on that side
// (e.g. a minted base64url id ending in "xy") emits fine -- the knownIds
// readers resolve it as the whole id by membership; emitWire only warns in
// dev/test about the kernel-vs-contextual divergence.
describe("local suffix-word ambiguity (the ...1xy case)", () => {
  it('parseQuery("$a1xy") reads eid "a1" sub "xy"', () => {
    expect(parseQuery("$a1xy")).toEqual(local("a1", "xy"))
    expect(emitWire(local("a1", "xy"))).toBe("$a1xy")
  })

  it('real ids ending in a digit-bearing suffix stay bare: "$arc1" reads eid "arc1"', () => {
    expect(parseQuery("$arc1")).toEqual(local("arc1"))
    expect(parseQuery("$circ1")).toEqual(local("circ1"))
    expect(emitWire(local("arc1"))).toBe("$arc1")
    expect(emitWire(local("circ1"))).toBe("$circ1")
  })

  it('a minted base64url id ending in "c2" stays one id (the ngon regression)', () => {
    // A randomId base64url token (uppercase + digits) is not a plausible legacy
    // residual, so the digit-bearing "c2" never splits it into eid "...Hu".
    expect(parseQuery("$bakm3Nh6CoDEHuc2")).toEqual(local("bakm3Nh6CoDEHuc2"))
    expect(emitWire(local("bakm3Nh6CoDEHuc2"))).toBe("$bakm3Nh6CoDEHuc2")
  })

  it("a real id's sub-point still round-trips", () => {
    const q = local("arc1", "start")
    expect(parseQuery(emitWire(q))).toEqual(q)
  })

  it("emitWire never throws on a bare id on the split side; it emits and warns in dev/test", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    try {
      expect(emitWire(local("a1xy"))).toBe("$a1xy")
      expect(emitWire(local("mystart"))).toBe("$mystart")
      expect(emitWire(local("e1start"))).toBe("$e1start")
      expect(spy).toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })

  it("a sub on an eid whose tail is a suffix word still round-trips", () => {
    const q = local("e3", "xy")
    expect(parseQuery(emitWire(q))).toEqual(q)
  })
})

// B1: a minted base64url bare id ending in a pure-word suffix must not break
// the write path. The kernel parser reads the deterministic split, emitWire
// emits the string verbatim, and the contextual knownIds readers resolve it as
// the WHOLE id (full-id membership wins; pinned in partDocToSketches.test.ts).
describe("minted bare id ending in a pure-word suffix (the production-risky shape)", () => {
  const eid = "k-g9YNviFC85Z-7Kxy"
  it("emits without throwing and keeps the kernel deterministic reading", () => {
    // This bare id emits with the expected dev/test warn; spy it out so the
    // test run output stays clean.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    try {
      expect(emitWire(local(eid))).toBe("$" + eid)
      expect(parseQuery("$" + eid)).toEqual(local("k-g9YNviFC85Z-7K", "xy"))
      expect(emitWire(parseQuery("$" + eid))).toBe("$" + eid)
    } finally {
      warnSpy.mockRestore()
    }
  })
})

// makeAncestryQuery([]) round-trips to zero ids.
describe("empty ancestry id list", () => {
  it("makeAncestryQuery([]) emits the parseable empty form ?0;", () => {
    expect(makeAncestryQuery([])).toBe("?0;")
    expect(emitWire(parseQuery(makeAncestryQuery([])))).toBe("?0;")
    expect(parseQuery(makeAncestryQuery([]))).toEqual(ancestry([], null, null))
  })

  it("empty id list with type/classifier suffix round-trips", () => {
    expect(emitWire(parseQuery("?0;:face"))).toBe("?0;:face")
    expect(parseQuery("?0;:face")).toEqual(ancestry([], "face", null))
    expect(parseQuery("?0;@inner")).toEqual(ancestry([], null, "inner"))
  })

  it("makeAncestryQuery refuses an empty string id (would silently become ?0;)", () => {
    expect(() => makeAncestryQuery([""])).toThrow()
    expect(() => emitWire(ancestry([""]))).toThrow()
  })
})

// Zero-length segments and unconsumed trailing data fail loud instead of
// dropping bytes silently.
describe("parseAncestry rejects malformed framing", () => {
  it('"?;" (old unparseable empty form) still throws; "?0;" is the canonical empty form', () => {
    expect(() => parseAncestry("?;")).toThrow()
  })

  it('"?0;abc" throws (no silent drop of "abc")', () => {
    expect(() => parseAncestry("?0;abc")).toThrow()
    expect(() => parseQuery("?0;abc")).toThrow()
  })

  it("zero-length segments mixed with real ids throw", () => {
    expect(() => parseAncestry("?0,2;@a")).toThrow()
    expect(() => parseAncestry("?2,0;@a")).toThrow()
  })

  it('unconsumed trailing data that is not a ":type" / "@cls" suffix throws', () => {
    expect(() => parseAncestry("?3;abcdef")).toThrow()
    expect(() => parseAncestry("?1;@a")).toThrow()
  })

  it("huge hex length fields fail the truncation check cleanly (no NaN)", () => {
    expect(() => parseAncestry("?ffffffffffffffff;abc")).toThrow(/truncated|needs|remain/)
  })

  it("a long id (multi-digit hex length) round-trips", () => {
    const longId = "@sk1/verylongentityname123"
    const wire = makeAncestryQuery([longId])
    expect(wire).toBe("?1a;@sk1/verylongentityname123")
    expect(emitWire(parseQuery(wire))).toBe(wire)
  })
})

// Absolute keys: the string repo.query @ path must agree with parseQuery
// (strict), so shapes the typed path cannot construct are rejected loudly.
describe("absolute query strictness", () => {
  it("parseQuery rejects empty parts and >3-part keys", () => {
    expect(() => parseQuery("@a/b/c/d")).toThrow(/Unrecognized absolute/)
    expect(() => parseQuery("@a//c")).toThrow(/Unrecognized absolute/)
    expect(() => parseQuery("@a/b/")).toThrow(/Unrecognized absolute/)
    expect(() => parseQuery("@/a")).toThrow(/Unrecognized absolute/)
    expect(() => parseQuery("@")).toThrow(/Unrecognized absolute/)
  })

  it("repo.query @ path routes through parseAbsolute and rejects the same shapes", () => {
    const repo = new Repository()
    repo.register("sk1/l1/start", { kind: "vertex" })
    repo.register("builtin_plane_front", { kind: "plane" })
    repo.register("sketch2line1", { kind: "line" })

    expect(repo.query("@sk1/l1/start")).toEqual({ kind: "vertex" })
    expect(repo.query("@builtin_plane_front")).toEqual({ kind: "plane" })
    expect(repo.query("@sketch2line1")).toEqual({ kind: "line" })

    expect(() => repo.query("@a/b/c/d")).toThrow()
    expect(() => repo.query("@a//c")).toThrow()
    expect(() => repo.query("@a/b/")).toThrow()
  })

  it("legacy concatenated @feat+eid resolves via the whole-tail featureId", () => {
    const repo = new Repository()
    repo.register("sketch2line1", { kind: "line" })
    expect(repo.query("@sketch2line1")).toEqual({ kind: "line" })
  })
})
