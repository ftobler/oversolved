import { expect, vi } from 'vitest'
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { executeCommand } from '@/utils/core/commandRegistry'
import { useWorkspaceSessionStore } from '@/stores/workspaceSessionStore'
import AssemblyEditor from '@/pages/AssemblyEditor'
import { ToastProvider } from '@/contexts/ToastContext'

// Shared render and setup for the AssemblyEditor suites. The page-level mocks
// stay in each suite file, because vi.mock is hoisted per test file; this module
// holds the mock-free parts so they are not copied into every sibling.

export type HarnessListEntry = { uuid: string; name: string; kind?: string; meta?: { rev: number } }

export const tick = () => act(async () => { await new Promise(r => setTimeout(r, 0)) })

// The export dialog notifies on failure, so the page needs a toast host, exactly
// as it has under `main.tsx`.
export function renderEditor() {
  return render(<ToastProvider><AssemblyEditor uuid="asm-1" /></ToastProvider>)
}

// The editor reads its part names and the picker's source from the open
// workspace session. These suites shape `h.list`; the session reads it live, so
// a per-test reassignment is reflected without changing the harness.
export function installSessionFromList(h: { list: HarnessListEntry[] }) {
  useWorkspaceSessionStore.setState({
    session: {
      workspace: 'asm-1',
      listEntries: async () => h.list.map(d => ({
        id: d.uuid,
        path: `documents/${d.name}.yaml`,
        kind: 'document' as const,
        name: d.name,
        docKind: d.kind,
        rev: d.meta?.rev,
      })),
      readEntry: vi.fn(),
      writeEntry: vi.fn(),
      resolveFile: vi.fn(),
      referencesOf: vi.fn(),
      referenceEdges: vi.fn(async () => ({})),
      savedRevs: async () => new Map(),
    },
  })
}

// The tree labels an instance by its document name, so a same-named part already
// in the tree collides with the picker item text. Scope the lookup to the picker
// so a second insert of the same part still finds the right node.
export function pickerItem(name: string) {
  return screen.getAllByText(name).find(el => el.closest('.doc-browser-tile'))
}

export async function insertPart(name: string) {
  act(() => { executeCommand('insert_part_instance') })
  // Picker lists owned docs (minus the assembly itself).
  await waitFor(() => expect(pickerItem(name)).toBeTruthy())
  fireEvent.click(pickerItem(name)!)
  fireEvent.click(screen.getByRole('button', { name: 'Insert' }))
  await tick()
}

// An open assembly edit draws its OK/Cancel pair at both ends: the edited tree
// row keeps the pair it always had, and the right card carries a second one. A
// bare getByRole would now match two buttons, so a page test says which end it
// means. Both ends call the same handlers; these helpers only pick the node.
export function rowAction(name: 'OK' | 'Cancel'): HTMLElement {
  const row = document.querySelector('.feature-item.editing')
  if (!row) throw new Error('no edited tree row is open')
  return within(row as HTMLElement).getByRole('button', { name })
}

export function cardAction(name: 'OK' | 'Cancel'): HTMLElement {
  const card = document.querySelector('.feature-edit-panel')
  if (!card) throw new Error('no assembly edit card is open')
  return within(card as HTMLElement).getByRole('button', { name })
}
