// Decorate the structural topology emitted by the Rust/WASM area builder
// (`detect_topology_bytes`) with the ancestry query strings and line-division
// classifiers that stay on the TypeScript side of the split. Rust owns the
// geometry; `query.ts` and the classifiers stay here because 21 other modules
// depend on the exact query strings byte-for-byte.
//
// The Rust output carries two decoration hints this module consumes and strips:
//   - per edge:    `edge_type` ("straightedge" | "edge")
//   - per surface: `face_entity_ids` (source entity ids, pre-emitWire/pre-sort)
// Everything else (geometry, vertex ids, indices) is already final.

import { makeAncestryQuery, emitWire, absolute, parseAncestry } from "./query"
import { loopCentroid } from "./profileLoops"
import { validateSketchArea } from "./profileDiagnostics"

const EPS = 1e-9

type Pt = number[]
type Geom = Record<string, unknown>

/** The decorated area-builder output. */
export interface TopologyDict {
  intersection_points: Record<string, { x: number; y: number }>
  vertices: Record<string, { x: number; y: number }>
  edges: Record<string, unknown>[]
  surfaces: Record<string, unknown>[]
}

/** Bytes-in/bytes-out shape of the Rust `detect_topology_bytes` entry point. */
export type TopologyBytes = (input: Uint8Array) => Uint8Array

/** The structural JSON the Rust kernel returns (no query strings yet). */
interface StructuralTopology {
  intersection_points: Record<string, { x: number; y: number }>
  vertices: Record<string, { x: number; y: number }>
  edges: Record<string, unknown>[]
  surfaces: Record<string, unknown>[]
}

// ─── line-division classifiers (TS-side) ───

function lineSideTokens(surface: Record<string, unknown>): string[] {
  const boundary = (surface["boundary"] as Record<string, unknown>[]) ?? []
  const centroid = loopCentroid(boundary)
  const cx = centroid[0]
  const cy = centroid[1]
  const tokens = new Set<string>()
  for (const e of boundary) {
    if (e["kind"] !== "line") continue
    const eid = e["id"] as string | null | undefined
    const s = e["start"] as Pt | undefined
    const en = e["end"] as Pt | undefined
    if (!eid || !s || !en) continue
    const ends: [number, number][] = [
      [s[0], s[1]],
      [en[0], en[1]],
    ].sort((a, b) => (a[0] !== b[0] ? a[0] - b[0] : a[1] - b[1])) as [number, number][]
    const [x1, y1] = ends[0]
    const [x2, y2] = ends[1]
    const cross = (x2 - x1) * (cy - y1) - (y2 - y1) * (cx - x1)
    if (Math.abs(cross) < EPS) continue
    tokens.add("cls_ld_" + eid + (cross > 0 ? "_p" : "_n"))
  }
  return [...tokens].sort()
}

function attachLineDivisionClassifiers(surfaces: Record<string, unknown>[]): void {
  const groups = new Map<string, Record<string, unknown>[]>()
  for (const s of surfaces) {
    const q = (s["query"] as string) ?? ""
    if (!q.startsWith("?")) continue
    const [ids] = parseAncestry(q)
    const keyIds = ids.filter((i) => i.startsWith("@") && i.includes("/"))
    const key = [...new Set(keyIds)].sort().join(" ")
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(s)
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue
    for (const s of group) {
      const tokens = lineSideTokens(s)
      if (!tokens.length) continue
      s["classifiers"] = tokens
      const [ids, t] = parseAncestry(s["query"] as string)
      s["query"] = makeAncestryQuery([...ids, ...tokens.map((tok) => "@" + tok)], t)
    }
  }
}

// ─── decoration ───

/**
 * Attach ancestry query strings + classifiers to the Rust structural topology,
 * producing the same `TopologyDict` the TS `detectTopology` returns.
 */
export function decorateTopology(structural: StructuralTopology, featureId: string): TopologyDict {
  const edges = structural.edges.map((e) => {
    const edgeType = (e["edge_type"] as string) ?? "edge"
    const entityId = e["entity_id"] as string
    const edgeIndex = e["edge_index"] as number
    const ancestorIds = [emitWire(absolute(featureId, entityId)), `edge:${edgeIndex}`, emitWire(absolute(featureId))]
    const query = makeAncestryQuery(ancestorIds, edgeType)
    const out: Geom = { query }
    for (const [k, v] of Object.entries(e)) {
      if (k === "edge_type") continue  // decoration hint, not part of the dict
      out[k] = v
    }
    return out
  })

  const surfaces = structural.surfaces.map((s, idx) => {
    const faceEntityIds = (s["face_entity_ids"] as string[]) ?? []
    const absIds = faceEntityIds.map((eid) => emitWire(absolute(featureId, eid))).sort()
    const ids = [...absIds, `surface:${idx}`, emitWire(absolute(featureId))]
    const query = makeAncestryQuery(ids, "flatface")
    const out: Geom = {}
    for (const [k, v] of Object.entries(s)) {
      if (k === "face_entity_ids") continue  // decoration hint, stripped
      out[k] = v
    }
    out["query"] = query
    return out
  })

  // Line-side classifiers run after the base queries.
  attachLineDivisionClassifiers(surfaces)

  return {
    intersection_points: structural.intersection_points,
    vertices: structural.vertices,
    edges,
    surfaces,
  }
}

