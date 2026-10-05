# Viewport Architecture

The frontend 3D viewport is an R3F (React Three Fiber) scene inside a single `Canvas` with overlaid 2D elements.

## Component Tree (render order)

```
<Canvas orthographic camera={INITIAL_CAMERA}> (antialias, logarithmicDepthBuffer, background #111)
                                           (camera: pos [20,20,100], zoom 80, near=-10, far=1000)
  <SceneController />                       (OrbitControls + CubeGizmo per-frame)
  <Environment /> + <EnvLight />           (IBL env map; EnvLight rotates the env to follow the camera)
  <OriginMarker />                          (builtin origin dot)
  <ReferencePlane /> x3                     (Front, Top, Right)
  <UserDefinedPlane /> xN                   (user-defined sketch planes)
  <SketchPlaneDisplay />                    (active sketch plane highlight)
  <Geometry3D /> xN                         (sketch geometry per visible feature)
  <Body3D /> xN                             (solved bodies: mesh + edges + vertices)

<!-- Overlaid 2D -->
<CubeGizmoCanvas />                         (128x128 orientation cube, bottom-right)
<ContextMenuDialog />                        (right-click context menu)
```

### Root: `Viewport/index.tsx`

Top-level `forwardRef` component exposing `ViewportHandle`: `captureScreenshot`, `captureScreenshotForSaving`, `autoZoomToFit`, `alignCameraToPlane`, `alignCameraToFace`.

### Geometry3D Package (`src/components/Geometry3D/`)

Composes: sketch topology surfaces/edges, entity lines, projected entities, vertex dots, constraint overlays, drag plane/indicators, draw preview/plane, and Body3D.

## Layer Architecture

```
 Tool Layer (Drag/Draw/Constraint/Dimension)
        |
  +-----------+  +-----------+
  | Navigation|  | Selection |
  | Subsystem |  | Subsystem |
  +-----------+  +-----------+
        |              |
  Pointer Event Abstraction Layer (coord transform, raycast, click-vs-drag)
        |
  Raw Pointer Events (canvas pointerdown/move/up)
```

### Layer 1: Raw Pointer Events

Three.js R3F intercepts canvas events and raycasts against the scene. Canvas handles right-click and `onPointerMissed` for deselection. DragPlane/DrawPlane use window-level listeners with manual raycasting to bypass R3F event bubbling.

### Layer 2: Pointer Event Abstraction

Transforms raw events into clean primitives:
- **Coordinate sanitization**: world point → sketch-local 2D via inverse parent quaternion, off-plane rejection (>1 unit)
- **Click-vs-drag**: 4px screen-space threshold; drag initiation postponed until threshold exceeded (prevents race condition where click events fire after hidden collision geometry)
- **Camera state**: `orbitEnabled` flag gates OrbitControls; disabled during drag/draw, `isRotating` suppresses hover/selection

### Layer 3A: Navigation Subsystem

- **SceneController**: OrbitControls + CubeGizmo + keyboard modifiers + snap-to-direction animation in one `useFrame`
- **OrbitControls**: Left button disabled (reserved for selection), Middle=pan, Right=rotate. Ctrl=pan, Shift=dolly
- **Camera alignment**: `autoZoomToFit`, `alignCameraToPlane` (Front/Top/Right/etc.), `alignCameraToFace`
- **CubeGizmo**: 2D canvas overlay, rendered each frame with face/edge/vertex hit detection

### Layer 3B: Selection Subsystem

Three classes of selection:

| Class | Persistence | Purpose |
|-------|------------|---------|
| Static (normal) | Across pointer events | User's explicit selection; drives mutations, menus |
| Dynamic | Cleared on pointer-up | Temporary accumulation during drag; drives alignment snap |
| Hover | Cleared on pointer-leave | Immediate cursor feedback; provides snap targets |

Selection IDs: `entity:<feat>:<eid>`, `vertex:<feat>:<eid>:<key>`, `constraint:<feat>:<cid>`, `face:<feat>:<?query>`, `@builtin_*`, `@<body>/face/<n>` etc.

3D B-rep face selection: Three.js `faceIndex` → `triangle_to_face` → B-rep face index → `face_queries[faceIndex]` → stable query string.

### Layer 4: Tool Layer

Tools receive sanitized pointer events via `toolRegistry` handlers (`onClick`, `onPointerDown`, `onPointerMove`, `onPointerUp`). Registered: dimension, drag, line, circle, arc, ellipse, point, project, spline, rect, center_rect, ngon.

