export { IdRegistry, type IdRecord } from './IdRegistry'
export { IdRenderTarget } from './IdRenderTarget'
export { IdResolver, resolvePixelWindow, resolvePixelWindowAll, type ResolvedHit, type ResolveOptions } from './IdResolver'
export { FaceIdLayer, FACE_LAYER_NAME, type FaceBodyRegistration } from './FaceIdLayer'
export { EdgeIdLayer, EDGE_LAYER_NAME, EDGE_DEPTH_BIAS, type EdgeBodyRegistration } from './EdgeIdLayer'
export { VertexIdLayer, VERTEX_LAYER_NAME, type VertexBodyRegistration, type VertexIdLayerConfig } from './VertexIdLayer'
export {
  worldUnitsPerPixel, pixelCubeHalfExtent, CUBE_CORNER_SIGNS, CUBE_TRIANGLE_INDICES,
  DEFAULT_WINDOW_SIZE, pickRadiusPx,
} from './screenSpaceScale'
export {
  IdPipeline, VERTEX_PICK_CUBE_PIXELS,
  PLANE_LAYER_NAME, SKETCH_ENTITY_LAYER_NAME, SKETCH_VERTEX_LAYER_NAME, ORIGIN_LAYER_NAME,
  DIMENSION_LABEL_LAYER_NAME, FEATURE_HANDLE_LAYER_NAME, GIZMO_HANDLE_LAYER_NAME,
  SKETCH_SURFACE_LAYER_NAME,
  type IdPipelineOptions,
} from './IdPipeline'
export { getPixelRatio, MIN_PLAUSIBLE_CANVAS_CSS_WIDTH } from './pickPixelRatio'
export { IdPipelineContext, useIdPipeline } from './IdPipelineContext'
export { default as IdPickingDriver } from './IdPickingDriver'
export { useFaceIdRegistration } from './useFaceIdRegistration'
export { useEdgeIdRegistration } from './useEdgeIdRegistration'
export { useVertexIdRegistration } from './useVertexIdRegistration'
export { usePlaneIdRegistration } from './usePlaneIdRegistration'
export { useOriginMarkerIdRegistration } from './useOriginMarkerIdRegistration'
export { useSketchIdRegistration } from './useSketchIdRegistration'
export { useSketchSurfaceIdRegistration } from './useSketchSurfaceIdRegistration'
export { useDimensionLabelIdRegistration } from './useDimensionLabelIdRegistration'
export { useFeatureHandleIdRegistration, featureHandleKey } from './useFeatureHandleIdRegistration'
export { getLivePipeline } from './IdPipelineContext'
export { idToRGB, rgbToId, idToRGBNormalized, EMPTY_ID, MAX_ID } from './idEncoding'
export {
  PART_EDITOR_PICK_LAYER_NAMES,
  PICK_LADDER, PICK_LAYER_PRIORITIES, pickPriorityOf,
  type PickLayerRung,
} from './layerNames'
export type { IdLayer, LayerZPolicy } from './IdLayer'
export {
  hitTest, buildSceneProbe, worldToScreen, sketchToScreen, sketchPointToWorld,
  nearestMarkDistance, pointToSegmentDistance, pointInPolygon,
  probeCameraFrom, probeCamerasEqual,
  type ProbeCamera, type ProbePlane, type ProbeMarkKind,
  type ProbePickableSource, type SceneProbePickable, type SceneProbe,
  type ProbeHit, type ProbeHitOptions, type ProbeBuildInput,
} from './sceneProbe'
export {
  publishProbeCamera, publishProbeCanvas, publishProbeSketchPlane,
  replaceProbeSource, clearProbeSource, probeSourceKeys,
  getSceneProbe, probeHitTest, getSceneProbeRevision, getSceneHandles,
  resetSceneProbeStore,
  type ProbeHandle,
} from './sceneProbeStore'
export {
  DOM_HANDLE_ATTRIBUTE, domHandleProps, scanDomHandles, type DomHandleInfo,
} from './domHandles'
export {
  pointPickable, polylinePickable, pointPickables, polylinePickables, polygonPickables,
  type ProbeSurfaceOutline,
} from './probeMarks'
