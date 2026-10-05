// solver_features_shared.py is the central machinery the leaf feature solvers
// (extrude/revolve/boolean/fillet/...) call into. This directory splits that
// surface by concern; each leaf imports the specific module it needs:
//
// - bodyRef: profile/surface reference parsing.
// - profileLoops: profile-loop assembly and its diagnostics.
// - topFace: top-face registration after an extrude.
// - directionQuery: direction resolution and 3D direction/axis queries.
// - bodyResolution: body and merge-target resolution.
// - brepDiff: BrepDiff predicates.
// - planes: plane math. Python distinguishes a Frame3D object from a plain
//   plane dict via isinstance, but the two branches compute identical
//   geometry; in TS both satisfy [[PlaneLike]], so the branch collapses.
//
// All of this is pure logic with no OCC. The OCC-backed lineage
// (_apply_body_operation + _transfer_boolean_lineage + _resolve_face_profile)
// lives in bodyOps.ts, booleanLineage.ts and faceProfile.ts.

export * from './bodyRef'
export * from './profileLoops'
export * from './topFace'
export * from './directionQuery'
export * from './bodyResolution'
export * from './brepDiff'
export * from './planes'
