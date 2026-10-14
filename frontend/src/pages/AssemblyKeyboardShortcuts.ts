import { ASSEMBLY_COMMAND_SPECS, type AssemblyCommandContext } from '@/pages/assemblyCommandEntries'
import { useCommandRegistration } from '@/pages/hooks/useCommandRegistration'
import type { CommandRegistry } from '@/utils/core/commandSpec'

/**
 * Installs the assembly command table on the page's registry and attaches the
 * keydown listener. Mirrors `usePartCommands`: the caller builds the registry
 * around its live context, so this hook only installs it and registers the
 * static specs. Callers dispatch with the shared `executeCommand` from the
 * registry.
 */
export function useAssemblyCommands(registry: CommandRegistry<AssemblyCommandContext>): void {
  useCommandRegistration('assembly', registry, ASSEMBLY_COMMAND_SPECS)
}
