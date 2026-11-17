import type { PartDoc, Mutation, SelectorRef } from '@/types/cad'
import { isFaceProjectionSource } from '@/kernel/features/projectionMembers'
import type { FaceBoundaryLookup } from '@/kernel/features/faceBoundary'
import {
  applyMoveVertex,
  applyMoveEntity,
  applyResizeCircle,
  applyAddConstraint,
  applyDeleteElements,
  applyAddEntity,
  applyImportDxf,
  applyAddText,
  applyInsertFitPoint,
  applySetFitSplineHandle,
  applyAddEntityWithConstraint,
  applyAddProjectedEntity,
  applyAddRect,
  applyAddCenterRect,
  applyAddNgon,
  applyAddThreePointArc,
  applyAddOffset,
  applyMirrorEntities,
  applyFilletCorners,
  applyPatternEntities,
  applySetConstraintValue,
  applySetConstraintPos,
  applySetConstraintSign,
  applyToggleConstruction,
  applySetFeaturePlane,
  applyAddSketch,
  applyDeleteFeature,
  applySetFeatureVisibility,
  applyRenameFeature,
  applyAddPlane,
  applySetPlaneDefinitionField,
  applyTogglePlaneVisibility,
  applyToggleSketchPlaneVisibility,
  applyAddExtrude,
  applySetExtrudeField,
  applyAddExtrudeProfile,
  applyRemoveExtrudeProfile,
  applyAddRevolve,
  applySetRevolveField,
  applyAddRevolveProfile,
  applyRemoveRevolveProfile,
  applyAddWrap,
  applySetWrapField,
  applyAddSweep,
  applySetSweepField,
  applyAddSweepProfile,
  applyRemoveSweepProfile,
  applyAddSweepPath,
  applyRemoveSweepPath,
  applyAddImportStep,
  applyAddFillet,
  applyAddChamfer,
  applySetFilletField,
  applySetChamferField,
  applyAddFilletEdge,
  applyRemoveFilletEdge,
  applyAddChamferEdge,
  applyRemoveChamferEdge,
  applyAddShell,
  applySetShellField,
  applyAddShellFace,
  applyRemoveShellFace,
  applyAddMoveFace,
  applySetMoveFaceField,
  applyAddMoveFaceRef,
  applyRemoveMoveFaceRef,
  applyAddDeleteFace,
  applyAddDeleteFaceRef,
  applyRemoveDeleteFaceRef,
  applyAddBoolean,
  applySetBooleanField,
  applyAddBooleanTool,
  applyRemoveBooleanTool,
  applyAddLinearPattern,
  applySetLinearPatternField,
  applyAddCircularPattern,
  applySetCircularPatternField,
  applyAddCurvePattern,
  applySetCurvePatternField,
  applyAddCurvePatternPath,
  applyRemoveCurvePatternPath,
  applyAddInstancePattern,
  applySetInstancePatternField,
  applyAddInstancePatternTarget,
  applyRemoveInstancePatternTarget,
  applyAddPattern,
  applyAddPatternSource,
  applyRemovePatternSource,
  applyAddDeletePart,
  applyAddDeletePartRef,
  applyRemoveDeletePartRef,
  applyAddHole,
  applySetHoleField,
  applyAddTransform,
  applySetTransformField,
  applyAddTransformPart,
  applyRemoveTransformPart,
  applyRenamePart,
  applySetPartColor,
  applySetPartTransparency,
  applySetPartMetalness,
  applySetPartRoughness,
  applySetPartTransmission,
  applyReorderFeatures,
  applyMoveFeatureBefore,
  reorderAnchorIndex,
  applyReorderPickField,
  applyAddMirror,
  applySetMirrorField,
  applyAddMirrorSource,
  applyRemoveMirrorSource,
  applyAddSplit,
  applySetSplitField,
  applyAddSplitPart,
  applyRemoveSplitPart,
  applyAddVariable,
  applySetVariableField,
  applyAddHelix,
  applySetHelixField,
  applySetPartVisibility,
  applySetFeatureSuppression,
  applySetLengthUnit,
} from '@/utils/yamlMutations'
import { applyRemoveDanglingContent } from '@/utils/yamlMutations/solveResult'
import { applyFreezeProjection } from '@/utils/yamlMutations/freezeProjection'
import { MutationRefusal } from '@/utils/yamlMutations/helpers'

type MutationHandlers = {
  [K in Mutation['type']]: (
    doc: PartDoc,
    m: Extract<Mutation, { type: K }>,
    ctx?: MutationContext,
  ) => Mutation | void
}

