// Canonical typed-query shapes for the `?/@/$` wire format. The serialization
// (emitWire/parseQuery) lives in kernel/query.ts and is re-exported by
// utils/query; these types are the shared contract so both surfaces agree.
export type LocalQuery    = { kind: "local";    eid: string; sub?: string }
export type AbsoluteQuery = { kind: "absolute"; featureId: string; eid?: string; sub?: string }
export type AncestryQuery = { kind: "ancestry"; ancestorIds: string[]; typeRestriction: string | null; classifier?: string | null }
export type Query = LocalQuery | AbsoluteQuery | AncestryQuery

export type EntitySelectionId  = { kind: "entity";     featureId: string; eid: string }
export type VertexSelectionId  = { kind: "vertex";     featureId: string; eid: string; sub: string }
export type FaceSelectionId    = { kind: "face";       featureId: string; query: string }
export type EdgeSelectionId    = { kind: "edge";       featureId: string; query: string }
export type PlaneSelectionId   = { kind: "plane";      featureId: string }
export type ConstraintSelId    = { kind: "constraint"; featureId: string; cid: string }
export type SelectionId =
  | EntitySelectionId | VertexSelectionId | FaceSelectionId
  | EdgeSelectionId   | PlaneSelectionId  | ConstraintSelId
