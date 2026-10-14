import { PART_COMMAND_SPECS, type PartCommandContext } from '@/pages/commandEntries'
import { useCommandRegistration } from '@/pages/hooks/useCommandRegistration'
import { executeCommand } from '@/utils/core/commandRegistry'
import type { CommandRegistry } from '@/utils/core/commandSpec'

/**
 * Installs the sketch/part command table on the page's registry and attaches
 * the keydown listener. The registry is built by the page around its live
 * command context; this hook only installs it and registers the static specs.
 */
export function usePartCommands(registry: CommandRegistry<PartCommandContext>) {
  useCommandRegistration('part', registry, PART_COMMAND_SPECS)
  return { executeCommand }
}
