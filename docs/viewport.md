# Viewport Interaction Architecture

This document describes the frontend viewport interaction system architecture.

## Layer Overview

The viewport interaction system is organized as a layered architecture where raw pointer events enter at the bottom, are sanitized and abstracted, then flow upward through two parallel subsystems (navigation and selection), and finally reach the tool layer where domain logic operates.

```
+---------------------------------------------------------------+
|  Tool Layer                                                   |
|  Dragging / Drawing / Constraint Insertion / Dimension       |
+---------------------------------------------------------------+
               |                          |
+---------------------------+ +---------------------------+
| Navigation Subsystem     | | Selection Subsystem       |
| - Orbit (rotate/pan/zoom) | | - Static Selection       |
| - ViewCube Gizmo          | | - Dynamic Selection      |
| - Camera Reset / Auto-Fit | | - Hover State            |
+---------------------------+ +---------------------------+
               |                          |
+---------------------------------------------------------------+
|  Pointer Event Abstraction Layer                              |
|  - Coordinate Sanitization                                    |
|  - Sketch-Local Transform                                    |
|  - Raycast Resolution                                        |
|  - Click-vs-Drag Disambiguation                             |
+---------------------------------------------------------------+
               |
+---------------------------------------------------------------+
|  Raw Pointer Events                                           |
|  Browser pointerdown / pointermove / pointerup               |
+---------------------------------------------------------------+
```

## Layer 1: Raw Pointer Events

The browser fires `pointerdown`, `pointermove`, and `pointerup` events on the canvas element. Three.js R3F intercepts these and performs raycasting against the scene graph. Hit testing resolves which mesh was struck and at what 3D world point.

### Z-Priority Stack

R3F uses depth ordering to determine which mesh receives the pointer event. From highest to lowest priority:

| Priority | Mesh | z-offset | Active When |
|----------|------|----------|-------------|
| 1 | Vertex hit spheres | 0 | always |
| 2 | Entity hit cylinders | -0.001 | always (hidden during drag of that entity) |
| 3 | DragPlane | 0 | drag active |
| 4 | DrawPlane | -0.002 | drawing tool active |
| 5 | Deselect plane | -1000 | select/dimension mode |
| 6 | OrbitControls | canvas-level | orbitEnabled=true |

The z-offsets ensure vertices always win over entity bodies, and that drag/draw planes only intercept events when they should.

### Hit Geometry

Each interactive element has invisible collision geometry scaled to a pixel-based radius, converted to world units via the inverse camera zoom (`p2w = 1 / camera.zoom`):

| Element | Collision Shape | Pixel Radius | Constant |
|---------|----------------|---------------|----------|
| Entity (line/arc/circle) | Cylinder per segment | 8px | `HIT_PIXELS` |
| Vertex | Sphere | 20px | `POINT_HIT_PIXELS` |
| Drag snap vertex | Sphere | 20px | `DRAG_SNAP_VERTEX_RADIUS_PX` |
| Drag snap entity | Cylinder | 8px | `DRAG_SNAP_ENTITY_RADIUS_PX` |

## Layer 2: Pointer Event Abstraction Layer

This layer transforms raw pointer events into clean, coordinate-system-independent interaction primitives. It handles four concerns: coordinate transformation, raycast resolution, click-vs-drag disambiguation, and camera state coordination.

### Coordinate Sanitization

Raw 3D world points from raycasting must be projected into the sketch-local 2D coordinate system. The `toLocal()` transform accounts for sketch planes that are rotated or translated in 3D space:

```
worldPoint
  -> subtract parent world position
  -> apply inverse parent world quaternion
  -> extract [x, y] as sketch coordinates
```

This ensures all downstream logic operates in a consistent 2D coordinate space regardless of the 3D orientation of the sketch plane.

### Click-vs-Drag Disambiguation

A 4-pixel screen-space threshold distinguishes clicks from drags. The `startClient: [number, number]` is captured at `pointerdown`. On `pointerup`, the Euclidean distance in screen pixels is computed:

- **< 4px**: Pure click (selection only, no geometry mutation)
- **>= 4px**: Actual drag (emit geometry mutation)

This threshold is zoom-independent because it operates in screen pixels, not world units.

