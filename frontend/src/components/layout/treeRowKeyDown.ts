import type { KeyboardEvent as ReactKeyboardEvent } from 'react'

// Enter/Space on a focused tree row activates it, the same guard AssemblyTree
// uses. Only the row itself reacts: a key bubbling from a control inside the row
// must not re-open the entry the control belongs to.
export function treeRowKeyDown<T extends HTMLElement>(e: ReactKeyboardEvent<T>, activate: () => void): void {
  if (e.target !== e.currentTarget) return
  if (e.key !== 'Enter' && e.key !== ' ') return
  e.preventDefault()
  e.stopPropagation()
  activate()
}
