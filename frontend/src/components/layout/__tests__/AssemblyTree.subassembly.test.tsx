import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render } from '@testing-library/react'
import { AssemblyTree } from '@/components/layout/AssemblyTree'
import type { AssemblyDoc, PartInstance } from '@/types/cad'
import { IDENTITY_TRANSFORM } from '@/utils/transform3d'

function instance(handle: string, docId: string): PartInstance {
  return { handle, doc_id: docId, doc_rev: 0, transform: { ...IDENTITY_TRANSFORM }, visible: true }
}

const childDoc: AssemblyDoc = {
  kind: 'assembly',
  features: [
    { id: 'cf1', kind: 'part_instance', instance: instance('bolt', 'part-bolt') },
    { id: 'cf2', kind: 'part_instance', instance: instance('nut', 'part-nut') },
  ],
}

const instances = [instance('sub', 'asm-sub'), instance('bracket', 'part-b')]

const noop = () => {}

function renderTree(props: Partial<React.ComponentProps<typeof AssemblyTree>> = {}) {
  return render(
    <AssemblyTree
      instances={instances}
      builtins={[]}
      mates={[]}
      labelFor={handle => ({ sub: 'Gripper', bracket: 'Bracket' })[handle]}
      subassemblies={{ 'asm-sub': childDoc }}
      docKindOf={docId => (docId === 'asm-sub' ? 'assembly' : 'part')}
      docNames={{ 'part-bolt': 'Bolt', 'part-nut': 'Nut', 'part-b': 'Bracket' }}
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
    />
  )
}

function rowByName(container: HTMLElement, name: string): HTMLElement {
  const span = [...container.querySelectorAll('.feature-name')].find(node => node.textContent === name)
  if (!span) throw new Error(`row not found: ${name}`)
  return span.closest('.feature-item') as HTMLElement
}

// The disclosure sits after the name now, so reach it by its accessible label
// rather than by a position or a shared slot class.
function chevronFor(container: HTMLElement, name: string, expanded: boolean): HTMLButtonElement {
  const label = `${expanded ? 'Collapse' : 'Expand'} ${name}`
  const button = container.querySelector(`[aria-label="${label}"]`) as HTMLButtonElement | null
  if (!button) throw new Error(`chevron not found: ${label}`)
  return button
}

describe('AssemblyTree sub-assemblies', () => {
  it('starts folded, then a chevron reveals indented child rows', () => {
    const { container } = renderTree()
    expect(rowByName(container, 'Gripper')).toBeTruthy()
    expect(container.querySelector('.assembly-subtree')).toBeNull()

    fireEvent.click(chevronFor(container, 'Gripper', false))

    const subtree = container.querySelector('.assembly-subtree')!
    expect(subtree).toBeTruthy()
    expect(chevronFor(container, 'Gripper', true).getAttribute('aria-expanded')).toBe('true')
    expect([...subtree.querySelectorAll('.feature-name')].map(node => node.textContent)).toEqual(['Bolt', 'Nut'])
    // Child rows are read-only here: no edit or delete action at all.
    const bolt = rowByName(container, 'Bolt')
    expect(bolt.querySelector('.feature-edit-btn')).toBeNull()
    expect(bolt.querySelectorAll('.feature-item-actions button')).toHaveLength(2)  // eye + options
    const menu = bolt.querySelector('[aria-label="Bolt options"]')!
    fireEvent.click(menu)
    expect(document.body.textContent).not.toContain('Delete')
    expect(document.body.textContent).toContain('Open in new tab')
  })

  it('selecting a child selects the top-level instance plus its leaf path', () => {
    const onSelectPart = vi.fn()
    const { container } = renderTree({ onSelectPart })
    fireEvent.click(chevronFor(container, 'Gripper', false))
    fireEvent.click(rowByName(container, 'Bolt'))
    expect(onSelectPart).toHaveBeenCalledWith('sub', 'bolt')
  })

  it('the child eye is a view filter callback, not a document write', () => {
    const onSetLeafVisible = vi.fn()
    const { container } = renderTree({ onSetLeafVisible })
    fireEvent.click(chevronFor(container, 'Gripper', false))
    const hide = rowByName(container, 'Bolt').querySelector('[aria-label="Hide Bolt"]')!
    fireEvent.click(hide)
    expect(onSetLeafVisible).toHaveBeenCalledWith('sub/bolt', false)
  })

  it('a drop onto a sub-assembly row is a no-op', () => {
    const onReorderInstance = vi.fn()
    const { container } = renderTree({ onReorderInstance })
    const bracket = rowByName(container, 'Bracket')
    const subRow = rowByName(container, 'Gripper')

    fireEvent.dragStart(bracket, { dataTransfer: { effectAllowed: '' } })
    fireEvent.dragOver(subRow, { dataTransfer: { dropEffect: '' } })
    expect(subRow.className).not.toContain('drag-over')
    fireEvent.drop(subRow, { dataTransfer: { dropEffect: '' } })
    expect(onReorderInstance).not.toHaveBeenCalled()
  })
})
