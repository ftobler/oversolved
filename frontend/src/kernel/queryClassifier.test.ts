// Split from query.test.ts; see the original section markers for context.

import { describe, it, expect } from "vitest"
import {
  isGeomHashId,
  isClassifierId,
  makeAncestryQuery,
  canonical,
  constructionUuidToken,
  Repository,
  AmbiguousQueryError,
} from "./query"
import { repoFromSnapshot } from "./builder"
import { type Payload, makeFacePayload } from "./queryTestUtils"

describe("face registration structural tags", () => {
  it("face registration key has at least 3 structural tags", () => {
    const repo = new Repository()

    // Register faces with the standard 3-tag pattern + optional profile tokens
    repo.registerAncestor(
      ["@body1/face0", "@ex1", "@body1"],
      makeFacePayload("body1", "ex1", 0),
    )
    repo.registerAncestor(
      ["@body1/face1", "@ex1", "@body1", "@sk1/profileA"],
      makeFacePayload("body1", "ex1", 1),
    )
    repo.registerAncestor(
      ["@body2/face0", "@ex2", "@body2"],
      makeFacePayload("body2", "ex2", 0),
    )

    // Filter to face registrations, keys whose set contains a /face positional tag
    let foundFace = false
    for (const entry of repo.ancestral.values()) {
      const hasFaceTag = [...entry.set].some(
        (tag) =>
          typeof tag === "string" && tag.includes("/face") && tag.startsWith("@"),
      )
      if (hasFaceTag) {
        foundFace = true
        // At minimum: @body_id/faceN, @feature_id, @body_id (+ optional profile tokens)
        expect(entry.set.size).toBeGreaterThanOrEqual(3)
      }
    }
    expect(foundFace).toBe(true)
  })

  /** No geom_hash tag appears in the ancestral key Set of any face registration.
   *  This is a structural invariant: uuids live in byUuid only. */
  it("no geom_hash tag in face registration ancestral key", () => {
    const repo = new Repository()
    repo.registerAncestor(
      ["@body1/face0", "@ex1", "@body1"],
      makeFacePayload("body1", "ex1", 0),
      "gface_abc",
    )

    for (const entry of repo.ancestral.values()) {
      for (const tag of entry.set) {
        expect(isGeomHashId(tag)).toBe(false)
      }
    }

    expect(repo.byUuid.has("gface_abc")).toBe(true)
  })
})

/** Tests for the geometric-classifier predicate functions mirroring
 *  Python's TestClassifierTokenPredicate. */

describe("geometric classifier predicates", () => {
  it("recognises @cls_ prefix", () => {
    expect(isClassifierId("@cls_zp")).toBe(true)
    expect(isClassifierId("@cls_xn")).toBe(true)
  })

  it("rejects non-classifier ids", () => {
    expect(isClassifierId("@gface_abc")).toBe(false)
    expect(isClassifierId("@ex1")).toBe(false)
    expect(isClassifierId("@sk1/left")).toBe(false)
  })

  it("classifier is not a geom hash (partitions are disjoint)", () => {
    expect(isGeomHashId("@cls_zp")).toBe(false)
  })
})

/**
 * Spatial classifier tokens survive edits, resolve gracefully against contradictory input, and
 * stay consistent between query emission and element registration.
 */

