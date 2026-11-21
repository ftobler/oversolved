// Barrel: backward-compatible re-exports for '@/utils/yamlMutations'

export { parseTarget, randomId, normalizeRefList, setIdSource, getIdSource, setIdScope, type IdSource } from './helpers'

export { migrateLegacyPartPicks, dropDeadAxisConstraints } from '../yamlMigrations'

export {
  applyMoveVertex,
  applyMoveEntity,
  applyResizeCircle,
  applyAddConstraint,
  applyToggleConstruction,
  applyDeleteElements,
  applySetConstraintValue,
  applySetConstraintPos,
  applySetConstraintSign,
  applyAddEntity,
  applyAddProjectedEntity,
  applyAddEntityWithConstraint,
  applyAddPointAtIntersection,
  applyAddDock,
  applyAddRect,
  applyAddCenterRect,
  applyAddNgon,
  applyAddThreePointArc,
  applyAddOffset,
  applySetFeaturePlane,
} from './sketch'

export { applyInsertFitPoint, applySetFitSplineHandle, applyDeleteFitPoint, type FitSplineAddOptions } from './fitSpline'

export { applyImportDxf } from './sketchDxf'

export { applyAddText, planAddText, textEntityRows, type AddTextFields } from './sketchText'

export { applyMirrorEntities } from './sketchMirror'

export { applyFilletCorners, planFilletCorners, type FilletSketchPlan, type PlannedFilletCorner } from './sketchFillet'

export { applyPatternEntities, planPatternEntities, type PatternEntitiesStep } from './sketchPattern'

export { applyPasteSketchEntities } from './sketchPaste'

export {
  applyAddExtrude,
  applyAddExtrudeProfile,
  applyRemoveExtrudeProfile,
  applySetExtrudeField,
  applyAddRevolve,
  applyAddRevolveProfile,
  applyRemoveRevolveProfile,
  applySetRevolveField,
  applyAddWrap,
  applySetWrapField,
  applyAddSweep,
  applyAddSweepProfile,
  applyRemoveSweepProfile,
  applyAddSweepPath,
  applyRemoveSweepPath,
  applySetSweepField,
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
  applyAddPattern,
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
  DEFAULT_EXTRUDE_DISTANCE,
  DEFAULT_WRAP_HEIGHT,
} from './featureDefs'

export {
  applyRenamePart,
  applySetPartVisibility,
  applySetPartColor,
  applySetPartTransparency,
  applySetPartMetalness,
  applySetPartRoughness,
  applySetPartTransmission,
} from './partStyle'

export {
  applyAddSketch,
  applyDeleteFeature,
  applyReorderFeatures,
  applyMoveFeatureBefore,
  reorderAnchorIndex,
  applySetRollback,
  applySetLengthUnit,
  applySetFeatureSuppression,
  applySetFeatureVisibility,
  applyRenameFeature,
  applyToggleSketchPlaneVisibility,
  applyTogglePlaneVisibility,
  hidePlanes,
  applyAddPlane,
  applySetPlaneDefinitionField,
  applyReorderPickField,
} from './featureAdmin'