#### Postpone Drag Initiation

The drag system must postpone drag initiation until movement exceeds the 4px threshold. This prevents a race condition where:

1. User clicks on entity/vertex
2. `onPointerDown` handler fires and immediately sets drag state
3. Collision geometry (HitPolyline or hit sphere) is hidden when drag state is set
4. The `onClick` event fires, but the collision mesh is now hidden
5. Selection does not update

The solution:
1. On `pointerdown`: Set `isPointerDown = true` and record `startClient`, but do NOT call `setDrag()` yet
2. On `pointermove`: If movement exceeds 4px threshold, THEN call `setDrag()` to initiate drag (this triggers collision hiding)
3. On `pointerup`: If drag was never initiated, treat as pure click for selection

This allows selection to work normally while still enabling drag when the user intentionally moves the cursor.

### Camera State Coordination

The `orbitEnabled` flag gates whether OrbitControls responds to pointer events. During drag operations, orbit is disabled to prevent camera rotation while moving geometry. The `isRotating` flag is set by OrbitControls and suppresses all hover/selection events during camera motion.

## Layer 3A: Navigation Subsystem

The navigation subsystem controls viewport camera motion. It is independent of the selection subsystem and operates on a separate event path.

### OrbitControls

Implemented via `@react-three/drei` OrbitControls with an orthographic camera.

**Mouse button mapping:**

| Button | Action |
|--------|--------|
| Left | Disabled by default (reserved for selection) |
| Middle | Pan |
| Right | Rotate |

**Modifier overrides (right button held):**

| Modifier | Action |
|----------|--------|
| None | Rotate |
| Ctrl/Meta | Pan |
| Shift | Dolly (zoom) |

The `orbitEnabled` flag is managed by the drag system. When a drag begins, orbit is disabled; when it ends, orbit is re-enabled.

### CubeGizmo

A 2D HTML canvas overlay renders a wireframe navigation cube in the viewport corner. Clicking a face, edge, or vertex snaps the camera to the corresponding orthogonal view. The gizmo performs its own hit testing using projected cube vertices.

### Camera Reset and Auto-Zoom

A `resetTrigger` counter increments to signal camera reset to initial position. The `autoZoomToFit()` function traverses all scene meshes, computes their bounding box, and adjusts camera zoom and position to frame the geometry.

## Layer 3B: Selection Subsystem

The selection subsystem manages three distinct classes of selection state, each serving a different purpose.

### Selection Class 1: Static Selection

**Purpose**: The user's explicitly chosen set of elements, persisted until explicitly changed.

**State**: `selection: Set<string>` in the Zustand store.

**ID formats**:

| Element Type | ID Format | Example |
|---|---|---|
| Entity | `entity:{featureId}:{entityId}` | `entity:S1:L1` |
| Vertex | `vertex:{featureId}:{entityId}:{key}` | `vertex:S1:L1:start` |
| Constraint | `constraint:{featureId}:{constraintId}` | `constraint:S1:C1` |
| Builtin plane | `@builtin_plane_{name}` | `@builtin_plane_front` |
| Feature plane | `@{featureId}` | `@myPlane` |
| Topology face | `face:{featureId}:{query}` | `face:Extrude0:face0` |

**Behavior**:
- Click on element: Add to selection (or set as sole selection, depending on modifier keys)
- Click on empty space (deselect plane): Clear selection
- Click already-selected element: Remove from selection
- Selection persists across pointer-up events

### Selection Class 2: Dynamic Selection

**Purpose**: Temporary multi-element accumulation while the pointer is held down. Used for alignment-snap inference during drag.

**State**: `dynamicSelection: Set<string>` in the Zustand store, plus `isPointerDown: boolean`.

**Behavior**:
1. `pointerdown`: Set `isPointerDown = true`, mark the clicked element to exclude it
2. `pointermove` while down: As the cursor passes over unselected elements, add them to `dynamicSelection`. Re-hovering an already-selected element removes it (toggle behavior)
3. `pointerup`: Clear `dynamicSelection` and set `isPointerDown = false`. Tools receive their `pointerup` event first, allowing them to read dynamic selection state before it clears

