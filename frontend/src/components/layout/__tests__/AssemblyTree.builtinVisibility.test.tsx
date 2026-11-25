// The origin is the assembly's always-drawn datum, so its tree row must not
// offer the eye that could claim to hide it. The planes keep theirs.
import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'
import { AssemblyDocumentPanel } from '@/components/layout/AssemblyDocumentPanel'
import type { AssemblyBuiltinListItem } from '@/utils/assemblyRender'

const noop = () => {}

const builtins: AssemblyBuiltinListItem[] = [
  { id: 'AssemblyOrigin', kind: 'origin', label: 'Origin', visible: true },
  { id: 'AssemblyTop', kind: 'plane', label: 'Top', visible: false },
]

function renderTree(onToggleBuiltinVisible = noop) {
  return render(
    <AssemblyDocumentPanel
      instances={[]}
      builtins={builtins}
      mates={[]}
      onOpenPartNewTab={noop}
      onDuplicateInstance={noop}
      onDeleteInstance={noop}
      onToggleVisible={noop}
      onToggleFixed={noop}
      onToggleBuiltinVisible={onToggleBuiltinVisible}
      onEditInstance={noop}
      onCommitInstance={noop}
      onCancelInstance={noop}
      onCommitMate={noop}
      onCancelMate={noop}
      onDeleteMate={noop}
      onRequestRenameMate={noop}
    />,
  )
}

function rowByLabel(container: HTMLElement, label: string): HTMLElement {
  const row = [...container.querySelectorAll('.feature-item.builtin')].find(
    r => r.querySelector('.feature-name')?.textContent === label,
  ) as HTMLElement | undefined
  expect(row, `row "${label}"`).toBeDefined()
  return row!
}

describe('AssemblyTree built-in rows', () => {
  it('draws no eye and no invisible mark on the origin row', () => {
    const { container } = renderTree()
    const origin = rowByLabel(container, 'Origin')
    expect(origin.querySelector('.feature-visibility-btn')).toBeNull()
    expect(origin.classList.contains('invisible')).toBe(false)
  })

  it('keeps the eye on a plane row and writes the show through the callback', () => {
    const onToggle = vi.fn()
    const { container } = renderTree(onToggle)
    const top = rowByLabel(container, 'Top')
    expect(top.classList.contains('invisible')).toBe(true)
    const eye = top.querySelector('.feature-visibility-btn') as HTMLButtonElement
    expect(eye).not.toBeNull()
    expect(eye.getAttribute('aria-label')).toBe('Show Top')
    eye.click()
    expect(onToggle).toHaveBeenCalledWith('AssemblyTop', true)
  })
})
