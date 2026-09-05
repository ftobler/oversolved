// The ancestry resolver narrows its candidate scan through the `byAncestorId`
// reverse index instead of walking all of `ancestral` (the same narrowing
// `evictAncestryAndRegister` already does). Two things must hold: the narrowing
// is EXACT (identical resolutions, identical queryAll order, versus the full
// scan it replaces), and it actually happens (a resolving query never iterates
// the whole map).

import { describe, it, expect, vi } from "vitest"
import { AmbiguousQueryError, Repository, makeAncestryQuery } from "./query"

// A small pool so entries collide on tags: collisions are what makes the
// "rarest id" choice non-trivial and produce genuine ambiguity cases.
const TAG_POOL = [
  "@f0", "@f1", "@f2", "@body_0", "@body_1",
  "@t0", "@t1", "@t2", "@t3", "@t4", "@t5", "@t6",
]

/** Deterministic LCG, so a parity failure is reproducible from the seed. */
function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0x100000000
  }
}

function corpusRepo(n: number, seed: number): { repo: Repository; idSets: string[][] } {
  const rnd = lcg(seed)
  const repo = new Repository()
  const idSets: string[][] = []
  for (let i = 0; i < n; i++) {
    const ids = new Set<string>()
    const k = 2 + Math.floor(rnd() * 3)
    while (ids.size < k) ids.add(TAG_POOL[Math.floor(rnd() * TAG_POOL.length)])
    const list = [...ids]
    // No created_by/sketch_id: the ordering guard treats these as built-ins, so
    // the parity check isolates the ancestral scan itself.
    repo.registerAncestor(list, { type: "flatface", n: i })
    idSets.push(list)
  }
  return { repo, idSets }
}

/** The query shapes probed per entry: its own full id set plus one random
 *  non-empty subset of it, so every probe has at least one match by construction
 *  and the ancestral-partial fallback never masks a narrowing miss. */
function probesFor(ids: string[], rnd: () => number): string[][] {
  const subset = ids.filter(() => rnd() < 0.6)
  return subset.length ? [ids, subset] : [ids]
}

/** What the pre-narrowing scan produced: the live eids of every entry whose
 *  ancestor set contains the whole query set, in `ancestral` insertion order. */
function fullScanCandidates(repo: Repository, queryIds: string[]): string[] {
  const want = new Set(queryIds)
  const out: string[] = []
  for (const entry of repo.ancestral.values()) {
    let contains = true
    for (const id of want) {
      if (!entry.set.has(id)) {
        contains = false
        break
      }
    }
    if (!contains) continue
    for (const eid of entry.eids) if (repo.elements.has(eid)) out.push(eid)
  }
  return out
}

/** What a full scan of the ancestral-partial tier produces: the live eids of
 *  every entry whose ancestor set is a SUBSET of the query set (the reverse
 *  direction from `fullScanCandidates`), in `ancestral` insertion order. */
function fullScanPartialCandidates(repo: Repository, queryIds: string[]): string[] {
  const want = new Set(queryIds)
  const out: string[] = []
  for (const entry of repo.ancestral.values()) {
    let sub = true
    for (const id of entry.set) {
      if (!want.has(id)) {
        sub = false
        break
      }
    }
    if (!sub) continue
    for (const eid of entry.eids) if (repo.elements.has(eid)) out.push(eid)
  }
  return out
}

