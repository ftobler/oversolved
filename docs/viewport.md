# Viewport Architecture

The frontend 3D viewport is an R3F (React Three Fiber) scene inside a single `Canvas` with overlaid 2D elements.

## Component Tree (render order)

```
<Canvas orthographic camera={INITIAL_CAMERA}> (antialias, logarithmicDepthBuffer, background #111)
                                           (camera: pos [20,20,100], zoom 80, near=-500, far=500)
  <SceneController />                       (OrbitControls + CubeGizmo per-frame)
  <IdPickingDriver />                       (offscreen ID render target; pick source)
  <SceneProbeDriver />                      (publishes camera + canvas to the scene probe)
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

Top-level `forwardRef` component exposing `ViewportHandle`: `captureScreenshotForSaving`, `autoZoomToFit`, `cancelPendingFit`, `alignCameraToPlane`, `alignCameraToFace`.

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
  Pointer Event Abstraction Layer (coord transform, plane intersection, click-vs-drag)
        |
  Raw Pointer Events (canvas pointerdown/move/up)
```

### Layer 1: Raw Pointer Events

Selection and hover are NOT raycasts against the scene. The offscreen ID
buffer is the sole pick source: `IdPickingDriver` renders the ID layers into
an RGBA render target and `useIdBufferPointerDispatch` resolves the cursor's
window from it (see Pick Precedence below). R3F canvas events remain only for
the backplane/deselect paths (`onPointerMissed`), surfaces' own guarded click,
and drag/draw plane math. DragPlane/DrawPlane use window-level listeners and a
ray-plane intersection (`dragMathPlane.ts`) to bypass R3F event bubbling when
mapping the cursor onto the sketch plane.

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

**Pure logic files**: `coordTransform.ts`, `pointerAbstraction.ts`, `snapDetection.ts`, `nearestPoint.ts`, `dragLogic.ts`, `drawLogic.ts`, `bodySnapProjection.ts`, all registries, `sketchEditorStore.ts`, plus the picking pure (three-free, React-free) layer beside the R3F zone: `IdResolver.ts`, `markPosition.ts`, `IdRegistry.ts`, `layerNames.ts`, `pickKey.ts`, `idEncoding.ts`, `collectEntitiesFromPixels.ts`, `selectionHighlight.ts`, `HoverScheduler.ts`, `screenSpaceScale.ts`, `cameraPose.ts`, `sceneProbe.ts`, `probeMarks.ts`, `domHandles.ts`. `cameraPose.ts` imports three only as a type; `markPosition.ts`, `sceneProbe.ts` and `probeMarks.ts` carry the `PURE LOGIC` header.

**Viewport adapters** (~10 lines, no branching): `coordTransformAdapters.ts`, `pointerAbstractionAdapters.ts`.

**Viewport components**: most of `Geometry3D/*.tsx` and `Viewport/*.tsx` are unit-tested with R3F mocked (38 Viewport and 71+ Geometry3D suites). The genuinely untested layer is NOT "all R3F files" but real-GL rasterization and real browser pointer events: shader output, GPU layering/depth, driver readback, and synthetic pointer sequences through a live canvas. `crossLayerPriority.test.ts` documents the GPU-dependent cases as deferred manual smoke. `CubeGizmo.tsx` and `ContextMenuDialog.tsx` do have focused unit suites (`components/misc/__tests__/CubeGizmo.test.tsx`, `CubeGizmo.utils.test.ts`, `components/dialogs/__tests__/ContextMenuDialog.test.tsx`); what remains untested there is real canvas painting and browser popover behaviour, and the drei overlay internals are untested by design.

Navigation and selection/highlight reading from the store are allowed bypasses (no mutations).

## Pick Precedence (ID buffer)

The pick ladder is exported as data in `layerNames.ts` (`PICK_LADDER`), and
`IdPipeline` mounts each layer at its rung priority. Within a layer a later
rendered primitive owns its pixels (depth policy); across layers the resolver
orders candidates by **layer priority descending, pixel distance ascending,
pixel scan order, mark order** (`IdResolver.resolvePixelWindowAll`).

