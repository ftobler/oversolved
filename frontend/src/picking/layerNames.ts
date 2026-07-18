// Pure layer-name identifiers for the ID picking pipeline. Deliberately free of
// three.js (and any renderer code) so tool/selection policy modules can import
// them without dragging in the WebGL pipeline. This preserves the headless
// boundary: deleting the Viewport must not break core logic that only needs the
// names. The owning layer modules and the @/picking barrel re-export these so
// existing import sites keep working unchanged.
export const FACE_LAYER_NAME = 'face'
export const EDGE_LAYER_NAME = 'edge'
export const VERTEX_LAYER_NAME = 'vertex'
export const PLANE_LAYER_NAME = 'planeFace'
export const SKETCH_SURFACE_LAYER_NAME = 'sketchSurface'
export const SKETCH_ENTITY_LAYER_NAME = 'sketchEntity'
export const SKETCH_VERTEX_LAYER_NAME = 'sketchVertex'
export const ORIGIN_LAYER_NAME = 'originMarker'
export const DIMENSION_LABEL_LAYER_NAME = 'dimensionLabel'
export const FEATURE_HANDLE_LAYER_NAME = 'featureHandle'
// The assembly triad's grab regions. Its own name rather than a reuse of
// featureHandle: both editors share the layer-name namespace, and a part-editor
// dispatch switch must never see an assembly gizmo id.
export const GIZMO_HANDLE_LAYER_NAME = 'gizmoHandle'