/** The settled-solve answer a host injects for a projection source that is not
 *  a document row: a body edge/vertex/face query. The headless drive builds it
 *  from the last solved repository; the UI's picks come from that same scene. */
export type ProjectionResolveCheck = (
  source: string,
  featureId: string,
) => { ok: true } | { ok: false; reason: string }

/** What an applier may read besides the document: right now only a face's
 *  current boundary, which the session injects from the last solved bodies so a
 *  face projection's member ids can be derived at add time, and the settled
 *  source check that refuses a projection that would never resolve. */
export interface MutationContext {
  projectionBoundary?: FaceBoundaryLookup
  projectionResolves?: ProjectionResolveCheck
}

// A pick field that also accepts a selector aid. The headless drive resolves a
// selector into the query string before the mutation reaches an applier, and
// the boundary refuses one that did not resolve, so only the stored string form
// lands here. A selector arriving anyway came through an internal caller that
// bypassed both gates (DocSession.execute, or journal replay with
// allowInternal), so it is loud instead of silently dropped.
const UNRESOLVED_PICK =
  'a {selector} pick reached the applier unresolved; the drive resolves it before the step runs'
const resolvedQuery = (value: string | SelectorRef | undefined): string | undefined => {
  if (value === undefined || typeof value === 'string') return value
  throw new Error(UNRESOLVED_PICK)
}
const resolvedQueries = (value: (string | SelectorRef)[] | undefined): string[] | undefined =>
  value?.map((entry) => {
    if (typeof entry === 'string') return entry
    throw new Error(UNRESOLVED_PICK)
  })

// The drive fills a projection's omitted kind from the element its selector
// matched, so the applier always receives the pair. This fires both for a
// missing kind on a string source (the author must name one) and for a caller
// that skipped both gates with a selector.
const UNRESOLVED_PROJECTION_KIND =
  'add_projected_entity reached the applier without a kind; a string source must name one, '
  + 'and the drive fills it only from a {selector} source it resolved'

function sameMemberMap(a: Record<string, string>, b: Record<string, string>): boolean {
  const aKeys = Object.keys(a)
  const bKeys = Object.keys(b)
  return aKeys.length === bKeys.length && aKeys.every(key => b[key] === a[key])
}

