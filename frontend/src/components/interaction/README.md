# Interaction Module

This module provides reusable abstractions for building UI interaction handlers.

## Purpose

Extract common patterns for click/drag event handlers used in the sketch editor. This clarifies the boundary between:
- **UI rendering** (Three.js meshes, React components)
- **Interaction logic** (event handlers that call store actions)

## Input Abstraction

All handlers use `PointerEvent`, the modern unified API for mouse, touch, and stylus input. The browser automatically converts touch and stylus input to `PointerEvent`, so no separate `TouchEvent` or `MouseEvent` handling is required.

Key conventions:
- Check `e.isPrimary` to ignore secondary pointers (multi-touch).
- Distinguish taps from drags via movement threshold (`CLICK_THRESHOLD_PX`).
- Prevent default browser touch behaviors with `touch-action: none` on interactive containers.

## Files

### interaction-actions.ts

Type definitions for:
- `DragInit` — Drag state captured at pointer-down
- `InteractionHandlers` — Handler function signatures
- `ToolHandlerContract` — Contract describing what a tool needs

### handler-helpers.ts

Utility functions to build handlers:
- `buildClickHandler` — Builds click handler with dimension/field-pick/select logic
- `buildDragPointerDownHandler` — Builds drag initiation handler
- `buildDragPointerUpHandler` — Builds click-vs-drag threshold handler
- `buildPointerOverHandler` — Builds hover handler
- `buildDimensionClickHandler` — Builds dimension tool click handler

### index.ts

Re-exports from the module.

## Usage

```typescript
import {
  buildClickHandler,
  buildDragPointerDownHandler,
} from '@components/interaction'

// In a component:
const onClick = buildClickHandler(
  handleDimensionClick,
  toggleSelect,
  fieldPickState,
  commitFieldPick,
  isEditing,
)

const onPointerDown = buildDragPointerDownHandler(
  setDrag,
  setOrbitEnabled,
  isEditing,
  activeTool,
)
```

## Handler Contracts Registry

The `ToolHandlerContract` interface documents what each tool expects from its handlers. A future registry could list all drawing tools with their required handlers, similar to `CONSTRAINTS` and `ENTITIES` registries.

Example contract:

```typescript
{
  toolKind: 'line'
  onPointerDown: (e, worldPt) => dragInit | null
  onPointerMove?: (e, worldPt, drag) => void
  onPointerUp: (e, worldPt, drag, ...) => void
  onPointerOver: (e, ...) => void
}
```

## Testing

Tests are in `__tests__/handler-helpers.test.ts`. They verify:
- Handler functions return correct closures
- Early return conditions work
- Click-vs-drag threshold behavior
- Field pick / dimension click delegation

## Backward Compatibility

Components can continue using inline handlers without updating. This module is **optional** and components opt-in by using the helper functions.