describe("reverse-index narrowing of the ancestry resolver", () => {
  it("resolves exactly what a full ancestral scan resolves", () => {
    const { repo, idSets } = corpusRepo(120, 7)
    const rnd = lcg(11)
    let resolved = 0
    let ambiguous = 0

    for (const ids of idSets) {
      for (const q of probesFor(ids, rnd)) {
        const expected = fullScanCandidates(repo, q)
        const queryStr = makeAncestryQuery(q)
        if (expected.length === 1) {
          expect(repo.query(queryStr)).toBe(repo.elements.get(expected[0]))
          resolved++
        } else {
          expect(() => repo.query(queryStr)).toThrow(AmbiguousQueryError)
          ambiguous++
        }
      }
    }

    // Both outcomes must occur, or the parity claim is vacuous.
    expect(resolved).toBeGreaterThan(0)
    expect(ambiguous).toBeGreaterThan(0)
  })

  it("enumerates queryAll in full-scan order", () => {
    // Order is the part a reverse index could silently change: a key enters
    // `byAncestorId` in the same pass that puts its entry in `ancestral`, so the
    // narrowed walk stays a subsequence of the full walk. Payloads carry a unique
    // `n`, so a permuted result fails this comparison.
    const { repo, idSets } = corpusRepo(80, 23)
    const rnd = lcg(5)
    let enumeratedMulti = 0

    for (const ids of idSets) {
      for (const q of probesFor(ids, rnd)) {
        const expected = fullScanCandidates(repo, q).map(eid => repo.elements.get(eid))
        expect(repo.queryAll(makeAncestryQuery(q))).toEqual(expected)
        if (expected.length > 1) enumeratedMulti++
      }
    }

    expect(enumeratedMulti).toBeGreaterThan(0)
  })

  it("does not walk the whole ancestral map to resolve", () => {
    const { repo } = corpusRepo(50, 3)
    const rare = "@body_9/face0"
    repo.registerAncestor([rare, "@f0"], { type: "flatface", n: -1 })
    const scan = vi.spyOn(repo.ancestral, "values")

    const el = repo.query(makeAncestryQuery([rare, "@f0"]))

    expect(el).toMatchObject({ n: -1 })
    expect(scan).not.toHaveBeenCalled()
    scan.mockRestore()
  })

  it("misses without a scan when a query id was never registered", () => {
    const { repo } = corpusRepo(30, 13)
    const scan = vi.spyOn(repo.ancestral, "values")

    // Unknown id: no entry can contain the whole set, so the subset tier is
    // skipped outright. The ancestral-partial fallback still scans (it tests the
    // opposite direction), so only the subset tier is asserted here.
    expect(repo.queryAll(makeAncestryQuery(["@nope", "@f0"]))).toEqual([])

    expect(scan).not.toHaveBeenCalled()
    scan.mockRestore()
  })

  it("indexed ancestral-partial candidates match a full scan, with empty-set entries and order", () => {
    // The ancestral-partial tier used to scan all of `ancestral` testing
    // `entry.set <= querySet` (the reverse direction). The indexed replacement
    // must return the same live eids in the same `ancestral` insertion order.
    const { repo, idSets } = corpusRepo(80, 29)
    // Empty-set entries are subsets of every query set but are indexed under no
    // id, so only the explicit empty-set branch of the index can find them.
    repo.registerAncestor([], { type: "flatface", n: 9000 })
    repo.registerAncestor([], { type: "flatface", n: 9001 })
    const emptyEids = new Set(
      [...repo.ancestral.values()].flatMap(e => (e.set.size === 0 ? e.eids : [])),
    )

    const rnd = lcg(19)
    let partialMatched = 0
    let emptySeen = false
    for (const ids of idSets) {
      // Probe a superset of the entry's own ids plus two random pool members, so
      // every probe has the entry (and the empty-set entries) as partial matches
      // by construction, and a real partial match is exercised each time.
      const extra = new Set(ids)
      extra.add(TAG_POOL[Math.floor(rnd() * TAG_POOL.length)])
      extra.add(TAG_POOL[Math.floor(rnd() * TAG_POOL.length)])
      const probe = [...extra]
      const got = repo.partialEntryEids(new Set(probe))
      expect(got).toEqual(fullScanPartialCandidates(repo, probe))
      for (const eid of got) if (emptyEids.has(eid)) emptySeen = true
      partialMatched++
    }

    // Both claims must actually hold: partial matches occur, and the empty-set
    // entries are found by the index.
    expect(partialMatched).toBeGreaterThan(0)
    expect(emptySeen).toBe(true)
  })
})