export const mutationHandlers: MutationHandlers = {
  move_vertex: (next, m) =>
    applyMoveVertex(next, m.featureId, m.entityId, m.vertexKey, m.to, m.solvedGeometry),
  move_vertex_with_constraint: (next, m) => {
    applyMoveVertex(next, m.featureId, m.entityId, m.vertexKey, m.to, m.solvedGeometry)
    const draggedRef = `vertex:${m.featureId}:${m.entityId}:${m.vertexKey}`
    const snapRef = m.snapVertexId ?? m.snapEntityRef
    if (snapRef) {
      applyAddConstraint(next, m.featureId, m.constraintKind, [draggedRef, snapRef])
    }
  },
  move_entity: (next, m) =>
    applyMoveEntity(next, m.featureId, m.entityId, m.delta, m.solvedGeometry),
  resize_circle: (next, m) =>
    applyResizeCircle(next, m.featureId, m.entityId, m.radius, m.solvedGeometry),
  add_constraint: (next, m) =>
    applyAddConstraint(next, m.featureId, m.kind, m.targets, m.value, m.pos, m.sign),
  set_constraint_value: (next, m) =>
    applySetConstraintValue(next, m.featureId, m.constraintId, m.value),
  set_constraint_pos: (next, m) =>
    applySetConstraintPos(next, m.featureId, m.constraintId, m.pos),
  set_constraint_sign: (next, m) =>
    applySetConstraintSign(next, m.featureId, m.constraintId, m.sign),
  delete: (next, m) => {
    // The downstream-projection note is computed by the host before the apply
    // (the rows are gone afterwards); the applier's report is for direct tests.
    applyDeleteElements(next, m.targets, m.materialize)
  },
  freeze_projection: (next, m) =>
    applyFreezeProjection(next, m.featureId, m.target, m.mode, m.materialize),
  add_entity: (next, m) =>
    applyAddEntity(next, m.featureId, m.kind, m.params, m.entityId, {
      tangents: m.tangents, tangentScale: m.tangentScale,
    }, m.dimensions),
  import_dxf: (next, m) =>
    // The headless runner resolves a `file` id into `content` before the
    // session sees it; the empty fallback keeps a direct caller on the
    // applier's own loud parse refusal.
    applyImportDxf(next, m.featureId, m.content ?? '', m.layers, m.group),
  add_text: (next, m) =>
    applyAddText(next, m.featureId, m),
  add_entity_with_constraint: (next, m) =>
    applyAddEntityWithConstraint(next, m.featureId, m.kind, m.params, m.vertexKey, m.snapVertexId, m.constraintKind, m.snapEntityRef, m.entityId, {
      tangents: m.tangents, tangentScale: m.tangentScale,
    }),
  insert_fit_point: (next, m) =>
    applyInsertFitPoint(next, m.featureId, m.entityId, m.index, m.point),
  set_fit_spline_handle: (next, m) =>
    applySetFitSplineHandle(next, m.featureId, m.entityId, m.end, m.handle),
  add_projected_entity: (next, m, ctx) => {
    const source = resolvedQuery(m.source)
    if (source === undefined) throw new Error(UNRESOLVED_PICK)
    // A face source has no single kind: it derives members instead. Every other
    // source still needs the pick-time kind (the drive fills it from a selector).
    if (m.kind === undefined && !isFaceProjectionSource(source)) throw new Error(UNRESOLVED_PROJECTION_KIND)
    // A projection that has never resolved is a state the document must never
    // be given: a body source resolves only against the settled solve, so the
    // host answers before the applier stores the row. A source the document can
    // already judge (a sketch ref, a $ chain) is refused inside the applier.
    if (!isFaceProjectionSource(source) && ctx?.projectionResolves !== undefined) {
      const resolved = ctx.projectionResolves(source, m.featureId)
      if (!resolved.ok) throw new MutationRefusal(resolved.reason)
    }
    const derived = applyAddProjectedEntity(next, m.featureId, m.kind ?? '', source, m.entityId, m.constraintId, {
      faceBoundary: ctx?.projectionBoundary,
      members: m.members,
      excluded: m.excluded,
    })
    // A face add derives its member ids and constraint id here; handing the
    // enriched mutation back lets the session journal it without editing the
    // caller's object. The recorded id is what keeps a replay's derivation off a
    // collision with rows a freeze left behind. A supplied map the applier
    // replaced with the real one is rewritten too, so a bad step cannot leave a
    // document the loader would refuse.
    if (derived !== undefined && (
      m.constraintId !== derived.constraintId
      || m.members === undefined
      || !sameMemberMap(m.members, derived.members)
    )) {
      return { ...m, constraintId: derived.constraintId, members: derived.members }
    }
  },
  add_rect: (next, m) =>
    applyAddRect(next, m.featureId, m.p0, m.p1, m.p0Ref, m.p1Ref, m.entityIds, m.dimensions),
  add_center_rect: (next, m) =>
    applyAddCenterRect(next, m.featureId, m.center, m.corner, m.centerRef, m.cornerRef, m.entityIds, m.dimensions),
  add_ngon: (next, m) =>
    applyAddNgon(next, m.featureId, m.center, m.corner, m.sides, m.cornerRef, m.centerRef, m.entityIds, m.dimensions),
  add_three_point_arc: (next, m) =>
    applyAddThreePointArc(next, m.featureId, m.start, m.through, m.end, m.startRef, m.endRef, m.entityId),
  apply_offset: (next, m) =>
    applyAddOffset(next, m.featureId, m.sourceIds, m.distance),
  mirror_entities: (next, m) =>
    applyMirrorEntities(next, m.featureId, m.sourceIds, m.line),
  fillet_corners: (next, m) =>
    applyFilletCorners(next, m.featureId, m.radius, m.corners),
  pattern_entities: (next, m) =>
    applyPatternEntities(next, m),
  toggle_construction: (next, m) =>
    applyToggleConstruction(next, m.targets),
  set_feature_plane: (next, m) => {
    const plane = resolvedQuery(m.plane)
    if (plane === undefined) throw new Error('set_feature_plane needs a plane')
    applySetFeaturePlane(next, m.featureId, plane)
  },
  add_sketch: (next, m) =>
    applyAddSketch(next, m.featureId, m.label, resolvedQuery(m.plane)),
  delete_feature: (next, m) =>
    applyDeleteFeature(next, m.featureId),
  set_feature_visibility: (next, m) =>
    applySetFeatureVisibility(next, m.featureId, m.visible),
  add_plane: (next, m) => {
    applyAddPlane(next, m.featureId, m.label, m.definition as Record<string, unknown> | undefined)
    // `before` inserts the new plane directly above a feature, the one-step
    // fix for a sketch that names a plane defined after it.
    if (m.before !== undefined) applyMoveFeatureBefore(next, m.featureId, m.before)
  },
  set_plane_definition_field: (next, m) =>
    applySetPlaneDefinitionField(next, m.featureId, m.field, m.value),
  rename_feature: (next, m) =>
    applyRenameFeature(next, m.featureId, m.label),
  toggle_sketch_plane_visibility: (next) =>
    applyToggleSketchPlaneVisibility(next),
  toggle_plane_visibility: (next) =>
    applyTogglePlaneVisibility(next),
  add_extrude: (next, m) =>
    applyAddExtrude(next, m.featureId, m.label, m.sketchQuery, m.distance, {
      taper: m.taper,
      twist: m.twist,
      direction: m.direction,
      termination: m.termination,
      up_to: m.up_to,
      up_to_offset: m.up_to_offset,
      up_to_start: m.up_to_start,
      operation: m.operation,
      merge_target: m.merge_target,
    }),
  set_extrude_field: (next, m) =>
    applySetExtrudeField(next, m.featureId, m.field, m.value),
  add_extrude_profile: (next, m) =>
    applyAddExtrudeProfile(next, m.featureId, m.sketchQuery),
  remove_extrude_profile: (next, m) =>
    applyRemoveExtrudeProfile(next, m.featureId, m.index),
  add_revolve: (next, m) => {
    const { type: _type, featureId, label, insertAt: _insertAt, sketchQuery, angle, axis, ...inline } = m
    applyAddRevolve(next, featureId, label, sketchQuery, angle, axis, inline)
  },
  set_revolve_field: (next, m) =>
    applySetRevolveField(next, m.featureId, m.field, m.value),
  add_revolve_profile: (next, m) =>
    applyAddRevolveProfile(next, m.featureId, m.sketchQuery),
  remove_revolve_profile: (next, m) =>
    applyRemoveRevolveProfile(next, m.featureId, m.index),
  add_wrap: (next, m) => {
    const { type: _type, featureId, label, insertAt: _insertAt, sketchQuery, ...inline } = m
    applyAddWrap(next, featureId, label, sketchQuery, inline)
  },
  set_wrap_field: (next, m) =>
    applySetWrapField(next, m.featureId, m.field, m.value),
  add_sweep: (next, m) => {
    const { type: _type, featureId, label, insertAt: _insertAt, sketchQuery, pathQuery, ...inline } = m
    applyAddSweep(next, featureId, label, sketchQuery, pathQuery, inline)
  },
  set_sweep_field: (next, m) =>
    applySetSweepField(next, m.featureId, m.field, m.value),
  add_sweep_profile: (next, m) =>
    applyAddSweepProfile(next, m.featureId, m.sketchQuery),
  remove_sweep_profile: (next, m) =>
    applyRemoveSweepProfile(next, m.featureId, m.index),
  add_sweep_path: (next, m) =>
    applyAddSweepPath(next, m.featureId, m.pathQuery),
  remove_sweep_path: (next, m) =>
    applyRemoveSweepPath(next, m.featureId, m.index),
  add_import_step: (next, m) =>
    applyAddImportStep(next, m.featureId, m.fileId, m.label, m.scale),
  add_fillet: (next, m) =>
    applyAddFillet(next, m.featureId, m.label, resolvedQueries(m.edges), m.radius),
  add_chamfer: (next, m) =>
    applyAddChamfer(next, m.featureId, m.label, resolvedQueries(m.edges), m.distance),
  set_fillet_field: (next, m) =>
    applySetFilletField(next, m.featureId, m.field, m.value),
  set_chamfer_field: (next, m) =>
    applySetChamferField(next, m.featureId, m.field, m.value),
  add_fillet_edge: (next, m) =>
    applyAddFilletEdge(next, m.featureId, m.edgeQuery),
  remove_fillet_edge: (next, m) =>
    applyRemoveFilletEdge(next, m.featureId, m.index),
  add_chamfer_edge: (next, m) =>
    applyAddChamferEdge(next, m.featureId, m.edgeQuery),
  remove_chamfer_edge: (next, m) =>
    applyRemoveChamferEdge(next, m.featureId, m.index),
  add_shell: (next, m) =>
    applyAddShell(next, m.featureId, m.label, resolvedQueries(m.faces), m.thickness, m.direction, m.join),
  set_shell_field: (next, m) =>
    applySetShellField(next, m.featureId, m.field, m.value),
  add_shell_face: (next, m) =>
    applyAddShellFace(next, m.featureId, m.faceQuery),
  remove_shell_face: (next, m) =>
    applyRemoveShellFace(next, m.featureId, m.index),
  add_move_face: (next, m) =>
    applyAddMoveFace(next, m.featureId, m.label),
  set_move_face_field: (next, m) =>
    applySetMoveFaceField(next, m.featureId, m.field, m.value),
  add_move_face_ref: (next, m) =>
    applyAddMoveFaceRef(next, m.featureId, m.faceQuery),
  remove_move_face_ref: (next, m) =>
    applyRemoveMoveFaceRef(next, m.featureId, m.index),
  add_delete_face: (next, m) =>
    applyAddDeleteFace(next, m.featureId, m.label, m.faces),
  add_delete_face_ref: (next, m) =>
    applyAddDeleteFaceRef(next, m.featureId, m.faceQuery),
  remove_delete_face_ref: (next, m) =>
    applyRemoveDeleteFaceRef(next, m.featureId, m.index),
  add_boolean: (next, m) => {
    const { type: _type, featureId, label, insertAt: _insertAt, ...inline } = m
    applyAddBoolean(next, featureId, label, inline)
  },
  set_boolean_field: (next, m) =>
    applySetBooleanField(next, m.featureId, m.field, m.value),
  add_boolean_tool: (next, m) =>
    applyAddBooleanTool(next, m.featureId, m.tool),
  remove_boolean_tool: (next, m) =>
    applyRemoveBooleanTool(next, m.featureId, m.tool),
  add_linear_pattern: (next, m) => {
    const { type: _type, featureId, label, insertAt: _insertAt, ...inline } = m
    applyAddLinearPattern(next, featureId, label, inline)
  },
  set_linear_pattern_field: (next, m) =>
    applySetLinearPatternField(next, m.featureId, m.field, m.value),
  add_circular_pattern: (next, m) => {
    const { type: _type, featureId, label, insertAt: _insertAt, ...inline } = m
    applyAddCircularPattern(next, featureId, label, inline)
  },
  set_circular_pattern_field: (next, m) =>
    applySetCircularPatternField(next, m.featureId, m.field, m.value),
  add_curve_pattern: (next, m) => {
    const { type: _type, featureId, label, insertAt: _insertAt, pathQuery, ...inline } = m
    applyAddCurvePattern(next, featureId, label, pathQuery, inline)
  },
  set_curve_pattern_field: (next, m) =>
    applySetCurvePatternField(next, m.featureId, m.field, m.value),
  add_curve_pattern_path: (next, m) =>
    applyAddCurvePatternPath(next, m.featureId, m.pathQuery),
  remove_curve_pattern_path: (next, m) =>
    applyRemoveCurvePatternPath(next, m.featureId, m.index),
  add_instance_pattern: (next, m) => {
    const { type: _type, featureId, label, insertAt: _insertAt, ...inline } = m
    applyAddInstancePattern(next, featureId, label, inline)
  },
  set_instance_pattern_field: (next, m) =>
    applySetInstancePatternField(next, m.featureId, m.field, m.value),
  add_instance_pattern_target: (next, m) =>
    applyAddInstancePatternTarget(next, m.featureId, m.targetQuery),
  remove_instance_pattern_target: (next, m) =>
    applyRemoveInstancePatternTarget(next, m.featureId, m.index),
  // The retired alias, translated by the applier through the loader's own
  // split. Nothing in the app emits it; the drive also translates it up front
  // so the step reply can carry the deprecation note.
  add_pattern: (next, m) => {
    const { type: _type, featureId, label, insertAt: _insertAt, ...inline } = m
    applyAddPattern(next, featureId, label, inline)
  },
  add_pattern_source: (next, m) =>
    applyAddPatternSource(next, m.featureId, m.sourceFeature),
  remove_pattern_source: (next, m) =>
    applyRemovePatternSource(next, m.featureId, m.index),
  set_body_visibility: (next, m) =>
    applySetPartVisibility(next, m.bodyId, m.visible),
  add_delete_body: (next, m) =>
    applyAddDeletePart(next, m.featureId, m.bodies, m.label),
  add_delete_body_ref: (next, m) =>
    applyAddDeletePartRef(next, m.featureId, m.bodyQuery),
  remove_delete_body_ref: (next, m) =>
    applyRemoveDeletePartRef(next, m.featureId, m.index),
  add_hole: (next, m) =>
    applyAddHole(next, m.featureId, m.label, {
      sketch: m.sketch,
      diameter: m.diameter,
      depth_mode: m.depth_mode,
      depth: m.depth,
      direction: m.direction,
      target: m.target,
      style: m.style,
      cb_diameter: m.cb_diameter,
      cb_depth: m.cb_depth,
      cs_angle: m.cs_angle,
      tip: m.tip,
      tip_angle: m.tip_angle,
      thread: m.thread,
      thread_depth: m.thread_depth,
    }),
  set_hole_field: (next, m) =>
    applySetHoleField(next, m.featureId, m.field, m.value),
  add_transform: (next, m) => {
    const { type: _type, featureId, label, insertAt: _insertAt, ...inline } = m
    applyAddTransform(next, featureId, label, inline)
  },
  set_transform_field: (next, m) =>
    applySetTransformField(next, m.featureId, m.field, m.value),
  add_transform_body: (next, m) =>
    applyAddTransformPart(next, m.featureId, m.bodyQuery),
  remove_transform_body: (next, m) =>
    applyRemoveTransformPart(next, m.featureId, m.index),
  rename_part: (next, m) =>
    applyRenamePart(next, m.bodyId, m.name),
  set_part_color: (next, m) =>
    applySetPartColor(next, m.bodyId, m.color),
  set_part_transparency: (next, m) =>
    applySetPartTransparency(next, m.bodyId, m.transparency),
  set_part_metalness: (next, m) =>
    applySetPartMetalness(next, m.bodyId, m.metalness),
  set_part_roughness: (next, m) =>
    applySetPartRoughness(next, m.bodyId, m.roughness),
  set_part_transmission: (next, m) =>
    applySetPartTransmission(next, m.bodyId, m.transmission),
  add_mirror: (next, m) => {
    const { type: _type, featureId, label, insertAt: _insertAt, ...inline } = m
    applyAddMirror(next, featureId, label, inline)
  },
  set_mirror_field: (next, m) =>
    applySetMirrorField(next, m.featureId, m.field, m.value),
  // Its own toggle pair, not the pattern's: a mirror stores its sources under
  // its own sub-dict, so reusing add_pattern_source would edit no mirror.
  add_mirror_source: (next, m) =>
    applyAddMirrorSource(next, m.featureId, m.sourceFeature),
  remove_mirror_source: (next, m) =>
    applyRemoveMirrorSource(next, m.featureId, m.index),
  add_split: (next, m) =>
    applyAddSplit(next, m.featureId, m.label, m.bodies, m.plane, m.keep),
  set_split_field: (next, m) =>
    applySetSplitField(next, m.featureId, m.field, m.value),
  add_split_body: (next, m) =>
    applyAddSplitPart(next, m.featureId, m.bodyQuery),
  remove_split_body: (next, m) =>
    applyRemoveSplitPart(next, m.featureId, m.index),
  add_variable: (next, m) =>
    applyAddVariable(next, m.featureId, m.label),
  set_variable_field: (next, m) =>
    applySetVariableField(next, m.featureId, m.field, m.value),
  add_helix: (next, m) =>
    applyAddHelix(next, m.featureId, m.label, m.reference),
  set_helix_field: (next, m) =>
    applySetHelixField(next, m.featureId, m.field, m.value),
  reorder_features: (next, m) =>
  {
    const toIndex = m.toIndex ?? reorderAnchorIndex(next, m)
    if (toIndex !== null) applyReorderFeatures(next, m.featureId, toIndex)
  },
  reorder_pick_field: (next, m) =>
    applyReorderPickField(next, m.featureId, m.field, m.fromIndex, m.toIndex),
  set_feature_suppression: (next, m) =>
    applySetFeatureSuppression(next, m.featureId, m.suppressed),
  set_length_unit: (next, m) => applySetLengthUnit(next, m.unit),
  remove_dangling_content: (next, m) =>
    applyRemoveDanglingContent(next, m.features),
  // doc.rollback is written by the rollback mirror in handleMutation, which is
  // the single writer for it; this mutation exists to carry the undo entry and
  // trigger the re-solve. The position payload is advisory: the store owns the
  // position and the mirror copies the store into the doc, so a dispatch must
  // pre-sync the store first (handleUserRollbackChange in Part.tsx does).
  set_rollback: () => {},
  edit_session: () => {},  // undo-only marker; no doc mutation needed
  preview_commit: () => {},  // undo-only label carrier; the entry doc is what matters
}
