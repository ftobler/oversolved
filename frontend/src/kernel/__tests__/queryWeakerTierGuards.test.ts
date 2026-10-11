// Weaker-tier guards of the ancestry resolver: a dead construction uuid never
// recovers a differently-named element, the partial tier honors subtypes, and
// queryAll narrows by classifier before the type block exactly like query().

import { describe, it, expect } from "vitest"
import { Repository, makeAncestryQuery, constructionUuidToken } from "../query"

type Payload = Record<string, unknown>

/** A cap face of body_1 made by ex1, registered like builderAncestry does. */
function regFace(repo: Repository, idx: number, classifiers: string[], uuid: string | null): string {
  return repo.registerAncestor(
    [`@body_1/face${idx}`, "@ex1", "@body_1", "@sk1/p"],
    { type: "flatface", body_id: "body_1", created_by: "ex1", face_index: idx, classifiers },
    uuid,
  )
}

const topCapQuery = makeAncestryQuery(
  [constructionUuidToken("u_top"), "@ex1", "@body_1", "@sk1/p", "@cls_zp"],
  "flatface",
)

describe("dead construction uuid: no swap to a differently-named sibling", () => {
  it("a sibling with its own uuid and no classifier evidence is not resolved in the dead face's place", () => {
    const repo = new Repository()
    const top = regFace(repo, 0, ["cls_zp"], "u_top")
    regFace(repo, 1, ["cls_zn"], "u_bottom")
    expect((repo.query(topCapQuery) as Payload).face_index).toBe(0)
    expect(repo._lastTier).toBe("uuid")

    // The top cap dies (a later split replaced it) and a face with no z
    // classifier evidence appears under the same ancestral net. Before the fix
    // it won the classifier tier's no-evidence fallback and resolved silently.
    repo.deleteElement(top)
    repo.prunePendingUuids()
    regFace(repo, 2, [], "u_split_child")
    expect(repo.query(topCapQuery)).toBeNull()
    expect(repo._lastTier).toBe("miss")
  })

  it("a lone differently-named sibling is a miss, while an unnamed one still recovers", () => {
    const named = new Repository()
    regFace(named, 1, [], "u_other")
    expect(named.query(topCapQuery)).toBeNull()

    // A pre-uuid registration carries no contrary evidence: recovery stays.
    const unnamed = new Repository()
    regFace(unnamed, 1, [], null)
    expect((unnamed.query(topCapQuery) as Payload).face_index).toBe(1)
    expect(unnamed._lastTier).toBe("ancestral")
  })

  it("the ancestral-partial tier cannot return a differently-named element", () => {
    const repo = new Repository()
    repo.registerAncestor(["@ex1"], { type: "flatface", created_by: "ex1" }, "u_other")
    const q = makeAncestryQuery([constructionUuidToken("u_gone"), "@ex1", "@extra"], "flatface")
    expect(repo.query(q)).toBeNull()
    expect(repo._lastTier).toBe("miss")
  })

  it("the coerce sibling scan cannot return a differently-named element", () => {
    function build(edgeUuid: string | null): Repository {
      const repo = new Repository()
      // The face is the only subset candidate; the edge is reachable only
      // through the coerce scan (it shares @ex1 but not @body_1).
      repo.registerAncestor(["@ex1", "@body_1", "@body_1/face0"], {
        type: "flatface", body_id: "body_1", created_by: "ex1",
      })
      repo.registerAncestor(["@ex1", "@body_1/edge0"], {
        type: "straightedge", body_id: "body_1", created_by: "ex1", tag: "edge",
      }, edgeUuid)
      return repo
    }
    const q = makeAncestryQuery([constructionUuidToken("u_gone"), "@ex1", "@body_1"], "straightedge")
    expect((build(null).query(q) as Payload).tag).toBe("edge")
    expect(build("u_other").query(q)).toBeNull()
  })

  it("the exclusion survives a snapshot restore (elementUuid is rebuilt)", () => {
    const repo = new Repository()
    regFace(repo, 1, [], "u_other")
    repo.elementUuid = new Map()
    repo.rebuildIndices()
    expect(repo.query(topCapQuery)).toBeNull()
  })

  it("queryAll enumerates unnamed siblings of a dead uuid but never differently-named ones", () => {
    const repo = new Repository()
    regFace(repo, 1, [], "u_other")
    regFace(repo, 2, [], null)
    const q = makeAncestryQuery([constructionUuidToken("u_gone"), "@ex1", "@body_1"], "flatface")
    const out = repo.queryAll(q) as Payload[]
    expect(out.map(p => p.face_index)).toEqual([2])
  })
})

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

  it("an entry with no ancestors never answers an unrelated miss", () => {
    // It is trivially a subset of every query set; before the fix a lone one
    // resolved any miss of a matching type as "ancestral-partial".
    const repo = new Repository()
    repo.registerAncestor([], { type: "flatface", tag: "orphan" })
    expect(repo.query(makeAncestryQuery(["@gone1", "@gone2"], "flatface"))).toBeNull()
    expect(repo._lastTier).toBe("miss")
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
