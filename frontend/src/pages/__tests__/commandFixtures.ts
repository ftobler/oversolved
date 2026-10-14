import { CommandRegistry } from '@/utils/core/commandSpec'
import { clearEditorCommandRegistry, setEditorCommandRegistry } from '@/utils/core/commandRegistry'
import { getSketchState, PART_COMMAND_SPECS, type PartCommandContext } from '@/pages/commandEntries'
import { ASSEMBLY_COMMAND_SPECS, type AssemblyCommandContext } from '@/pages/assemblyCommandEntries'
import type { DocSession } from '@/session/DocSession'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { useAssemblyStore } from '@/stores/assemblyStore'

// Fixture contexts and registries for the command-table suites. The part
// context reads the real L2 stores (they run headless), so command bodies are
// exercised against real state; the assembly context is all stubs, since the
// page's wiring is callbacks only.

export function partContext(overrides: Partial<PartCommandContext> = {}): PartCommandContext {
  return {
    editor: 'part',
    session: null,
    state: getSketchState,
    undo: () => {},
    redo: () => {},
    deleteSelectedFeatures: () => {},
    toggleSketchPlaneVisibility: () => {},
    togglePlaneVisibility: () => {},
    addFeature: () => null,
    showMessage: () => {},
    ...overrides,
  }
}

export function assemblyContext(overrides: Partial<AssemblyCommandContext> = {}): AssemblyCommandContext {
  return {
    editor: 'assembly',
    runOperation: () => {},
    undo: () => {},
    redo: () => {},
    deleteSelected: () => {},
    cancelEdit: () => {},
    openInsertPart: () => {},
    openExport: () => {},
    mintMateId: () => 'mate-new',
    closeOpenEditor: () => {},
    onMateInserted: () => {},
    deleteSubject: () => {},
    manipulationLive: () => false,
    cancelManipulation: () => {},
    undoDepth: () => 0,
    redoDepth: () => 0,
    ...overrides,
  }
}

// A part context whose undo/redo availability comes from the store mirror the
// toolbars render from (the production page reads the session). Standalone
// toolbar tests seed the mirror and expect the enabled verdicts to follow.
export function sessionBackedPartContext(overrides: Partial<PartCommandContext> = {}): PartCommandContext {
  const session = {
    historyEntries: () => ({
      undo: usePartEditorStore.getState().undoStack,
      redo: usePartEditorStore.getState().redoStack,
    }),
  } as unknown as DocSession
  return partContext({ session, ...overrides })
}

export function storeBackedAssemblyContext(overrides: Partial<AssemblyCommandContext> = {}): AssemblyCommandContext {
  return assemblyContext({
    undoDepth: () => useAssemblyStore.getState().undoStack.length,
    redoDepth: () => useAssemblyStore.getState().redoStack.length,
    ...overrides,
  })
}

export function partRegistry(context: PartCommandContext = partContext()): CommandRegistry<PartCommandContext> {
  const registry = new CommandRegistry<PartCommandContext>(() => context)
  for (const spec of PART_COMMAND_SPECS) registry.register(spec)
  return registry
}

export function assemblyRegistry(context: AssemblyCommandContext = assemblyContext()): CommandRegistry<AssemblyCommandContext> {
  const registry = new CommandRegistry<AssemblyCommandContext>(() => context)
  for (const spec of ASSEMBLY_COMMAND_SPECS) registry.register(spec)
  return registry
}

// Installs the registry as the module-level part table, the way a mounted page
// does, so executeCommand/dispatchKey resolve to the real specs.
export function installPartRegistry(context: PartCommandContext = partContext()): { registry: CommandRegistry<PartCommandContext>; uninstall: () => void } {
  const registry = partRegistry(context)
  setEditorCommandRegistry('part', registry)
  return { registry, uninstall: () => clearEditorCommandRegistry('part', registry) }
}

export function installAssemblyRegistry(context: AssemblyCommandContext = assemblyContext()): { registry: CommandRegistry<AssemblyCommandContext>; uninstall: () => void } {
  const registry = assemblyRegistry(context)
  setEditorCommandRegistry('assembly', registry)
  return { registry, uninstall: () => clearEditorCommandRegistry('assembly', registry) }
}

// The minimal well-formed payload per command. Commands with no params are
// absent: execute passes undefined and noParams accepts it.
const PART_PARAMS: Readonly<Record<string, unknown>> = {
  apply_offset: { distance: 5 },
}

const ASSEMBLY_PARAMS: Readonly<Record<string, unknown>> = {
  add_part: { docId: 'part-1', docRev: 1 },
  duplicate_part: 'handle-1',
  delete_part: 'handle-1',
  set_part_visible: { handle: 'handle-1', visible: true },
  set_builtin_visible: { id: 'origin', visible: true },
  set_part_fixed: { handle: 'handle-1', fixed: true },
  set_part_fixed_oneshot: { handle: 'handle-1', fixed: false },
  set_part_position: { handle: 'handle-1', pos: { tx: 0, ty: 0, tz: 0 } },
  set_part_rotation: { handle: 'handle-1', euler: { rx: 0, ry: 0, rz: 0 } },
  delete_mate: 'mate-1',
  update_mate: { id: 'mate-1', patch: { flip: true } },
  reorder_part: { movingHandle: 'handle-1', beforeHandle: null },
  reorder_mate: { movingId: 'mate-1', beforeId: null },
  rename_mate: { id: 'mate-1', label: null },
}

export function minimalPartParams(name: string): unknown {
  return PART_PARAMS[name]
}

export function minimalAssemblyParams(name: string): unknown {
  return ASSEMBLY_PARAMS[name]
}
