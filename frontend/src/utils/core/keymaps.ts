// Key binding tables are data, kept in the core so a headless command table can
// read the shortcuts without importing the editor registry (which resolves the
// active editor from the stores). The dispatch runtime lives in
// hooks/commandRegistry.

import { CONSTRAINT_SHORTCUTS, ENTITY_SHORTCUTS } from '@/registry'
import type { CommandName } from '@/utils/core/commandNames'

export type CoreKeybinding = {
  // Canonical key string, e.g. "ctrl+z".
  key: string
  // Command name, e.g. "undo". Checked against COMMAND_NAMES.
  command: CommandName
  // Human-readable label for the Registry page.
  label: string
  // Short description for the Registry page.
  description: string
}

// Core (non-constraint) keybindings with labels and descriptions.
export const CORE_KEYBINDINGS: readonly CoreKeybinding[] = [
  { key: 'ctrl+z',       command: 'undo',                label: 'Undo',                description: 'Undo the last sketch change' },
  { key: 'ctrl+shift+z', command: 'redo',                label: 'Redo',                description: 'Redo the last undone change' },
  { key: 'ctrl+y',       command: 'redo',                label: 'Redo (alt)',           description: 'Redo the last undone change' },
  { key: 'delete',       command: 'delete_selected',     label: 'Delete',              description: 'Delete selected entities or constraints' },
  { key: 'backspace',    command: 'delete_selected',     label: 'Delete (alt)',         description: 'Delete selected entities or constraints' },
  { key: 'd',            command: 'set_tool_dimension',  label: 'Dimension tool',       description: 'Activate the dimension tool' },
  { key: 'q',            command: 'toggle_construction', label: 'Toggle construction',  description: 'Toggle construction mode for selected entities' },
  { key: 'shift+m',      command: 'mirror_entities',     label: 'Mirror selection',     description: 'Mirror selected entities across the selected line' },
  { key: 'shift+f',      command: 'fillet_corners',      label: 'Fillet corners',       description: 'Round the selected sketch corners' },
  { key: 'shift+s',      command: 'set_tool_split',      label: 'Split tool',           description: 'Cut a sketch curve at the clicked point (a circle at two)' },
  { key: 'shift+p',      command: 'pattern_entities',    label: 'Pattern entities',     description: 'Repeat the selected sketch entities along X' },
  { key: 'y',            command: 'toggle_sketch_plane_visibility', label: 'Toggle reference geometry', description: 'Hide or show all sketch, plane and helix features' },
  { key: 'e',            command: 'add_extrude',          label: 'Add Extrude',         description: 'Add a new extrude feature (feature mode only)' },
  { key: 'p',            command: 'toggle_plane_visibility', label: 'Toggle planes',    description: 'Hide or show all plane features' },
  { key: 'escape',       command: 'cancel_draw',         label: 'Cancel',              description: 'Cancel the entity being drawn, or release the tool when nothing is in progress' },
]

// Commands the browser itself owns: Ctrl+C and Ctrl+V must reach the native
// copy and paste events, so these rows are listed for the keyboard help but are
// deliberately absent from every keymap. dispatchKey therefore never sees them
// and never calls preventDefault; useSketchClipboard's document listeners are
// the handlers. A name here is not a COMMAND_NAMES entry: it is the browser's
// action, not a registry command.
export type NativeCommandName = 'copy_sketch_selection' | 'paste_sketch_clipboard'

export interface NativeKeybinding {
  key: string
  command: NativeCommandName
  label: string
  description: string
}

export const NATIVE_KEYBINDINGS: readonly NativeKeybinding[] = [
  { key: 'ctrl+c', command: 'copy_sketch_selection', label: 'Copy', description: 'Copy selected sketch entities to the clipboard' },
  { key: 'ctrl+v', command: 'paste_sketch_clipboard', label: 'Paste', description: 'Paste sketch entities from the clipboard' },
]

// Derive the flat key->command record from CORE_KEYBINDINGS.
const CORE_KEYMAP: Record<string, CommandName> =
  Object.fromEntries(CORE_KEYBINDINGS.map(b => [b.key, b.command]))

// Merge core bindings with registry-derived shortcuts.
// Constraint shortcuts take precedence over CORE_KEYBINDINGS (last wins).
export const KEYMAP: Record<string, CommandName> = {
  ...CORE_KEYMAP,
  ...Object.fromEntries(CONSTRAINT_SHORTCUTS),
  ...Object.fromEntries(ENTITY_SHORTCUTS),
}

// Keys that are only active outside of sketch-edit mode.
// These override KEYMAP entries when no sketch is being edited.
// `e` is the only genuine mode split: in a sketch it applies the equal
// constraint, outside one it adds an extrude.
export const FEATURE_KEYMAP: Record<string, CommandName> = {
  'e': 'add_extrude',
}

// Keys that are only active inside sketch-edit mode.
// These take precedence over KEYMAP entries when a sketch is being edited.
// The one genuine sketch-only binding is Enter (finish the gesture being drawn):
// outside a sketch Enter must keep activating a focused button, so it cannot
// live in CORE_KEYBINDINGS where every mode would intercept it. An entry here
// silently shadows KEYMAP, so only add one that really differs.
export const SKETCH_KEYBINDINGS: readonly CoreKeybinding[] = [
  { key: 'enter', command: 'finish_draw', label: 'Finish drawing', description: 'Stamp down the spline being drawn; a click on its last point does the same' },
]

export const SKETCH_KEYMAP: Record<string, CommandName> =
  Object.fromEntries(SKETCH_KEYBINDINGS.map(b => [b.key, b.command]))

// Assembly keymap, the only table consulted while WorkspacePage says the assembly
// editor is active. It ships the shared keys (undo/redo/delete, including their alt
// bindings, plus Escape to cancel the open edit); no assembly-specific key is
// invented here. Every shared key is listed so this table is the single source
// of what the assembly editor does, rather than a fallthrough to KEYMAP.
//
// Policy: the app default IS the user's workflow default. Whenever a shortcut
// is later requested, it is added here as the new default, and users remain free
// to override it.
export const ASSEMBLY_KEYBINDINGS: readonly CoreKeybinding[] = [
  { key: 'ctrl+z',       command: 'undo',            label: 'Undo',         description: 'Undo the last assembly change' },
  { key: 'ctrl+shift+z', command: 'redo',            label: 'Redo',         description: 'Redo the last undone assembly change' },
  { key: 'ctrl+y',       command: 'redo',            label: 'Redo (alt)',   description: 'Redo the last undone assembly change' },
  { key: 'delete',       command: 'delete_selected', label: 'Delete',       description: 'Delete the selected part or mate' },
  { key: 'backspace',    command: 'delete_selected', label: 'Delete (alt)', description: 'Delete the selected part or mate' },
  { key: 'escape',       command: 'cancel_edit',     label: 'Cancel edit',  description: 'Close the open part or mate editor' },
]

export const ASSEMBLY_KEYMAP: Record<string, CommandName> =
  Object.fromEntries(ASSEMBLY_KEYBINDINGS.map(b => [b.key, b.command]))