Dynamic selection feeds the alignment-snap system. When `dynamicSelection` is non-empty, the `useDynamicSelectionPositions` hook builds a position map and `detectAlignmentSnap()` checks whether the dragged element is within 15 degrees of horizontal or vertical alignment with any dynamically selected point.

### Selection Class 3: Hover State

**Purpose**: Immediate visual feedback showing which element the cursor is near. Also provides snap target information for drawing tools.

**State**: Multiple fields in the Zustand store:
- `hoveredEntityId: string | null`
- `hoveredVertexId: string | null`
- `hoveredVertexPosition: [number, number] | null`
- `hoveredPlaneId: string | null`
- `hoveredSurfaceId: string | null`
- `hoveredSnapKind: SnapKind | null` (vertex, midpoint, center, path)
- `hoveredPathSnap: { entityId, position } | null`

**Behavior**:
- Each interactive component maintains local `useState(false)` for immediate visual feedback (highlight color, opacity change)
- Simultaneously calls the store setter for logic-level hover state
- Hover state is suppressed while `isRotating` is true
- Hover state provides snap targets to drawing tools (point, line, arc)

### Selection Classes Summary

```
+------------------+------------------+------------------+
| Static Selection | DynamicSelection | Hover State      |
+------------------+------------------+------------------+
| Persists across  | Cleared on       | Cleared on       |
| pointer events   | pointer-up        | pointer-leave     |
+------------------+------------------+------------------+
| Explicit user    | Accumulated by   | Automatic cursor |
| intent           | dragging across  | proximity         |
|                  | elements          |                   |
+------------------+------------------+------------------+
| Drives mutation  | Drives alignment | Drives snap       |
| targets,         | snap inference   | targets, cursor   |
| contextual menus  | during drag     | highlighting     |
+------------------+------------------+------------------+
```

## Layer 4: Tool Layer

Tools build on top of both the navigation and selection abstractions. They receive sanitized pointer events and select which systems to engage.

### Dragging Tool

The drag tool moves existing geometry (vertices, edges, dimension labels) and applies constraints on release.

**Drag initiation flow**:
1. `pointerdown` on vertex or entity hit mesh
2. Store `DragState` with `type`, `vertexId`, `featureId`, `entityId`, `vertexKey`, `startWorld`, `startClient`
3. Disable orbit, set `isPointerDown = true`
4. Mount the `DragPlane` mesh (z=0, 10000x10000)

**Drag move flow**:
1. `pointermove` on DragPlane (manual raycast ignores other geometry)
2. `toLocal()` converts world point to sketch coordinates
3. `findSnapTarget()` checks in priority order:
   - Vertex snap: nearest vertex within 20px
   - Entity snap: nearest point on entity body within 8px
4. If vertex drag with dynamic selection: also check `detectAlignmentSnap()` for horizontal/vertical alignment
5. Update `drag.currentWorld` to snap position or raw position

**Drag end flow**:
1. `pointerup` on DragPlane
2. Read current state from store (not closure)
3. Compute screen pixel distance for click-vs-drag disambiguation
4. If < 4px: pure click (no mutation)
5. If >= 4px: emit mutation based on snap result:
   - Alignment snap -> `move_vertex_with_constraint` (horizontal or vertical)
   - Vertex snap -> `move_vertex_with_constraint` (coincident)
   - Entity snap -> `move_vertex_with_constraint` (coincident on path)
   - No snap -> `move_vertex` with raw coordinates
6. Clear drag state, re-enable orbit

**Collision hiding during drag**: The entity/vertex being dragged has its hit geometry hidden to prevent self-snap. Reference planes and user-defined planes also hide their collision meshes during drag.

### Drawing Tool

Inserts new geometry entities (point, line, arc) via the `DrawPlane` mesh.

**DrawPlane**: A 100000x100000 invisible mesh at z=-0.002, active only when the current tool is a drawing tool.

**Drawing snap priority** (on pointer down):
1. `hoveredVertexPosition` from store (snap to existing vertex)
2. `nearestPointOnEntity` on the hovered entity body
3. Raw cursor position

For two-click tools (line, arc), the first click stores snap references (`drawSnapVertexId`, `drawSnapEntityRef`) so constraints are generated when the second click resolves.

### Constraint Application

