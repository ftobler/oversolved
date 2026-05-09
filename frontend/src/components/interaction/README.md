# Interaction Module

This module provides shared hooks for viewport interaction.

## Files

### index.ts

Re-exports `useDynamicSelectionPositions` from `snapHooks`.

### snapHooks.ts, useAlignmentSnapEffect.ts

Hooks for snap detection and alignment during drag/draw operations.

## Single Source of Truth

Tool handler contracts are defined in `registry/toolRegistry.ts` (`ToolHandlers`).
All tools implement this interface. See `tools/` directory for implementations.