describe("classifier tier resolution", () => {
  it("UUID resolves even with contradictory classifiers", () => {
    const repo = new Repository()
    const payloadP = { ...makeFacePayload("body1", "ex1", 0), classifiers: ["cls_zp"] }
    const payloadN = { ...makeFacePayload("body1", "ex1", 1), classifiers: ["cls_zn"] }
    repo.registerAncestor(["@body1/face0", "@ex1", "@body1"], payloadP, "u_aaa")
    repo.registerAncestor(["@body1/face1", "@ex1", "@body1"], payloadN, "u_bbb")

    // @cls_zp resolves the +Z cap via UUID + classifier.
    const r1 = repo.query(makeAncestryQuery([constructionUuidToken("u_aaa"), "@cls_zp", "@ex1", "@body1"]))
    expect(r1).not.toBeNull()
    expect((r1 as Payload).classifiers).toEqual(["cls_zp"])

    // Contradictory classifiers don't prevent the UUID tier from resolving.
    const contradictory = makeAncestryQuery([constructionUuidToken("u_aaa"), "@cls_zp", "@cls_zn", "@ex1", "@body1"])
    const r2 = repo.query(contradictory)
    expect(r2).not.toBeNull()
    expect((r2 as Payload).classifiers).toEqual(["cls_zp"])
  })

  /** Single source of truth: the @cls_* tokens on a query match the bare
   *  classifier list registered on the element it resolves to. */
  it("classifier on resolved element matches the query tokens", () => {
    const repo = new Repository()
    const payload = { ...makeFacePayload("body1", "ex1", 0), classifiers: ["cls_xp", "cls_yp"] }
    repo.registerAncestor(["@body1/face0", "@ex1", "@body1"], payload, "gface_abc")

    const result = repo.query(makeAncestryQuery(["@cls_xp", "@cls_yp", "@gface_abc", "@ex1", "@body1"]))
    expect(result).not.toBeNull()
    const cls = (result as Payload).classifiers as string[]
    expect(cls).toEqual(["cls_xp", "cls_yp"])
  })

  it("split surfaces resolve by line-division classifier without index", () => {
    /** Two half-disks share ancestry {circ, cut}. Stripped of the positional
     *  surface:N index, they resolve only via the stable line-division classifier
     *  token ("cls_ld_<eid>_p" / "cls_ld_<eid>_n"). Dropping the classifier too
     *  produces an ancestral tie -> AmbiguousQueryError. */
    const repo = new Repository()
    const payloadP = { ...makeFacePayload("body1", "ex1", 0), classifiers: ["cls_ld_cut_p"] }
    const payloadN = { ...makeFacePayload("body1", "ex1", 1), classifiers: ["cls_ld_cut_n"] }

    // Register two surfaces with surface:N index for disambiguation.
    const anc0 = ["@sk1/circ", "@sk1/cut", "surface:0", "@ex1", "@body1"]
    const anc1 = ["@sk1/circ", "@sk1/cut", "surface:1", "@ex1", "@body1"]
    repo.registerAncestor(anc0, payloadP, "gface_aaa")
    repo.registerAncestor(anc1, payloadN, "gface_bbb")

    // With surface:N -> resolves (the positional index disambiguates).
    const qIndexed = makeAncestryQuery(["@sk1/circ", "@sk1/cut", "surface:0", "@ex1", "@body1"])
    expect(repo.query(qIndexed)).not.toBeNull()

    // Without index + without classifier -> ambiguous (ancestral tie).
    const qBare = makeAncestryQuery(["@sk1/circ", "@sk1/cut", "@ex1", "@body1"])
    try {
      repo.query(qBare)
      expect.fail("Should have raised AmbiguousQueryError for tied ancestors")
    } catch (e) {
      expect(e instanceof AmbiguousQueryError).toBe(true)
    }

    // With line-division classifier -> resolves via classifier tier.
    const qCls = makeAncestryQuery(["@sk1/circ", "@sk1/cut", "@cls_ld_cut_p", "@ex1", "@body1"])
    const resolved = repo.query(qCls)
    expect(resolved).not.toBeNull()
    expect((resolved as Payload).classifiers).toEqual(["cls_ld_cut_p"])
  })

  it("stale geom hash resolves via classifier after rebuild (edit-survival)", () => {
    /** The value proposition: a query captured from a short build carries
     *  a @gface_ hash. After a taller rebuild, that hash is stale (the
     *  rebuilt face has a different geometry due to the new dimensions).
     *  The @cls_ classifier, which is edit-stable, still discriminates the
     *  correct face among ancestral siblings in the new repo. */

    // Short build: two sibling faces with different classifiers.
    const shortRepo = new Repository()
    const pZp = { ...makeFacePayload("body1", "ex1", 0), classifiers: ["cls_zp"] }
    const pZn = { ...makeFacePayload("body1", "ex1", 1), classifiers: ["cls_zn"] }
    shortRepo.registerAncestor(["@ex1", "@body1", "surface:0"], pZp, "gface_short_zp")
    shortRepo.registerAncestor(["@ex1", "@body1", "surface:1"], pZn, "gface_short_zn")

    // Capture the +Z cap query from the short build.
    const captured = makeAncestryQuery(["@gface_short_zp", "@cls_zp", "@ex1", "@body1"])
    expect(shortRepo.query(captured)).not.toBeNull()

    // Tall build: same faces, same classifiers, DIFFERENT hashes.
    const tallRepo = new Repository()
    const tZp = { ...makeFacePayload("body1", "ex1", 0), classifiers: ["cls_zp"] }
    const tZn = { ...makeFacePayload("body1", "ex1", 1), classifiers: ["cls_zn"] }
    tallRepo.registerAncestor(["@ex1", "@body1", "surface:0"], tZp, "gface_tall_zp")
    tallRepo.registerAncestor(["@ex1", "@body1", "surface:1"], tZn, "gface_tall_zn")

    // The stale hash alone is ambiguous: both faces share the ancestry and
    // the hash matches neither, so the resolver raises rather than silently
    // picking one. Asserted directly, matching the tied-ancestor case above.
    const staleOnly = makeAncestryQuery(["@gface_short_zp", "@ex1", "@body1"])
    expect(() => tallRepo.query(staleOnly)).toThrow(AmbiguousQueryError)
    expect(() => tallRepo.query(staleOnly)).toThrow(/matched 2/)

    // The captured query (stale hash + @cls_zp classifier) resolves
    // to the +Z cap in the tall build via the classifier tier.
    const resolved = tallRepo.query(captured)
    expect(resolved).not.toBeNull()
    expect((resolved as Payload).classifiers).toEqual(["cls_zp"])
  })
})

