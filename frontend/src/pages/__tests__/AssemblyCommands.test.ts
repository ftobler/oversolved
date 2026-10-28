import { describe, it, expect, vi } from 'vitest'
import { renderHookStrict } from '@/utils/testing/renderHookStrict'
import { useAssemblyCommands } from '@/pages/AssemblyKeyboardShortcuts'
import {
  ASSEMBLY_COMMAND_NAMES,
  ASSEMBLY_COMMAND_SPECS,
  ASSEMBLY_OPERATION_BY_COMMAND,
  type AssemblyCommandContext,
  type AssemblyCommandName,
} from '@/pages/assemblyCommandEntries'
import { ASSEMBLY_OPERATIONS, type AssemblyOperationId } from '@/utils/assemblyOperations'
import type { CommandRegistry, ErasedCommandSpec } from '@/utils/core/commandSpec'
import { CommandRegistry as Registry } from '@/utils/core/commandSpec'
import { assemblyContext, minimalAssemblyParams } from './commandFixtures'

// The page's inputs, with spies for everything but the id mint. Running the
// specs through the same table the page registers is what lets the coverage
// test observe the real command-to-operation wiring.
function deps() {
  const runOperation = vi.fn()
  const deleteSubject = vi.fn()
  const manipulationLive = vi.fn(() => false)
  const cancelManipulation = vi.fn()
  const undo = vi.fn()
  const cancelEdit = vi.fn()
  const context = assemblyContext({
    runOperation: runOperation as unknown as AssemblyCommandContext['runOperation'],
    deleteSubject,
    manipulationLive,
    cancelManipulation,
    undo,
    cancelEdit,
  })
  const registry = new Registry<AssemblyCommandContext>(() => context)
  for (const spec of ASSEMBLY_COMMAND_SPECS) registry.register(spec)
  return { context, registry, runOperation, deleteSubject, manipulationLive, cancelManipulation, undo, cancelEdit }
}

function execute(name: AssemblyCommandName, registry: CommandRegistry<AssemblyCommandContext>) {
  return registry.execute(name, minimalAssemblyParams(name))
}

describe('ASSEMBLY_COMMAND_SPECS', () => {
  it('has one spec per canonical name, all unique, stable across builds', () => {
    const ids = ASSEMBLY_COMMAND_SPECS.map(s => s.id)
    expect(ids).toEqual([...ASSEMBLY_COMMAND_NAMES])
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('every spec carries a label, an enabled predicate and a params schema', () => {
    for (const spec of ASSEMBLY_COMMAND_SPECS as readonly ErasedCommandSpec<AssemblyCommandContext>[]) {
      expect(spec.label.length, `label missing for "${spec.id}"`).toBeGreaterThan(0)
      expect(typeof spec.enabled).toBe('function')
      expect(typeof spec.params.parse).toBe('function')
    }
  })
})

describe('useAssemblyCommands', () => {
  it('registers a spec for every command with no executeCommand warning', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const registry = new Registry<AssemblyCommandContext>(() => assemblyContext())
    renderHookStrict(() => useAssemblyCommands(registry))
    for (const name of ASSEMBLY_COMMAND_NAMES) registry.execute(name, minimalAssemblyParams(name))
    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})

describe('assembly operation coverage', () => {
  // Every operation must be reachable from the specs the page actually
  // registers, not merely present in the documentation map. The delete commands
  // reach their operation through the store's `deleteSubject` (which runs the
  // operation cell), so that hand-off is what this asserts.
  it('executing the specs reaches every operation', () => {
    const d = deps()
    for (const name of ASSEMBLY_COMMAND_NAMES) {
      const result = execute(name, d.registry)
      expect(result.ok, `command "${name}" failed: ${result.ok ? '' : result.message}`).toBe(true)
    }
    const invoked = new Set(d.runOperation.mock.calls.map(call => call[0] as AssemblyOperationId))
    // The delete commands hand off to the one store delete action; its spy
    // stands in for the delete_part/delete_mate operation reach.
    expect(d.deleteSubject).toHaveBeenCalledWith(expect.objectContaining({ kind: 'part' }))
    expect(d.deleteSubject).toHaveBeenCalledWith(expect.objectContaining({ kind: 'mate' }))
    invoked.add('delete_part')
    invoked.add('delete_mate')
    // set_mate_ref is the editor's aim-commit write (the store calls it when a
    // mate chip commits a pick), not a command: the command table inserts the
    // mate and opens its editor, and the pick is what writes the reference.
    invoked.add('set_mate_ref')
    for (const id of Object.keys(ASSEMBLY_OPERATIONS) as AssemblyOperationId[]) {
      expect(invoked.has(id), `operation "${id}" is not wired to any command`).toBe(true)
    }
  })

  it('each mutating command runs the operation the map names', () => {
    for (const [command, operation] of Object.entries(ASSEMBLY_OPERATION_BY_COMMAND)) {
      const d = deps()
      execute(command as AssemblyCommandName, d.registry)
      const invoked = d.runOperation.mock.calls.map(call => call[0])
      expect(invoked, `command "${command}"`).toContain(operation)
    }
  })

  // The delete commands are the one pair that does not call runOperation
  // directly: they must both route through the store's deleteSubject, so the
  // tree row and the [Delete] key share one implementation.
  it('the delete commands delegate to the one deleteSubject action', () => {
    const d = deps()
    execute('delete_part', d.registry)
    execute('delete_mate', d.registry)
    expect(d.deleteSubject).toHaveBeenNthCalledWith(1, { kind: 'part', handle: 'handle-1' })
    expect(d.deleteSubject).toHaveBeenNthCalledWith(2, { kind: 'mate', id: 'mate-1' })
    expect(d.runOperation).not.toHaveBeenCalled()
  })

  // Ctrl+Z during a live drag used to pop the entry above it while
  // resetTransientAssemblyState silently abandoned the gesture behind the
  // user's back: two changes from one press. The part editor fixed this class
  // by giving undo a cancel-the-gesture first stage; assembly's takes the same
  // shape, tearing the drag down through the store's own cancel path.
  it('undo cancels a live manipulation instead of popping history', () => {
    const d = deps()
    d.manipulationLive.mockReturnValue(true)
    execute('undo', d.registry)
    expect(d.cancelManipulation).toHaveBeenCalledTimes(1)
    expect(d.undo).not.toHaveBeenCalled()
  })

  it('undo pops history once no manipulation is in flight', () => {
    const d = deps()
    d.manipulationLive.mockReturnValue(false)
    execute('undo', d.registry)
    expect(d.undo).toHaveBeenCalledTimes(1)
    expect(d.cancelManipulation).not.toHaveBeenCalled()
  })

  // Escape keeps its own meaning: it closes the open editor and never touches a
  // drag, which is the viewport's listener's job.
  it('cancel_edit leaves the manipulation cancel path alone', () => {
    const d = deps()
    execute('cancel_edit', d.registry)
    expect(d.cancelEdit).toHaveBeenCalledTimes(1)
    expect(d.cancelManipulation).not.toHaveBeenCalled()
  })
})
