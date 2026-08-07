/**
 * selectionId.ts -- stable selection identity contract
 *
 * All entries written into `normalSelection` are ancestral query strings or
 * `entity:`/`vertex:` IDs convertible to ancestral queries via `parseTarget`
 * (in yamlMutations/helpers.ts).  Raw topological indices (e.g. `/face/0`,
 * `/edge/3`) only appear here as a last-resort fallback when the backend has
 * not yet provided named face/edge queries; the consumer (parseTarget) treats
 * them correctly regardless.  No handler may store a bare integer index.
 */
import type { SelectionId, EntitySelectionId, VertexSelectionId, FaceSelectionId, EdgeSelectionId, PlaneSelectionId, ConstraintSelId } from "@/types/query"
import { parseQuery, emitWire } from "@/utils/query"
import type { Query } from "@/types/query"

export const sel = {
  entity:     (featureId: string, eid: string): EntitySelectionId =>
                ({ kind: "entity", featureId, eid }),
  vertex:     (featureId: string, eid: string, sub: string): VertexSelectionId =>
                ({ kind: "vertex", featureId, eid, sub }),
  face:       (featureId: string, query: string): FaceSelectionId =>
                ({ kind: "face", featureId, query }),
  edge:       (featureId: string, query: string): EdgeSelectionId =>
                ({ kind: "edge", featureId, query }),
  plane:      (featureId: string): PlaneSelectionId =>
                ({ kind: "plane", featureId }),
  constraint: (featureId: string, cid: string): ConstraintSelId =>
                ({ kind: "constraint", featureId, cid }),
}

/**
 * Produce an opaque stable string for use as a React key or Set member.
 *
 * Do NOT parse or inspect the returned string. It is opaque by design.
 * To get the query string for a face/edge selection, read .query directly.
 * To convert a SelectionId to a backend query, use selectionToQuery().
 */
export function selectionKey(s: SelectionId): string {
  switch (s.kind) {
    case "entity":     return `entity:${s.featureId}:${s.eid}`
    case "vertex":     return `vertex:${s.featureId}:${s.eid}:${s.sub}`
    case "face":       return `face:${s.featureId}:${s.query}`
    case "edge":       return `edge:${s.featureId}:${s.query}`
    case "plane":      return `@${s.featureId}`
    case "constraint": return `constraint:${s.featureId}:${s.cid}`
  }
}

export function parseSelectionId(s: string): SelectionId {
  if (s.startsWith("entity:"))     return _splitEntity(s)
  if (s.startsWith("vertex:"))     return _splitVertex(s)
  if (s.startsWith("face:"))       return _splitFace(s)
  if (s.startsWith("edge:"))       return _splitEdge(s)
  if (s.startsWith("constraint:")) return _splitConstraint(s)
  if (s.startsWith("@"))           return { kind: "plane", featureId: s.slice(1) }
  throw new Error(`Unrecognized selection ID: ${s}`)
}

/**
 * Convert a typed SelectionId to the backend query for the given host feature.
 *
 * emitWire() must be called by the caller when writing the result into a YAML doc.
 */
export function selectionToQuery(selection: SelectionId, hostFeatureId: string): Query {
  switch (selection.kind) {
    case "entity":
      return selection.featureId === hostFeatureId
        ? { kind: "local", eid: selection.eid }
        : { kind: "absolute", featureId: selection.featureId, eid: selection.eid }
    case "vertex":
      return selection.featureId === hostFeatureId
        ? { kind: "local", eid: selection.eid, sub: selection.sub }
        : { kind: "absolute", featureId: selection.featureId, eid: selection.eid, sub: selection.sub }
    case "face":
    case "edge":
      return parseQuery(selection.query)
    case "plane":
      return { kind: "absolute", featureId: selection.featureId }
    case "constraint":
      throw new Error("Constraints cannot be used as geometry targets")
  }
}

