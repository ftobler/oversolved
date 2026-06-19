# Interaction Module

This module provides shared hooks for viewport interaction.

## Files

### useAlignmentSnapEffect.ts

Hook for snap detection and alignment during drag/draw operations.

### useSelectionPointerUpCleanup.ts

Pointer-up safety net that clears leftover/stuck drag state so the camera
recovers (e.g. when a document load remounts the DragPlane mid-gesture).

## Single Source of Truth

Tool handler contracts are defined in `registry/toolRegistry.ts` (`ToolHandlers`).
All tools implement this interface. See `tools/` directory for implementations.

## Wiring Mechanisms

The frontend uses four mechanisms to connect behaviour and state across layers.
Choose the one that matches the coupling you need:

### 1. React props

Use for: layout components receiving ephemeral parent-owned state directly.

Rule: prefer this when the consumer is a direct child and the data is
short-lived or rendering-scoped (e.g. dimensions of a panel, a single boolean flag).

### 2. Zustand stores (`sketchEditorStore`, `partEditorStore`, `solverStore`)

Use for: cross-cutting reactive state that must be readable from pure-logic
files (tools, store actions, utilities) without importing React hooks.

Rule: any file that needs to read or write global UI state but cannot be a
React hook should use a Zustand store. Pure-logic files (no Three.js, no
R3F hooks) may import and subscribe to stores directly.

### 3. Module-level callback slots (`_sketchCbs`)

Location: `stores/sketchEditorStore.ts`, registered via `setSketchCallback()`.

Use for: pure store actions that need to dispatch *back* into React-owned state
(mutations, rebuilds, sketch exit). The pure-layer rule forbids importing
React hooks or calling `usePartDoc` from a store, so this bridge fills the gap.

Rule: use only when the call direction is pure-layer -> React layer and
neither props nor a Zustand store can carry the signal.

Lifecycle invariant: all slots are registered by Part.tsx on mount and cleared
on unmount. Tests must call `setSketchCallback()` before exercising any store
action that invokes a guarded callback -- failing to do so throws in test mode.

### 4. React Context (`PartEditorContext`)

Use for: callback bags that a tree of editor panels (FeatureTree, editors)
must share without prop drilling, where the bag is owned by the page
component and changes infrequently.

Rule: use when you have multiple cousins deep in the component tree that all
need the same callback and Zustand would be overkill (the callback closes over
local state that cannot live in a store).
