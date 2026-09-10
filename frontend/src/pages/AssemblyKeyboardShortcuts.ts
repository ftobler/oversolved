import { useMemo } from 'react'
import { buildAssemblyCommandEntries, type AssemblyCommandHandlers } from '@/pages/assemblyCommandEntries'
import { useCommandRegistration } from '@/pages/hooks/useCommandRegistration'
import { executeCommand } from '@/utils/core/commandRegistry'

/**
 * Registers every assembly command and attaches the keydown listener. Mirrors
 * `usePartCommands`: the caller passes stable (useCallback/useMemo wrapped)
 * handlers so the command list is only rebuilt when a handler identity changes.
 */
export function useAssemblyCommands(handlers: AssemblyCommandHandlers) {
  const commands = useMemo(() => buildAssemblyCommandEntries(handlers), [handlers])
  useCommandRegistration(commands)
  return { executeCommand }
}