| Priority | Layer | Content |
|----------|-------|---------|
| -10 | `planeFace` | reference/user/sketch plane quads |
| 0 | `face` | B-rep faces (assembly reuses it with positional keys) |
| 10 | `edge` | B-rep edges |
| 20 | `vertex` | B-rep vertices (3 px pick cubes) |
| 30 | `sketchSurface` | sketch topology area fill |
| 40 | `sketchEntity` | sketch entity lines |
| 45 | `originMarker` | builtin origin dot (deliberately below sketch vertices) |
| 50 | `sketchVertex` | sketch vertices and inferred contacts |
| 70 | `dimensionLabel` | dimension label hit circles |
| 80 | `featureHandle` | feature editing arrows |
| 90 | `gizmoHandle` | assembly triad grab regions |

The pick window is `DEFAULT_WINDOW_SIZE` = 17 CSS px, scaled by the
device-pixel ratio at read time; the reach is the inscribed radius, 8 px in
every direction (`pickRadiusPx`). Hit geometry constants:
`POINT_HIT_PIXELS` 20 and `ENTITY_HIT_PIXELS` 8 are the drag/snap zones, not
the ID reach; `VERTEX_PICK_CUBE_PIXELS` 3 is the B-rep vertex cube size.

## Scene Probe

`SceneProbeDriver` (inside the Canvas) and the ID registration hooks publish a
plain, JSON-safe snapshot of the scene, readable without a devtools connection:

- `getSceneProbe()` (`@/picking`) returns `{ revision, camera, canvas,
  sketchPlane, pickables }`. Camera pose and canvas size are published on
  change, never per frame; pickables are published from the same builder data
  the ID layers register (sketch entity segments, sketch vertices, sketch
  surfaces, origin, dimension labels, feature handles). B-rep face/edge
  outlines and gizmo handles are phase 2.
- `hitTest(probe, x, y, opts?)` / `probeHitTest(x, y, opts?)` return ordered
  candidates with the same priority/distance ranking as a real resolve, using
  the shared pick radius. The probe measures exact screen geometry while the
  resolver measures rasterized pixel centres, so within about a pixel of the
  reach boundary the two can disagree; the browser agreement test pins the
  actual tolerance per pick class.
- `worldToScreen(probe, points)` and `sketchToScreen(probe, points)` project
  through the probe camera (orthographic viewport); `sketchToScreen` uses the
  published active sketch plane.
- `getSceneHandles(prefix?)` lists GL handles (probe pickables) and DOM
  handles (elements carrying `data-oversolved-handle`, e.g.
  `toolbar:set_tool_line`, `tree:feature:<id>`).
- The browser agreement test (probe `hitTest` vs real `resolveAllSync` per
  pick class) lands with the drive-surface plan. Coordinates must be converted:
  probe `screenPoints` and `hitTest` are CSS pixels while `resolveAllSync`
  takes device pixels (`IdPipeline.readWindow` applies the DPR). The per-class
  expectation must also encode the phase-1 gap: the probe is not
  occlusion-aware and publishes no B-rep, plane or gizmo marks, so a class it
  does not publish returns nothing where `resolveAllSync` can still answer,
  and a sketch surface hidden behind a body can disagree with the real pick.

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

## Pick Layers During Interaction

The ID layers are not rebuilt from the live drag preview. While a drag runs,
`Geometry3D` registers the held/solved sketch (not the per-frame preview), and
topology areas are suppressed while `topologyStale` is true, so a pick can
never resolve to a position the preview has left behind. The commit solve
re-registers the moved geometry and the buffer rebuilds.

## Snap System

Snap priority during drag: vertex snap (20px) → entity snap (8px) → no snap (raw position). Dynamic selection feeds alignment snap detection (~10 degree tolerance). The `snapRegistry` defines allowed snap targets per drag type.

Body snap projection (`bodySnapProjection.ts`): projects 3D body vertices/edges onto active sketch plane, injected with `__body__` prefix (no constraints generated for body-snap targets).

## Key Constants

| Constant | Value |
|----------|-------|
| `POINT_HIT_PIXELS` | 20 |
| `POINT_VIS_PIXELS` | 4 |
| `ENTITY_HIT_PIXELS` | 8 |
| `DRAG_SNAP_VERTEX_RADIUS_PX` | 20 |
| `DRAG_SNAP_ENTITY_RADIUS_PX` | 8 |
| `DEFAULT_WINDOW_SIZE` (ID pick window, CSS px; reach 8) | 17 |
| `VERTEX_PICK_CUBE_PIXELS` | 3 |
| `CLICK_THRESHOLD_PX` | 4 |
| `ALIGNMENT_TOLERANCE_DEG` | 10 |
