import { createContext, useContext, useMemo } from 'react'
import { CommandRegistry, type CommandContext, type CommandTableView } from '@/utils/core/commandSpec'

// The mounted editor's command registry, injected so toolbars can read the
// enabled verdict from the same table the commands run from instead of
// recomputing disabled state from stores. Stored as the context-free view so
// each page's registry keeps its own context type. The provider is the bare
// context Provider (the PartEditorContext pattern), which keeps this file's
// non-component exports fast-refresh friendly.
const CommandRegistryValues = createContext<CommandTableView | null>(null)

export const CommandRegistryProvider = CommandRegistryValues.Provider

export function useCommandRegistry(): CommandTableView {
  const registry = useContext(CommandRegistryValues)
  if (!registry) throw new Error('useCommandRegistry must be used inside CommandRegistryProvider')
  return registry
}

/**
 * One registry whose context getter reads the context its page built this
 * render. The registry is rebuilt when the context identity changes (a page
 * callback changed, e.g. after a document load), which re-registers the static
 * spec table on the new instance: the table is data, so that costs a map swap,
 * and it keeps enabled() reading live values without a ref write in render.
 */
export function useCommandRegistryWithContext<Ctx extends CommandContext>(context: Ctx): CommandRegistry<Ctx> {
  return useMemo(() => new CommandRegistry<Ctx>(() => context), [context])
}