/**
 * Topological fallback query for a B-rep body element, used only when the
 * backend has not provided a named (ancestral) query. Last-resort identity --
 * see the module docstring. Centralized here so the `@<body>/<kind>/<idx>`
 * wire format lives in one place rather than scattered across render code.
 *
 * The leading token is a BODY id, not a feature id: one feature owns N bodies
 * (kernel/features/bodySplit.ts), and the index is per body, so keying on the
 * creating feature made `body_ex1` and `body_ex1_1` mint the same query for two
 * different edges. The kernel's real query minting is body-scoped for the same
 * reason (kernel/faceQuery.ts, occ/tessellation.ts push `ref(bodyId)`).
 */
export function topoFallbackQuery(
  bodyId: string,
  kind: "edge" | "face" | "vertex",
  idx: number,
): string {
  return `@${bodyId}/${kind}/${idx}`
}

function _splitEntity(s: string): EntitySelectionId {
  const [, featureId, eid] = s.split(":")
  return { kind: "entity", featureId, eid }
}

function _splitVertex(s: string): VertexSelectionId {
  const parts = s.split(":")
  return { kind: "vertex", featureId: parts[1], eid: parts[2], sub: parts[3] }
}

function _splitFace(s: string): FaceSelectionId {
  // face:<featureId>:<query> -- query may itself contain ':'
  const colon = s.indexOf(":", "face:".length)
  return { kind: "face", featureId: s.slice("face:".length, colon), query: s.slice(colon + 1) }
}

function _splitEdge(s: string): EdgeSelectionId {
  const colon = s.indexOf(":", "edge:".length)
  return { kind: "edge", featureId: s.slice("edge:".length, colon), query: s.slice(colon + 1) }
}

function _splitConstraint(s: string): ConstraintSelId {
  const [, featureId, cid] = s.split(":")
  return { kind: "constraint", featureId, cid }
}

/**
 * Emit an always-absolute backend query from a raw selection ID string.
 *
 * Used where there is no host concept (e.g. PlaneEditor picking).
 * Never emits `$` local form. face/edge inner queries are passed through
 * verbatim rather than re-serialized. The `@` / `$` wire format for entity
 * and vertex selections is produced by the engine (selectionToQuery + emitWire).
 */
export function emitAbsoluteSelectionQuery(selectionId: string): string {
  if (selectionId.startsWith('face:')) {
    return selectionId.split(':').slice(2).join(':')
  }
  if (selectionId.startsWith('vertex:') || selectionId.startsWith('entity:')) {
    const sel = parseSelectionId(selectionId)
    return emitWire(selectionToQuery(sel, ''))
  }
  return selectionId
}

/**
 * True when `id` is a whole-body selection (the parts-list `@<bodyId>` form with
 * no trailing primitive path). Body-primitive picks (`@<bodyId>/face/N`, a
 * `face:` wrapper, a `?` ancestry query) name geometry, not the body, so they
 * must NOT match. Measurement and projection accept body primitives but not a
 * whole body, and the Delete key routes a body pick to delete_body, so every
 * consumer shares this one classification.
 */
export function isWholeBodySelectionId(id: string): boolean {
  return id.startsWith('@body_') && !id.includes('/')
}

/**
 * Parse a topo-fallback query string (`@<bodyId>/<kind>/<idx>`)
 * back into its components. The inverse of topoFallbackQuery().
 * Returns null if the string is not a valid topo-fallback query.
 */
export function parseTopoFallbackQuery(query: string): { bodyId: string; kind: 'edge' | 'face' | 'vertex'; idx: number } | null {
  if (!query.startsWith('@')) return null
  const slash1 = query.indexOf('/', 1)
  const slash2 = query.indexOf('/', slash1 + 1)
  if (slash1 < 0 || slash2 < 0) return null
  const bodyId = query.slice(1, slash1)
  const kind = query.slice(slash1 + 1, slash2)
  const idx = parseInt(query.slice(slash2 + 1), 10)
  if ((kind !== 'edge' && kind !== 'face' && kind !== 'vertex') || isNaN(idx)) return null
  return { bodyId, kind: kind as 'edge' | 'face' | 'vertex', idx }
}
