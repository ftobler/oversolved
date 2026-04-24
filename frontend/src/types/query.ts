export type LocalQuery    = { kind: "local";    eid: string; sub?: string }
export type AbsoluteQuery = { kind: "absolute"; featureId: string; eid?: string; sub?: string }
export type AncestryQuery = { kind: "ancestry"; ids: string[]; typeRestriction?: string; classifier?: string }
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