/**
 * Stamp each surface with whether it can actually become a profile, before
 * anything advertises it. The viewport fills every surface and the picker offers
 * every surface, so an area the loop chainer will drop reads to the user as
 * extrudable right up to the moment the feature goes red.
 *
 * Kept OUT of `decorateTopology` on purpose: that function is pinned
 * byte-for-byte against the frozen Python-parity golden (occ/__fixtures__/
 * topology.json, key-exact), so a new TS-side decoration key belongs in its own
 * pass on the way to the feature result. Cheap and conservative -- it runs in
 * the solver worker where OCC is not loaded, so `buildable: true` means "nothing
 * here is provably wrong", never "the kernel will accept it".
 *
 * Pure: returns a new dict, surfaces copied.
 */
export function stampAreaBuildability(topology: TopologyDict): TopologyDict {
  return {
    ...topology,
    surfaces: topology.surfaces.map((s) => {
      const validation = validateSketchArea(s)
      const out: Geom = { ...s, buildable: validation.buildable }
      // Both are stamped: the prose is what a human reads in the feature error,
      // the code is what survives being persisted in `_topo_<fid>` and reworded
      // prose later.
      if (validation.reason !== undefined) out["reason"] = validation.reason
      if (validation.reasonCode !== undefined) out["reason_code"] = validation.reasonCode
      return out
    }),
  }
}

/**
 * Identity unification for lazy inferred materialization. The area
 * builder classifies only curves -- point entities are dropped (`classify` in
 * `dcel.rs`) -- so it rederives a curve-curve crossing every solve with no idea a
 * real `point` now owns that contact. Once a point is materialized there, the
 * topology must lean on that point's identity instead of re-emitting an ephemeral
 * positional intersection vertex. This drops every `intersection_points` entry
 * that coincides with a materialized point, so all downstream consumers (snap/pick
 * markers, the topology-vertex registration in `postRegister`, the SVG overlay)
 * resolve the contact through the stable point entity, not a transient `_vN`.
 *
 * Pure; the inferred crossing simply yields to the real point. Edges/surfaces are
 * untouched -- they are already built in Rust; `intersection_points` is only the
 * rendered/snappable vertex list.
 */
export function reconcileMaterializedContacts(
  topology: TopologyDict,
  pointPositions: ReadonlyArray<readonly [number, number]>,
  tol = 1e-3,
): TopologyDict {
  if (pointPositions.length === 0) return topology
  const kept: Record<string, { x: number; y: number }> = {}
  for (const [vid, pt] of Object.entries(topology.intersection_points)) {
    const owned = pointPositions.some(p => Math.hypot(p[0] - pt.x, p[1] - pt.y) < tol)
    if (!owned) kept[vid] = pt
  }
  return { ...topology, intersection_points: kept }
}

/** Serialize richGeom as the ordered `[[eid, geom], ...]` payload Rust expects. */
function encodeTopologyInput(richGeom: Record<string, Record<string, unknown>>): Uint8Array {
  const entries = Object.entries(richGeom)
  return new TextEncoder().encode(JSON.stringify(entries))
}

/**
 * Run the Rust area builder over `richGeom` and decorate the result. The area
 * builder lives entirely in Rust/WASM now; `topologyBytes` must be wired (browser
 * via `initSketchSolver`, node harness via `setSketchTopology`). It is only null
 * on a fresh checkout with no `just wasm` build, where `solveSketch` already
 * throws on the missing solver before reaching here.
 */
export function solveTopology(
  richGeom: Record<string, Record<string, unknown>>,
  featureId: string,
  topologyBytes: TopologyBytes | null,
): TopologyDict {
  if (!topologyBytes) {
    throw new Error("topology: Rust area builder not initialised (run `just wasm`)")
  }
  const outBytes = topologyBytes(encodeTopologyInput(richGeom))
  const structural = JSON.parse(new TextDecoder().decode(outBytes)) as StructuralTopology
  return decorateTopology(structural, featureId)
}
