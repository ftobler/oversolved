import { describe, it, expect, beforeEach } from "vitest"
import scenarios from "./occ/__fixtures__/queryScenarios.json"
import {
  Repository,
  AmbiguousQueryError,
  initGlobalRepo,
  evictAncestryAndRegister,
  setCurrentFeatureId,
  parseQuery,
  emitWire,
  parseAncestry,
  makeAncestryQuery,
  local,
  absolute,
  ancestry,
  ref,
  bodyIdOf,
} from "./query"

type Op = Record<string, unknown>
type Query = Record<string, unknown>
type Scenario = {
  name: string
  init_builtin?: boolean
  feature_order?: string[] | null
  context_feature_id?: string
  ops?: Op[]
  queries: Query[]
}

function applyOp(repo: Repository, op: Op): void {
  switch (op.op) {
    case "register":
      repo.register(op.id as string, op.obj)
      break
    case "register_ancestor":
      repo.registerAncestor(op.ancestors as string[], op.obj, (op.geom_hash as string) ?? null)
      break
    case "evict_register":
      evictAncestryAndRegister(
        repo,
        op.ancestors as string[],
        op.obj as Record<string, unknown>,
        (op.index_tag as string) ?? null,
        (op.geom_hash as string) ?? null,
      )
      break
    case "gc":
      repo.gc(new Set(op.active_fids as string[]))
      break
    case "clear_sketch":
      repo.clearBySketchId(op.sketch_id as string)
      break
    default:
      throw new Error(`unknown op ${op.op}`)
  }
}

describe("query resolver parity (replay Python scenarios)", () => {
  beforeEach(() => setCurrentFeatureId(null))

  for (const scn of scenarios as Scenario[]) {
    it(scn.name, () => {
      const repo = scn.init_builtin ? initGlobalRepo() : new Repository()
      if (scn.feature_order != null) repo.setFeatureOrder(scn.feature_order)
      if (scn.context_feature_id !== undefined) setCurrentFeatureId(scn.context_feature_id)
      try {
        for (const op of scn.ops ?? []) applyOp(repo, op)
        for (const q of scn.queries) {
          const queryStr = q.query as string
          if (q.kind === "query_all") {
            const results = repo.queryAll(queryStr, (q.current_feature_id as string) ?? null)
            expect(results).toEqual(q.results)
            continue
          }
          if ("error" in q) {
            expect(() =>
              repo.query(
                queryStr,
                (q.context as string) ?? null,
                (q.body_store as Record<string, unknown>) ?? null,
                (q.current_feature_id as string) ?? null,
              ),
            ).toThrow(AmbiguousQueryError)
            continue
          }
          const result = repo.query(
            queryStr,
            (q.context as string) ?? null,
            (q.body_store as Record<string, unknown>) ?? null,
            (q.current_feature_id as string) ?? null,
          )
          expect(result ?? null).toEqual(q.result ?? null)
        }
      } finally {
        setCurrentFeatureId(null)
      }
    })
  }
})

describe("parse/emit round-trips", () => {
  it("local with subpoint", () => {
    expect(parseQuery("$e3start")).toEqual(local("e3", "start"))
    expect(parseQuery("$e3")).toEqual(local("e3"))
    // alpha char before suffix means it is part of the eid, not a subpoint
    expect(parseQuery("$mystart")).toEqual(local("mystart"))
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

  it("makeAncestryQuery keeps empty type restriction; emitWire drops it", () => {
    expect(makeAncestryQuery(["@a"], "")).toBe("?2;@a:")
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
    expect(bodyIdOf(wire)).toBe("body_ex1edge0")
    expect(bodyIdOf("?1;@a")).toBeNull()
  })
})