/** Classifier veto semantics (classifier-disambiguation-hardening).
 *
 * A wanted @cls_* set matching no candidate is a VETO, not a silent pass: the
 * classifier tier is the only tier that kept the original candidate list when
 * the narrowing came up empty, so a lone subset candidate carrying
 * contradictory classifiers resolved wrong geometry and a multi-candidate set
 * "degraded to ambiguous" only by accident. The descriptor tier and the fillet
 * re-verify both refuse on mismatch; the classifier tier now does too. */

describe("classifier veto semantics", () => {
  it("a single subset candidate carrying contradictory classifiers misses instead of resolving", () => {
    const repo = new Repository()
    repo.registerAncestor(
      ["@ex1", "@body1"],
      { ...makeFacePayload("body1", "ex1", 0), classifiers: ["cls_zn"] },
    )
    const q = makeAncestryQuery(["@ex1", "@body1", "@cls_zp"])
    expect(repo.query(q)).toBeNull()
    expect(repo._lastTier).toBe("miss")
  })

  it("a single subset candidate carrying the wanted classifier still resolves", () => {
    const repo = new Repository()
    repo.registerAncestor(
      ["@ex1", "@body1"],
      { ...makeFacePayload("body1", "ex1", 0), classifiers: ["cls_zp"] },
    )
    const q = makeAncestryQuery(["@ex1", "@body1", "@cls_zp"])
    const result = repo.query(q)
    expect(result).not.toBeNull()
    expect((result as Payload).classifiers).toEqual(["cls_zp"])
    expect(repo._lastTier).toBe("ancestral")
  })

  it("a multi-candidate subset with a total classifier veto misses instead of resolving a wrong face", () => {
    const repo = new Repository()
    repo.registerAncestor(
      ["@ex1", "@body1", "surface:0"],
      { ...makeFacePayload("body1", "ex1", 0), classifiers: ["cls_zn"] },
    )
    repo.registerAncestor(
      ["@ex1", "@body1", "surface:1"],
      { ...makeFacePayload("body1", "ex1", 1), classifiers: ["cls_zn"] },
    )
    // Neither candidate carries the wanted cls_zp and both carry NON-EMPTY
    // contradictory evidence: the classifier veto empties the set, so the query
    // misses exactly like queryAll enumerates []. This is deliberately stronger
    // than the old behaviour (the set survived and threw AmbiguousQueryError at
    // the final multiplicity check), and it must NOT let the descriptor tier
    // shrink the set to a wrong winner.
    const q = makeAncestryQuery(["@ex1", "@body1", "@cls_zp"])
    expect(repo.query(q)).toBeNull()
    expect(repo._lastTier).toBe("miss")
  })

  it("an element with no classifier evidence (empty payload) is not vetoed", () => {
    // `classifiers: []` is NO evidence, not a contradiction: classifiers are
    // world-frame best-effort and a rotated body's tokens can legitimately
    // collapse to none, so the lone candidate resolves as it did before the
    // veto (the pre-existing empty OCC-B-rep edge payload asymmetry, see
    // knowledgebase). Only a non-empty payload lacking a wanted token vetoes.
    const repo = new Repository()
    repo.registerAncestor(
      ["@ex1", "@body1"],
      { ...makeFacePayload("body1", "ex1", 0), classifiers: [] },
    )
    const q = makeAncestryQuery(["@ex1", "@body1", "@cls_zp"])
    const result = repo.query(q)
    expect(result).not.toBeNull()
    expect((result as Payload).classifiers).toEqual([])
    expect(repo._lastTier).toBe("ancestral")
  })

  it("a positive classifier match outranks a no-evidence sibling", () => {
    // A no-evidence candidate must not dilute the narrowing into a false
    // ambiguity: when one sibling carries the wanted cls_zp and another
    // carries [] (e.g. an edge near the body centre, or the empty OCC-B-rep
    // edge payload), the classifier resolves the positive match.
    const repo = new Repository()
    repo.registerAncestor(
      ["@ex1", "@body1", "surface:0"],
      { ...makeFacePayload("body1", "ex1", 0), classifiers: ["cls_zp"] },
    )
    repo.registerAncestor(
      ["@ex1", "@body1", "surface:1"],
      { ...makeFacePayload("body1", "ex1", 1), classifiers: [] },
    )
    const q = makeAncestryQuery(["@ex1", "@body1", "@cls_zp"])
    const result = repo.query(q)
    expect(result).not.toBeNull()
    expect((result as Payload).classifiers).toEqual(["cls_zp"])
    expect(repo._lastTier).toBe("ancestral")
  })

  it("a no-evidence sibling resolves over a contradicting sibling instead of a false ambiguity", () => {
    // A MIXED set: one sibling carries non-empty CONTRADICTING evidence
    // (cls_zn) and the other carries [] (no evidence). The classifier cannot
    // disambiguate by a positive match, but the no-evidence sibling is the
    // only non-contradicted candidate and must resolve, where keeping the
    // full set pre-feature would have thrown AmbiguousQueryError (the B1 fix).
    const repo = new Repository()
    repo.registerAncestor(
      ["@ex1", "@body1", "surface:0"],
      { ...makeFacePayload("body1", "ex1", 0), classifiers: ["cls_zn"] },
    )
    repo.registerAncestor(
      ["@ex1", "@body1", "surface:1"],
      { ...makeFacePayload("body1", "ex1", 1), classifiers: [] },
    )
    const q = makeAncestryQuery(["@ex1", "@body1", "@cls_zp"])
    const result = repo.query(q)
    expect(result).not.toBeNull()
    expect((result as Payload).classifiers).toEqual([])
    expect(repo._lastTier).toBe("ancestral")
  })

  it("the ancestral-partial tier filters classifiers before its single-hit return", () => {
    const repo = new Repository()
    repo.registerAncestor(
      ["@A"],
      { ...makeFacePayload("body1", "ex1", 0), classifiers: ["cls_zn"] },
    )
    // query_set {@A, @extra} is not a subset of the registered {@A}, so the
    // exact tier misses; the partial tier sees one candidate carrying cls_zn.
    // A wanted cls_zp must veto it (miss), not resolve it as ancestral-partial.
    const wrong = makeAncestryQuery(["@A", "@extra", "@cls_zp"])
    expect(repo.query(wrong)).toBeNull()
    expect(repo._lastTier).toBe("miss")

    // The matching classifier still resolves through the partial tier.
    const right = makeAncestryQuery(["@A", "@extra", "@cls_zn"])
    const result = repo.query(right)
    expect(result).not.toBeNull()
    expect((result as Payload).classifiers).toEqual(["cls_zn"])
    expect(repo._lastTier).toBe("ancestral-partial")
  })

  it("a multi-candidate classifier veto is not re-bypassed by legacy descriptor tokens", () => {
    // Two sibling caps share the ancestry tokens and BOTH carry NON-EMPTY
    // contradictory evidence (cls_zn against the wanted cls_zp). The legacy
    // descriptor token names the surface:0 face tightly, so the descriptor tier
    // (and, after the veto empties the set, the descriptor-only fallback) would
    // each pick a wrong face. The veto must win either way.
    const repo = new Repository()
    repo.registerAncestor(
      ["@ex1", "@body1", "surface:0"],
      { ...makeFacePayload("body1", "ex1", 0), classifiers: ["cls_zn"] },
    )
    repo.registerAncestor(
      ["@ex1", "@body1", "surface:1"],
      { ...makeFacePayload("body1", "ex1", 1), classifiers: ["cls_zn"] },
    )
    const q = makeAncestryQuery(["@gdf|0,0,0|0,0,1", "@ex1", "@body1", "@cls_zp"])
    expect(repo.query(q)).toBeNull()
    expect(repo._lastTier).toBe("miss")
  })

  it("the descriptor-only fallback cannot resolve a vetoed contradictory candidate either", () => {
    // Same veto, but the candidates share EXACTLY the query's non-hash tokens:
    // after the veto empties the subset set, the ancestral-partial tier sees
    // them again (and narrows them to []), and the descriptor-only fallback
    // then tight-matches the surface:0 face over the WHOLE repo with no
    // classifier re-check. It must stay a miss.
    const repo = new Repository()
    repo.registerAncestor(
      ["@ex1", "@body1"],
      { ...makeFacePayload("body1", "ex1", 0), classifiers: ["cls_zn"] },
    )
    repo.registerAncestor(
      ["@ex1", "@body1"],
      { ...makeFacePayload("body1", "ex1", 1), classifiers: ["cls_zn"] },
    )
    const q = makeAncestryQuery(["@gdf|0,0,0|0,0,1", "@ex1", "@body1", "@cls_zp"])
    expect(repo.query(q)).toBeNull()
    expect(repo._lastTier).toBe("miss")
  })

  it("a positive classifier match outranks a legacy descriptor token", () => {
    const repo = new Repository()
    repo.registerAncestor(
      ["@ex1", "@body1", "surface:0"],
      { ...makeFacePayload("body1", "ex1", 0), classifiers: ["cls_zn"] },
    )
    repo.registerAncestor(
      ["@ex1", "@body1", "surface:1"],
      { ...makeFacePayload("body1", "ex1", 1), classifiers: ["cls_zp"] },
    )
    // The descriptor names the cls_zn face (centroid [0,0,0]) but the wanted
    // cls_zp is real positive evidence on the other sibling and must outrank it.
    const q = makeAncestryQuery(["@gdf|0,0,0|0,0,1", "@ex1", "@body1", "@cls_zp"])
    const result = repo.query(q)
    expect(result).not.toBeNull()
    expect((result as Payload).classifiers).toEqual(["cls_zp"])
    expect(repo._lastTier).toBe("ancestral")
  })

  it("a partial classifier overlap is positive evidence, not a contradiction", () => {
    // The wanted set {xp, yp} snapshots an earlier geometry; the +Y sibling lost
    // its cls_xp when the model moved it. Its cls_yp is partial positive
    // evidence, so the veto must NOT fire and the sibling resolves (the
    // persisted plane-on-face rescue, pickIdentityCorpus).
    const repo = new Repository()
    repo.registerAncestor(
      ["@ex1", "@body1", "surface:0"],
      { ...makeFacePayload("body1", "ex1", 0), classifiers: ["cls_yn"] },
    )
    repo.registerAncestor(
      ["@ex1", "@body1", "surface:1"],
      { ...makeFacePayload("body1", "ex1", 1), classifiers: ["cls_yp"] },
    )
    const q = makeAncestryQuery(["@gdf|0,0,0|0,0,1", "@ex1", "@body1", "@cls_xp", "@cls_yp"])
    const result = repo.query(q)
    expect(result).not.toBeNull()
    expect((result as Payload).classifiers).toEqual(["cls_yp"])
    expect(repo._lastTier).toBe("ancestral")
  })

  it("queryAll enumerates the partial-overlap sibling, matching the resolver", () => {
    const repo = new Repository()
    repo.registerAncestor(
      ["@ex1", "@body1", "surface:0"],
      { ...makeFacePayload("body1", "ex1", 0), classifiers: ["cls_yn"] },
    )
    repo.registerAncestor(
      ["@ex1", "@body1", "surface:1"],
      { ...makeFacePayload("body1", "ex1", 1), classifiers: ["cls_yp"] },
    )
    // Same fixture as the resolver pin above: queryAll must enumerate exactly
    // the partial-overlap sibling, not the zero-overlap one and not the empty
    // whole set.
    const q = makeAncestryQuery(["@gdf|0,0,0|0,0,1", "@ex1", "@body1", "@cls_xp", "@cls_yp"])
    const results = repo.queryAll(q) as Payload[]
    expect(results.length).toBe(1)
    expect(results[0].classifiers).toEqual(["cls_yp"])
  })

  it("partial positive evidence outranks a no-evidence sibling in both resolver and queryAll", () => {
    const repo = new Repository()
    repo.registerAncestor(
      ["@ex1", "@body1", "surface:0"],
      { ...makeFacePayload("body1", "ex1", 0), classifiers: ["cls_xp"] },
    )
    repo.registerAncestor(
      ["@ex1", "@body1", "surface:1"],
      { ...makeFacePayload("body1", "ex1", 1), classifiers: [] },
    )
    // The cls_xp sibling shares a wanted token and is positive evidence; the []
    // payload is no evidence. Per the documented priority the partial match
    // must outrank the no-evidence sibling in both the resolver and queryAll,
    // or the tier order is wrong.
    const q = makeAncestryQuery(["@ex1", "@body1", "@cls_xp", "@cls_yp"])
    const result = repo.query(q)
    expect(result).not.toBeNull()
    expect((result as Payload).classifiers).toEqual(["cls_xp"])
    expect(repo._lastTier).toBe("ancestral")
    const results = repo.queryAll(q) as Payload[]
    expect(results.length).toBe(1)
    expect(results[0].classifiers).toEqual(["cls_xp"])
  })

  it("the resolver veto and queryAll enumeration agree on a contradictory multi-candidate set", () => {
    const repo = new Repository()
    repo.registerAncestor(
      ["@ex1", "@body1", "surface:0"],
      { ...makeFacePayload("body1", "ex1", 0), classifiers: ["cls_zn"] },
    )
    repo.registerAncestor(
      ["@ex1", "@body1", "surface:1"],
      { ...makeFacePayload("body1", "ex1", 1), classifiers: ["cls_zn"] },
    )
    const q = makeAncestryQuery(["@gdf|0,0,0|0,0,1", "@ex1", "@body1", "@cls_zp"])
    expect(repo.query(q)).toBeNull()
    expect(repo.queryAll(q)).toEqual([])
  })
})