Not every interaction is a registered tool:
- **Select** has no registered tool. Idle select is the dispatchSketchClick fallback (`state.toggleNormalSelection(id)` for the clicked entity/vertex) plus the DrawPlane backplane clear on empty-space clicks (`Drawing.tsx`). The toolbar select button dispatches `set_tool_drag`, and `getEffectiveTool(null)` resolves to `'drag'`.
- **Constraints** have no registered tools. Constraint apply is `apply_<kind>` -> `store.applyConstraint` (`commandEntries.ts`), which owns the target validation. Snap-inferred constraints (vertex→coincident, path→coincident, alignment→horizontal/vertical) are added by the draw gestures.

- **Drag**: threshold-based initiation, vertex/entity/alignment snap via `dragLogic.ts`, creates YAML mutation on release
- **Draw**: inserts geometry via DrawPlane, snap to vertices/entities, preview rendering

## Layer Contracts

A wall separates testable logic from the untestable R3F zone. Only plain TypeScript primitives cross it (`string`, `number`, `boolean`, plain objects, tuples). No `THREE.*`, no refs, no R3F hooks.

**Pure logic files** (header: "PURE LOGIC"): `coordTransform.ts`, `pointerAbstraction.ts`, `snapDetection.ts`, `nearestPoint.ts`, `dragLogic.ts`, `drawLogic.ts`, `bodySnapProjection.ts`, all registries, `sketchEditorStore.ts`.

**Viewport adapters** (~10 lines, no branching): `coordTransformAdapters.ts`, `pointerAbstractionAdapters.ts`.

**Viewport components** (Three.js allowed, not directly tested): all files in `Geometry3D/*.tsx`, `Viewport/*.tsx`, `CubeGizmo.tsx`, `ContextMenuDialog.tsx`.

Navigation and selection/highlight reading from the store are allowed bypasses (no mutations).

## Pointer Event Priority (raycast z-depth)

1. Vertex hit spheres (z=0)
2. Entity HitPolylines (z=-0.001, hidden during drag)
3. Sketch topology surfaces (z=-0.003 in sketch-plane space)
4. DragPlane mesh (z=0, drag active)
5. DrawPlane mesh (z=-0.002, drawing active)
6. B-rep faces/edges (scene z)
7. Deselect plane (z=-1000)
8. OrbitControls (canvas div level, orbitEnabled=true)

Hit geometry: entities via cylinder per segment (8px radius), vertices via sphere (20px), drag snap entity 8px, drag snap vertex 20px. Pixel-to-world-radius = `1 / camera.zoom`.

## Rendering Pipeline

- R3F render loop drives all rendering. Per-frame `useFrame`: scene controller, env light, Body3D vertex scaling, dot/hit geometry pixel scaling, origin billboarding.
- Render order constants: DEFAULT=0, EDITING=10, HIGHLIGHT=999 (in `partColors.ts`).
- Screenshot capture: imperative `gl.render(scene, camera)`, `captureScreenshotForSaving` renders at 1/4 resolution scaled to max 512px.
- Colors defined in `partColors.ts` (body: mint green, sketch: blue/white/red, selected: orange, etc.).
- Body meshes use `meshPhysicalMaterial` (roughness 0.7 by default) with `vertexColors` for per-face coloring.

## Mutation Flow

```
User interaction → Tool logic → Mutation object → onMutation
  → Part.tsx → YAML AST updated → WASM kernel re-solve
  → Geometry returned → Store updated → Scene re-rendered
```

The Zustand store never directly modifies sketch data - it dispatches through the solver.

## Collision Hiding During Interaction

| Condition | Hidden Geometry |
|-----------|-----------------|
| Entity/vertex being dragged | That entity's HitPolylines + hit spheres |
| Any drag active | Reference and user-defined plane collision meshes |

## Snap System

Snap priority during drag: vertex snap (20px) → entity snap (8px) → no snap (raw position). Dynamic selection feeds alignment snap detection (~10 degree tolerance). The `snapRegistry` defines allowed snap targets per drag type.

Body snap projection (`bodySnapProjection.ts`): projects 3D body vertices/edges onto active sketch plane, injected with `__body__` prefix (no constraints generated for body-snap targets).

## Key Constants

| Constant | Value |
|----------|-------|
| `POINT_HIT_PIXELS` | 20 |
| `POINT_VIS_PIXELS` | 4 |
| `DRAG_SNAP_VERTEX_RADIUS_PX` | 20 |
| `DRAG_SNAP_ENTITY_RADIUS_PX` | 8 |
| `CLICK_THRESHOLD_PX` | 4 |
| `ALIGNMENT_TOLERANCE_DEG` | 10 |
