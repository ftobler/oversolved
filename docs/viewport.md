# Viewport Architecture

The frontend 3D viewport is an R3F (React Three Fiber) scene inside a single `Canvas` with overlaid 2D elements.

## Component Tree (render order)

```
<Canvas orthographic camera={INITIAL_CAMERA} frameloop="demand"> (antialias, logarithmicDepthBuffer, background #111)
                                           (camera: pos [20,20,100], zoom 80, near=-500, far=500)
  <RenderOnChange />                        (asks for a frame on every scene-store change)
  <SceneController />                       (TurntableControls + CubeGizmo on drawn frames)
  <IdPickingDriver />                       (offscreen ID render target; pick source)
  <SceneProbeDriver />                      (publishes camera + canvas to the scene probe)
  <Environment /> + <EnvLight />           (IBL env map; EnvLight rotates the env to follow the camera)
  <OriginMarker />                          (builtin origin dot)
  <ReferencePlane /> x3                     (Front, Top, Right)
  <UserDefinedPlane /> xN                   (user-defined sketch planes)
  <SketchPlaneDisplay />                    (active sketch plane highlight)
  <Geometry3D /> xN                         (sketch geometry per visible feature)
  <Body3D /> xN                             (solved bodies: mesh + edges + vertices)
  <SectionPlaneHandle />                    (only while the section is on: outline + offset arrow)
  <FeatureHandles />

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

The B-rep ID layers (face, edge, vertex) carry the section's clipping plane
while a section is on, and a cap occluder writes the empty id over the cut
opening (see Section View below). The ID buffer therefore agrees with the
visible bodies: hover and selection stay one path, with no CPU-side filter
layered on top of it.

### Layer 2: Pointer Event Abstraction

Transforms raw events into clean primitives:
- **Coordinate sanitization**: world point → sketch-local 2D via inverse parent quaternion, off-plane rejection (>1 unit)
- **Click-vs-drag**: 4px screen-space threshold; drag initiation postponed until threshold exceeded (prevents race condition where click events fire after hidden collision geometry)
- **Camera state**: `orbitEnabled` flag gates the turntable; disabled during drag/draw, `isRotating` suppresses hover/selection

### Layer 3A: Navigation Subsystem

- **SceneController**: TurntableControls + CubeGizmo + keyboard modifiers + snap-to-direction animation in one `useFrame`
- **TurntableControls**: an unclamped, level-horizon turntable (`Viewport/turntable.ts`): right-drag rotates over the poles without clamping, the camera never rolls (screen right stays horizontal), and past a pole the view is upside down with the horizon still level. Left button disabled (reserved for selection), Middle=pan, Right=rotate. Ctrl=pan, Shift=dolly. The state (`target`, `distance`, `azimuth`, `elevation`, ortho `zoom`) is the single source of the camera pose; fit and plane/face alignment set it rather than calling `lookAt`. With Orbit around cursor on (View options), the right-drag pivot is the body point under the press (`Viewport/pivotPick.ts`, one raycast at button-down): the whole camera turns rigidly about it, so that point keeps its screen position and the press itself moves nothing. A miss keeps the target pivot.
- **Camera alignment**: `autoZoomToFit`, `alignCameraToPlane` (Front/Top/Right/etc.), `alignCameraToFace`
- **CubeGizmo**: 2D canvas overlay, painted on drawn frames with face/edge/vertex hit detection

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

**Pure logic files**: `coordTransform.ts`, `pointerAbstraction.ts`, `snapDetection.ts`, `nearestPoint.ts`, `dragLogic.ts`, `drawLogic.ts`, `bodySnapProjection.ts`, all registries, `stores/editorState.ts` (the L2 editor-state store: selection, active tool, draw state and the rollback/edit FSM, a vanilla zustand store with its React binding in `hooks/useEditorState.ts`), plus the picking pure (three-free, React-free) layer beside the R3F zone: `IdResolver.ts`, `markPosition.ts`, `IdRegistry.ts`, `layerNames.ts`, `pickKey.ts`, `idEncoding.ts`, `collectEntitiesFromPixels.ts`, `selectionHighlight.ts`, `HoverScheduler.ts`, `screenSpaceScale.ts`, `cameraPose.ts`, `sceneProbe.ts`, `probeMarks.ts`, `domHandles.ts`. `cameraPose.ts` imports three only as a type; `markPosition.ts`, `sceneProbe.ts` and `probeMarks.ts` carry the `PURE LOGIC` header.

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

## Section View

A section is render-only clipping: the kernel and the document are untouched.
Its state lives in `stores/sectionStore.ts` (enabled, plane source, offset,
flipped, and the reason an auto-disabled section gives); it is viewer state, so
no Mutation, no undo entry, no reload persistence and no survival across a
document load. The source is a builtin Front/Top/Right plane or a
`{kind: 'query'}` picked plane/face, resolved through `viewport/sectionPlane.ts`
against the solve results (`plane_transform`) and the planar-face frame. If the
picked source stops resolving after a solve, the section turns off and the eye
dropdown shows why; a curved face is refused at pick time with a specific
reason (it has no planar frame to cut with).

One `THREE.Plane` (`viewport/sectionClipping.ts`) is shared by every clipped
material and updated in place, so moving the plane costs no recompile. Clipped:
body faces and edges, the preview overlay, the part's hovered/selected vertex
dots, the assembly highlight overlays, and the face/edge/vertex ID layers. Not
clipped: sketches, reference and user planes, helixes, the origin,
dimension and constraint overlays, and the orientation cube.

three clips the half where a point's signed distance to the plane is negative.
The unflipped section therefore builds its plane with the negated source normal,
keeping the far half so the cut face turns toward the viewer; Flip negates both
fields and keeps the near half. `isPointClipped` (`< 0`) is the same rule for
the CPU raycasts, so the picked side cannot drift from the drawn cut.

The visible cut face is a stencil cap (`Geometry3D/SectionCap.tsx`). Per body,
back faces increment the stencil and front faces decrement it, both clipped; a
quad on the section plane then fills where the count is non-zero, in the body
colour. Each body owns a contiguous band of three render orders
(`sectionCapRenderOrders`, 150, 153, 156, ...), not one shared 150..152: three
sorts the whole scene by renderOrder, so a shared band would run every body's
back pass before any fill and each body's stencil clear would wipe the previous
count. This needs a stencil attachment on the MSAA target. `MsaaPresenter`
creates the target with `stencilBuffer` only while a section is on and
disposes/recreates it on a toggle (WebGL fixes the attachment set at
allocation). The assembly viewport draws directly, so its canvas requests a
stencil and it runs the same cap component.

Picking follows the cut in the GPU, not by filtering hits in JS:

- `IdPipeline.setSectionActive` attaches the shared plane to the three B-rep ID
  layers and gives `IdRenderTarget` a stencil for the duration.
- After the face layer, `IdPipeline` runs the same stencil count and draws a
  DoubleSide cap quad in the reserved empty id (`vec4(0)`) with depth write. The
  solid-looking cap consequently picks nothing, instead of exposing the interior
  back faces the DoubleSide ID material would otherwise show.
- An armed plane/face pick resolves against the editor's consumed layers rather
  than the active tool's hover filter, so it still works under a drawing tool.
- Every section change calls `markDirty('section')` and clears/invalidates the
  hover scheduler, so a hover resolved against the previous cut cannot land.
- The rubber band reads the same ID target, so it inherits the clip and cap.
- CPU raycasts discard hits on the removed side (`isPointClipped`, negative
  signed distance): the orbit pivot (`Viewport/pivotPick.ts`) and the assembly
  part grab (`AssemblyBody`, whose material goes DoubleSide while clipped so the
  kept side stays grabbable). Hover and selection still go through the ID buffer
  only.

The assembly gets clipping and caps, but only the builtin plane choice and the
offset/flip rows: it has no planar-face registry to resolve a picked face
against, so the dropdown hides the Pick row and explains that picking is a
part-editor action, and it mounts no section arrow (no gesture is left
half-wired). A pick armed in the part editor is cleared when the assembly
viewport mounts.

`captureThumbnail` turns `localClippingEnabled` off for the capture draw and
sets `sectionStore.capturing` so the plane outline and drag arrow (plain scene
geometry) unmount; both are restored before the full-size repaint, so a
document saved mid-section gets an uncut preview.

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
- The dev bridge exposes the probe: `window.__oversolved.hitTest`,
  `handles`, `worldToScreen` and the `probe` section of `inspect()` read these
  same functions (see `docs/drive.md`).
- The browser agreement test (probe `hitTest` vs real `resolveAllSync` per
  pick class) is still open, carried with the deferred browser tier (see
  `docs/drive.md`). Coordinates must be converted:
  probe `screenPoints` and `hitTest` are CSS pixels while `resolveAllSync`
  takes device pixels (`IdPipeline.readWindow` applies the DPR). The per-class
  expectation must also encode the phase-1 gap: the probe is not
  occlusion-aware and publishes no B-rep, plane or gizmo marks, so a class it
  does not publish returns nothing where `resolveAllSync` can still answer,
  and a sketch surface hidden behind a body can disagree with the real pick.

## Rendering Pipeline

- The Canvas is created with `antialias: false`; `MsaaRender` (inside the Canvas) claims the frame with useFrame priority 1, so R3F does not call `gl.render` itself. It renders the scene into a 4x multisampled half-float target sized to the drawing buffer (`Viewport/msaaPresenter.ts`) and draws the resolved image to the canvas through three's `OutputPass`, which applies the renderer's ACES tone mapping and sRGB encoding (rendering into a target skips both for the scene's materials). Its shader is swapped for `PREMULTIPLIED_OUTPUT_FRAGMENT`, which divides coverage out before tone mapping and multiplies it back after encoding, because the transparent-cleared target holds premultiplied colour at antialiased fringes. Fully covered opaque pixels match a direct render; blending and the sample resolve now happen in linear light, so antialiased edges and translucent overlays are weighted differently than the old sRGB-space blend (keeping the old weighting would need three's internal `isXRRenderTarget` flag). The browser is handed a single-sampled image and resolves nothing on present: a multisampled canvas shimmered fine 1px lines on Chrome + NVIDIA under Wayland, although a readback of every frame was pixel-identical. The assembly viewport still renders directly with a multisampled canvas.
- The Canvas runs `frameloop="demand"`: an idle viewport presents nothing, so the GPU and the compositor stay idle. A frame is requested by:
  - R3F itself: every scene instance it creates, updates or reveals, and every root-store change (size, dpr, scene, camera);
  - `TurntableControls`, whose change listener invalidates on every camera move;
  - `RenderOnChange` (inside the Canvas), which asks through `subscribeSceneInvalidation` (`Viewport/sceneInvalidation.ts`) on every change in the stores that feed the scene: `usePartEditorStore`, `editorState` (`useSketchEditorStore` is that same store), `useSketchUiStore` and `useViewOptionsStore` (shading, edges, brightness and the analysis modes are viewer state, not document state);
  - `RenderOnChange`'s other two cases: a restored GL context (`webglcontextrestored` leaves a blank canvas and touches no store), and `RenderOnce`, mounted beside `Environment` inside the Suspense boundary because the landed HDR map applies scene state from a layout effect and creates no R3F instance;
  - the imperative camera paths (fit, plane/face alignment) and the orientation cube's hover/snap (only when the drawn highlight changed), which reach the Canvas's own invalidate through the `invalidateRef` `RenderOnChange` publishes. `SceneController` also feeds that invalidate to `drawCubeGizmo`'s `onFontReady`, so a label font landing after the frame repaints the cube.
- `useFrame` therefore runs only on drawn frames. Per-frame work: scene controller, env light, Body3D vertex scaling, dot/hit geometry pixel scaling, origin billboarding. All of it is driven by the camera or by props, and both request a frame.
- `captureThumbnail` resizes the live renderer and restores it; because a resize clears the drawing buffer it redraws a full-size frame before returning, or a demand-mode viewport would sit blank until the next change. Both draws go through `presentFrame`, which uses the presenter `MsaaRender` registered for that renderer (the part viewport) and falls back to a direct `gl.render` (the assembly viewport). The capture draw runs with `localClippingEnabled` off, so it never stores a cut-open preview.
- Render order constants: DEFAULT=0, EDITING=10, HIGHLIGHT=999 (in `partColors.ts`).
- Screenshot capture: imperative `presentFrame(gl, scene, camera)`, `captureScreenshotForSaving` renders at 1/4 resolution scaled to max 1024px.
- Colors defined in `partColors.ts` (body: mint green, sketch: blue/white/red, selected: orange, etc.).
- Body meshes use `meshPhysicalMaterial` (roughness 0.7 by default) with `vertexColors` for per-face coloring.

## Mutation Flow

```
User interaction → Tool logic → Mutation object → onMutation
  → Part.tsx → document updated → WASM kernel re-solve
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