describe("restored snapshot with a non-array classifiers payload", () => {
  it("resolves without throwing when the classifier payload is not an array", () => {
    // A snapshot-restored repo is the untrusted route: an element whose
    // `classifiers` field is not an array (a string, number, object) must be
    // treated as NO evidence inside narrowByClassifier, never throw TypeError.
    // A sibling with real matching evidence outranks it; without the guard the
    // whole narrow would crash before reaching that ranking.
    const snapshot = {
      elements: {
        el0: { type: "flatface", classifiers: 42 },
        el1: { type: "flatface", classifiers: ["cls_zp"] },
      },
      ancestral: {
        [canonical(["@ex1", "@body1"])]: { set: ["@ex1", "@body1"], eids: ["el0", "el1"] },
      },
      byUuid: {},
    }
    const repo = repoFromSnapshot(snapshot)
    const q = makeAncestryQuery(["@ex1", "@body1", "@cls_zp"])
    expect(() => repo.query(q)).not.toThrow()
    expect(repo.query(q)).toBe(repo.elements.get("el1"))
    expect(() => repo.queryAll(q)).not.toThrow()
    expect(repo.queryAll(q)).toEqual([repo.elements.get("el1")])
  })
})

/** World-frame best-effort classifier contract (classifier-disambiguation-hardening).
 *
 * Classifiers are minted against the world-frame AABB, so a rotated body's
 * side faces can collapse to empty or contradictory token sets (see
 * geomHash.test.ts). The construction `@u|` UUID is the PRIMARY tier: a query
 * naming the uuid resolves the element regardless of what its classifiers look
 * like, so the collapse only ever weakens the stale-uuid fallback, never the
 * primary identity. */

describe("world-frame best-effort classifier contract", () => {
  it("a rotated body's face resolves via its @u| uuid even when classifiers collapse to empty", () => {
    const repo = new Repository()
    // The world-frame AABB of a rotated square prism mints no classifier for
    // some side faces (the collapse); the uuid tier must still resolve it.
    const collapsed = { ...makeFacePayload("body1", "ex1", 0), classifiers: [] }
    repo.registerAncestor(["@body1/face0", "@ex1", "@body1"], collapsed, "u_rot")
    const q = makeAncestryQuery([constructionUuidToken("u_rot"), "@cls_zp", "@ex1", "@body1"])
    const result = repo.query(q)
    expect(result).not.toBeNull()
    expect((result as Payload).classifiers).toEqual([])
    expect(repo._lastTier).toBe("uuid")
  })
})

