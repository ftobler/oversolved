// The assembly navigator is two floating glass cards (floating-panels phase 2),
// the part editor's Features/Parts pair in assembly terms. The splitter and the
// row-inline editor are gone: the row keeps its editing highlight and its own
// OK/Cancel pair, and the form lives in the right card (AssemblyEditPanel.tsx).
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { AssemblyDocumentPanel } from '@/components/layout/AssemblyDocumentPanel'
import type { PartInstance, MateFeature } from '@/types/cad'
import { IDENTITY_TRANSFORM } from '@/utils/transform3d'

const instances: PartInstance[] = [
  { handle: 'p1', doc_id: 'doc-p1', doc_rev: 1, transform: { ...IDENTITY_TRANSFORM }, visible: true },
]
const mates: MateFeature[] = [
  { id: 'm1', mate: { kind: 'fixed', label: 'Fixed 1', ref_a: { part: 'p1', anchor: 'a1' }, ref_b: { part: 'p2', anchor: 'b1' } } },
]

const noop = () => {}

function renderPanel(props: Partial<React.ComponentProps<typeof AssemblyDocumentPanel>> = {}) {
  return render(
    <AssemblyDocumentPanel
      instances={instances}
      builtins={[]}
      mates={mates}
      onOpenPartNewTab={noop}
      onDuplicateInstance={noop}
      onDeleteInstance={noop}
      onToggleVisible={noop}
      onToggleFixed={noop}
      onToggleBuiltinVisible={noop}
      onEditInstance={noop}
      onCommitInstance={noop}
      onCancelInstance={noop}
      onCommitMate={noop}
      onCancelMate={noop}
      onDeleteMate={noop}
      onRequestRenameMate={noop}
      {...props}
    />,
  )
}

describe('AssemblyDocumentPanel cards', () => {
  it('stacks the Parts over Mates as glass cards in one document panel', () => {
    const { container } = renderPanel()
    const panel = container.querySelector('.document-panel') as HTMLElement
    expect(panel).not.toBeNull()
    expect(panel.children).toHaveLength(2)

    const [parts, matesCard] = [...panel.children] as HTMLElement[]
    expect(parts).toHaveClass('sidebar-top', 'glass-panel', 'assembly-panel')
    expect(matesCard).toHaveClass('sidebar-bottom', 'glass-panel', 'assembly-panel')
    expect(parts.querySelector('.sidebar-header')!.textContent).toBe('Parts')
    expect(matesCard.querySelector('.sidebar-header')!.textContent).toBe('Mates')
    // Each list belongs to its own card, not to a shared column.
    expect(parts.querySelector('[role="listbox"]')!.getAttribute('aria-label')).toBe('Parts')
    expect(matesCard.querySelector('[role="listbox"]')!.getAttribute('aria-label')).toBe('Mates')
  })

  it('keeps the edited row as a highlight and an OK/Cancel pair, with no form in it', () => {
    const { container } = renderPanel({ editingInstanceHandle: 'p1' })
    const row = container.querySelector('.feature-item.editing') as HTMLElement
    expect(row).not.toBeNull()
    expect(row.querySelector('button[title="OK"]')).not.toBeNull()
    expect(row.querySelector('button[title="Cancel"]')).not.toBeNull()
    expect(row.querySelector('input, select, .instance-editor, .status-message')).toBeNull()
  })

  it('keeps the edited mate row the same way', () => {
    const { container } = renderPanel({ editingMateId: 'm1' })
    const row = container.querySelector('.feature-item.editing') as HTMLElement
    expect(row.querySelector('button[title="OK"]')).not.toBeNull()
    expect(row.querySelector('button[title="Cancel"]')).not.toBeNull()
    expect(row.querySelector('input, select, .mate-editor, .status-message')).toBeNull()
  })

  it('draws no splitter and reserves each card height through the shared classes', () => {
    const { container } = renderPanel()
    expect(container.querySelector('.resize-handle')).toBeNull()
    expect(container.querySelector('[role="slider"]')).toBeNull()
    for (const card of container.querySelectorAll('.assembly-panel')) {
      // The height share is the panel's flex rules, never an inline style.
      expect(card.getAttribute('style')).toBeNull()
    }
  })

  it('still exposes both lists as listboxes with the row options inside', () => {
    renderPanel()
    const lists = screen.getAllByRole('listbox')
    expect(lists).toHaveLength(2)
    expect(screen.getAllByRole('option')).toHaveLength(2)
  })
})
