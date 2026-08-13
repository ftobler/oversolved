// repo-internal-hardening: two latent Repository defects plus a
// single-implementation guard.
//   1. canonical() joins ancestor ids on an unescaped NUL. Ids are internally
//      generated (feature ids, sketch entity ids, profile-query text,
//      construction uuids), none NUL-validated, so a NUL would silently merge
//      two DISTINCT ancestor sets into one ancestral key. It must fail loud in
//      test mode instead of merging.
//   2. gc() compared every @-tag to feature ids, so construction uuids (@u|),
//      classifiers (@cls_*), body tags (@body_*), geom-hash refs (@gface_ etc.)
//      and legacy descriptors (@gdf| etc.) counted as feature refs. Tags are
//      now classified before they are treated as feature references.
//   3. builder.ts derived its ancestry key by re-implementing the canonical
//      sorted-NUL-join inline, so a change to canonical() would silently desync
//      the two sites. It now calls canonical(); the source-scan below pins that.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  Repository,
  canonical,
  constructionUuidToken,
  isFeatureRefTag,
} from './query'
import { assertRepoIndicesConsistent, assertNoDeadUuidBuckets } from './repoIndexTestUtil'

describe('canonical NUL failLoud', () => {
  it("throws in test mode when an ancestor id contains the NUL separator", () => {
    // failLoud throws in test mode (dev-only warn elsewhere), so a NUL is a
    // loud bug signal instead of a silent key merge.
    expect(() => canonical(["a\u0000b", "c"])).toThrow(/NUL/)
  })

  it("still dedups and sorts as a frozenset key for NUL-free ids", () => {
    expect(canonical(["b", "a", "b"])).toBe(canonical(["a", "b"]))
    expect(canonical([])).toBe("")
  })
})

describe("gc tag classification", () => {
  it("keeps an entry whose only @-tags are construction uuid + body tags", () => {
    // A hypothetical uuid+body-only producer: @u| and @body_ tags carry no
    // feature reference. gc keys on feature activity, so it must keep the entry
    // while its body is registered (body liveness is registration eviction's
    // job, see index-shrink-ghost-eviction) instead of wrongly deleting it.
    const repo = new Repository()
    repo.registerAncestor(
      [constructionUuidToken("u_face"), "@body_b/face0", "@body_b"],
      { type: "flatface", body_id: "body_b" },
    )
    repo.gc(new Set())
    expect(repo.ancestral.size).toBe(1)
    assertRepoIndicesConsistent(repo)
  })

  it("keeps an entry whose only @-tags are a classifier", () => {
    const repo = new Repository()
    repo.registerAncestor(["@cls_zn", "@body_b"], { type: "flatface" })
    repo.gc(new Set())
    expect(repo.ancestral.size).toBe(1)
    assertRepoIndicesConsistent(repo)
  })

  it("keeps a tagless entry (builtin planes)", () => {
    const repo = new Repository()
    repo.registerAncestor(["builtin_front", "builtin_plane"], { type: "plane" })
    repo.gc(new Set())
    expect(repo.ancestral.size).toBe(1)
  })

  it("evicts a feature-tagged entry when its feature is inactive", () => {
    const repo = new Repository()
    repo.registerAncestor(
      [constructionUuidToken("u_face"), "@body_b", "@f1"],
      { type: "flatface", body_id: "body_b" },
      "u_face",
    )
    repo.gc(new Set())
    expect(repo.ancestral.size).toBe(0)
    assertNoDeadUuidBuckets(repo)
    assertRepoIndicesConsistent(repo)
  })

  it("keeps a feature-tagged entry when its feature is active", () => {
    const repo = new Repository()
    repo.registerAncestor(
      [constructionUuidToken("u_face"), "@body_b", "@f1"],
      { type: "flatface", body_id: "body_b" },
      "u_face",
    )
    repo.gc(new Set(["f1"]))
    expect(repo.ancestral.size).toBe(1)
    assertRepoIndicesConsistent(repo)
  })

  it("classifies the known non-feature tag families as not feature refs", () => {
    // Pins the classification table directly so a new tag family cannot drift
    // in silently: only a plain @<featureId> shape is a feature reference.
    // Sketch-entity profile-query ids like `@sk1/line1` are intentionally
    // classified feature-ref-shaped too: they are never feature ids and always
    // co-occur with a real `@<featureId>` ref, so they cannot pin an entry or
    // wrongly evict one.
    const nonFeature = [
      "@u|u_f38db052aaf9026c",
      "@cls_zn",
      "@body_b",
      "@body_b/face0",
      "@gface_abc123",
      "@gedge_abc123",
      "@gvertex_abc123",
      "@gnormal_abc123",
      "@gdf|0,0,0|0,0,1",
      "@gde|line|0,0,0|1,0,0|1",
      "@gdv|0,0,0",
    ]
    const feature = ["@extrude1", "@sketch1", "@ex1", "@import_step1", "@sk1/line1"]
    for (const t of nonFeature) expect(isFeatureRefTag(t)).toBe(false)
    for (const t of feature) expect(isFeatureRefTag(t)).toBe(true)
  })
})

describe("single-implementation canonical", () => {
  it("builder.ts derives its ancestry key from canonical(), never a second inline join", () => {
    // The dedup-skip in `_registerBrepFaceAncestry` used to re-implement the
    // canonical sorted-NUL-join inline. This is the headstone: if canonical()
    // ever changes (escaping, framing), the builder key must follow. The scan
    // matches `join(` with either quote style, so a reintroduced double-quoted
    // NUL escape cannot slip through.
    const src = readFileSync(join(__dirname, "builder.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(?:^|\s)\/\/[^\n]*/g, "")
    expect(src).not.toMatch(/join\(\s*['"](?:\\0|\\u0000)/)
    expect(src).toContain("canonical(ancestorIds)")
  })
})