Constraints are inferred from snap interactions:

| Snap Kind | Resulting Constraint |
|-----------|---------------------|
| vertex / midpoint | `coincident` |
| path | `coincident` (point-on-entity) |
| kinda_horizontal | `horizontal` |
| kinda_vertical | `vertical` |

The `snapRegistry` defines which snap kinds are valid for each drag type:
- Vertex drag can snap to: vertex, midpoint, path, kinda_horizontal, kinda_vertical
- Edge drag can snap to: path, kinda_horizontal, kinda_vertical

All mutations flow through the `onMutation` callback, which dispatches a `Mutation` object (defined in `types/cad.ts`) to `Part.tsx`, which updates the YAML AST and triggers a backend re-solve.

## Snap System

### Snap Registry

The `SNAP_RULES` map defines allowed snap targets per drag type:

```typescript
SNAP_RULES = {
  vertex: ['vertex', 'midpoint', 'path', 'kinda_horizontal', 'kinda_vertical'],
  entity: ['path', 'kinda_horizontal', 'kinda_vertical'],
}
```

### Alignment Snap (kinda_horizontal / kinda_vertical)

When dynamic selection is active, the system can infer horizontal/vertical alignment with selected elements and auto-apply constraints.

**Trigger conditions**:
- Dynamic selection contains at least one element
- Cursor is within ~15 degrees of horizontal or vertical alignment with a dynamically selected point

**Behavior**:
- `kinda_horizontal`: When cursor angle is within 15° of horizontal (0° or 180°)
- `kinda_vertical`: When cursor angle is within 15° of vertical (90° or 270°)

**Visual feedback**: Dashed white lines (same as `COLOR_PREVIEW`) drawn from the dynamic selection point to the cursor when alignment is detected.

**On completion**: When line insertion or vertex drag completes while alignment snap is active, the corresponding constraint is applied:
- `kinda_horizontal` → `horizontal` constraint
- `kinda_vertical` → `vertical` constraint

### Snap Detection Order

During drag, `findSnapTarget()` checks in this order:
1. Vertex snap: nearest dynamic or existing vertex within `DRAG_SNAP_VERTEX_RADIUS_PX` (20px) world units
2. Entity snap: nearest point on entity body within `DRAG_SNAP_ENTITY_RADIUS_PX` (8px) world units, computed via `nearestPointOnEntity()`

## Collision Hiding Rules

During interactive operations, certain hit geometry must be suppressed to prevent unwanted snap targets:

| Condition | Hidden Geometry | Reason |
|-----------|----------------|--------|
| Entity being dragged | That entity's HitPolylines + hit spheres | Prevent self-snap |
| Vertex being dragged | That vertex's hit sphere | Prevent self-snap |
| Any drag active | Reference plane collision meshes | Prevent accidental plane selection |
| Any drag active | User-defined plane collision meshes | Prevent accidental plane selection |

## Mutation Flow

All state changes to the CAD model follow a unidirectional flow:

```
User interaction (pointer event)
  -> Tool logic (drag/draw/constraint)
  -> Mutation object created
  -> onMutation callback dispatched
  -> Part.tsx receives mutation
  -> YAML AST updated
  -> Backend re-solve triggered
  -> Solved geometry returned
  -> Store updated with new geometry
  -> Scene re-rendered
```

The Zustand store never directly modifies sketch data. It acts purely as a dispatch layer, ensuring all geometry modifications pass through the solver, maintaining consistency.

## Key Constants

| Constant | Value | Purpose |
|----------|-------|---------|
| `HIT_PIXELS` | 8 | Entity hit cylinder radius in screen pixels |
| `POINT_HIT_PIXELS` | 20 | Vertex hit sphere radius in screen pixels |
| `DRAG_SNAP_VERTEX_RADIUS_PX` | 20 | Vertex snap pull zone in screen pixels |
| `DRAG_SNAP_ENTITY_RADIUS_PX` | 8 | Entity snap pull zone in screen pixels |
| `CLICK_THRESHOLD_PX` | 4 | Click-vs-drag disambiguation threshold |
| `ALIGNMENT_TOLERANCE_DEG` | 15 | Horizontal/vertical alignment snap tolerance |
