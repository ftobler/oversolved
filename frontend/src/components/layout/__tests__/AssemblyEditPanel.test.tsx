// The assembly editor's right card: the open instance or mate editor leaves the
// tree row (which keeps only its highlight and its own OK/Cancel pair) and
// renders here, mirroring the part editor's FeatureEditPanel. Presentational:
// the subject, its doc data and both editor bodies arrive as props, so this
// suite needs no viewport and no store.
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { AssemblyEditPanel, type AssemblyEditPanelProps } from '@/components/layout/AssemblyEditPanel'
import { PartInstanceEditor } from '@/components/layout/PartInstanceEditor'
import { MateEditor } from '@/components/layout/MateEditor'
import type { MateFeature, PartInstance } from '@/types/cad'
import type { AssemblySolveStatus } from '@/kernel/solveAssembly'
import { IDENTITY_TRANSFORM } from '@/utils/transform3d'
import featurePartIcon from '@/assets/icons/feature-part.svg'
import mateRotatingIcon from '@/assets/icons/mate-rotating.svg'
import renameIcon from '@/assets/icons/rename.svg'

const instances: PartInstance[] = [
  { handle: 'p1', doc_id: 'doc-p1', doc_rev: 1, transform: { ...IDENTITY_TRANSFORM }, visible: true },
]
const mates: MateFeature[] = [
  { id: 'm1', mate: { kind: 'rotating', label: 'Hinge', ref_a: { part: 'p1', anchor: 'a1' }, ref_b: { part: 'p2', anchor: 'b1' } } },
  // A legacy mate that never had a label: the card falls back to its kind.
  { id: 'm2', mate: { kind: 'fixed', ref_a: { part: '', anchor: '' }, ref_b: { part: '', anchor: '' } } },
]

function status(overrides: Partial<AssemblySolveStatus> = {}): AssemblySolveStatus {
  return { verdict: 'none', residualNorm: 0, rank: 0, dof: 0, iters: 0, mates: {}, parts: {}, ...overrides }
}

function makeProps(overrides: Partial<AssemblyEditPanelProps> = {}): AssemblyEditPanelProps {
  return {
    editing: { kind: 'none' },
    instances,
    mates,
    labelFor: handle => (handle === 'p1' ? 'Bracket' : undefined),
    onCommitInstance: vi.fn(),
    onCancelInstance: vi.fn(),
    onCommitMate: vi.fn(),
    onCancelMate: vi.fn(),
    onRenameMate: vi.fn(),
    renderInstanceEditor: inst => (
      <PartInstanceEditor
        instance={inst}
        onSetFixed={vi.fn()}
        onSetPosition={vi.fn()}
        onSetRotation={vi.fn()}
      />
    ),
    renderMateEditor: mate => (
      <MateEditor
        featureId={mate.id}
        mate={mate.mate}
        activeField={null}
        onArmField={vi.fn()}
        onUpdate={vi.fn()}
      />
    ),
    ...overrides,
  }
}

function renderPanel(overrides: Partial<AssemblyEditPanelProps> = {}) {
  const props = makeProps(overrides)
  return { ...render(<AssemblyEditPanel {...props} />), props }
}

describe('AssemblyEditPanel', () => {
  it('renders nothing while no subject is open', () => {
    const { container } = renderPanel()
    expect(container.querySelector('.feature-edit-panel')).toBeNull()
    expect(screen.queryByTitle('OK')).toBeNull()
  })

  it('shows the open instance with its part icon, display name and fields', () => {
    const { container } = renderPanel({ editing: { kind: 'instance', handle: 'p1' } })

    expect(container.querySelector('.feature-edit-panel-title')!.textContent).toBe('Bracket')
    expect(container.querySelector('.feature-edit-panel-header img')!.getAttribute('src')).toBe(featurePartIcon)
    // The real instance editor, not a stub: its Fixed box and the position row.
    expect(screen.getByLabelText('Fixed')).toBeInTheDocument()
    expect(screen.getByLabelText('Position X, millimetres')).toBeInTheDocument()
  })

  it('falls back to the document id when the part has no display name', () => {
    const { container } = renderPanel({
      editing: { kind: 'instance', handle: 'p1' },
      labelFor: undefined,
    })
    expect(container.querySelector('.feature-edit-panel-title')!.textContent).toBe('doc-p1')
  })

  it('wires OK and Cancel to the instance pair, and only to it', () => {
    const { props } = renderPanel({ editing: { kind: 'instance', handle: 'p1' } })
    fireEvent.click(screen.getByTitle('OK'))
    expect(props.onCommitInstance).toHaveBeenCalledTimes(1)
    expect(props.onCommitMate).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTitle('Cancel'))
    expect(props.onCancelInstance).toHaveBeenCalledTimes(1)
    expect(props.onCancelMate).not.toHaveBeenCalled()
  })

  it('shows the open mate with its kind icon, label and the mate editor', () => {
    const { container } = renderPanel({ editing: { kind: 'mate', id: 'm1' } })

    expect(container.querySelector('.feature-edit-panel-title')!.textContent).toBe('Hinge')
    expect(container.querySelector('.feature-edit-panel-header img')!.getAttribute('src')).toBe(mateRotatingIcon)
    expect(screen.getAllByText('p1 / a1')).toHaveLength(1)
    expect(container.querySelector('.mate-editor')).not.toBeNull()
  })

  it('names an unlabeled legacy mate by its kind', () => {
    const { container } = renderPanel({ editing: { kind: 'mate', id: 'm2' } })
    expect(container.querySelector('.feature-edit-panel-title')!.textContent).toBe('Fixed')
    // Its two unpicked slots are the chips' own prompt, unchanged from the row.
    expect(screen.getAllByText('Pick a reference')).toHaveLength(2)
  })

  it('wires OK and Cancel to the mate pair, and only to it', () => {
    const { props } = renderPanel({ editing: { kind: 'mate', id: 'm1' } })
    fireEvent.click(screen.getByTitle('OK'))
    expect(props.onCommitMate).toHaveBeenCalledTimes(1)
    expect(props.onCommitInstance).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTitle('Cancel'))
    expect(props.onCancelMate).toHaveBeenCalledTimes(1)
    expect(props.onCancelInstance).not.toHaveBeenCalled()
  })

  // A mate is authored, so its card carries the tree menu's Rename. An instance
  // is named by its part document and has nothing of its own to rename.
  it('puts Rename left of OK and Cancel on the mate card, with the rename icon', () => {
    const { container } = renderPanel({ editing: { kind: 'mate', id: 'm1' } })

    const header = container.querySelector('.feature-edit-panel-header') as HTMLElement
    const titles = Array.from(header.querySelectorAll('button')).map(b => b.getAttribute('title'))
    expect(titles).toEqual(['Rename', 'OK', 'Cancel'])

    const rename = screen.getByRole('button', { name: 'Rename' })
    expect(rename.getAttribute('class')).toBe('feature-rename-btn')
    expect(rename.querySelector('img')!.getAttribute('src')).toBe(renameIcon)
  })

  it('requests a mate rename carrying the label the card shows', () => {
    const { props } = renderPanel({ editing: { kind: 'mate', id: 'm1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
    expect(props.onRenameMate).toHaveBeenCalledTimes(1)
    expect(props.onRenameMate).toHaveBeenCalledWith('m1', 'Hinge')
  })

  it('falls back to the kind label for an unlabeled mate', () => {
    const { props } = renderPanel({ editing: { kind: 'mate', id: 'm2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
    expect(props.onRenameMate).toHaveBeenCalledWith('m2', 'Fixed')
  })

  it('draws no Rename button on the instance card', () => {
    const { container } = renderPanel({ editing: { kind: 'instance', handle: 'p1' } })
    expect(screen.queryByRole('button', { name: 'Rename' })).toBeNull()
    expect(container.querySelector('.feature-rename-btn')).toBeNull()
  })

  it('draws no Rename button on the mate card when the page offers no opener', () => {
    renderPanel({ editing: { kind: 'mate', id: 'm1' }, onRenameMate: undefined })
    expect(screen.queryByRole('button', { name: 'Rename' })).toBeNull()
  })

  it('marks a failed part in its own card below the edit panel', () => {
    const { container } = renderPanel({
      editing: { kind: 'instance', handle: 'p1' },
      status: status({ parts: { p1: { failed: true, error: 'part doc not found: p1' } } }),
    })
    const panel = container.querySelector('.feature-edit-panel') as HTMLElement
    const statusPanel = container.querySelector('.feature-status-panel') as HTMLElement
    expect(panel.contains(statusPanel)).toBe(false)
    expect(statusPanel.previousElementSibling).toBe(panel)
    expect(statusPanel.classList.contains('glass-panel')).toBe(true)
    const line = statusPanel.querySelector('.status-message') as HTMLElement
    expect(line.className).toContain('status-message--error')
    expect(line.textContent).toBe('part doc not found: p1')
  })

  it('marks a failed mate in its own card below the edit panel', () => {
    const { container } = renderPanel({
      editing: { kind: 'mate', id: 'm1' },
      status: status({ mates: { m1: { stale: true, error: "unsupported mate kind 'worm_gear'" } } }),
    })
    const panel = container.querySelector('.feature-edit-panel') as HTMLElement
    const statusPanel = container.querySelector('.feature-status-panel') as HTMLElement
    expect(panel.contains(statusPanel)).toBe(false)
    expect(statusPanel.previousElementSibling).toBe(panel)
    const line = statusPanel.querySelector('.status-message') as HTMLElement
    expect(line.className).toContain('status-message--error')
    expect(line.textContent).toBe("unsupported mate kind 'worm_gear'")
  })

  it('draws no status card for a healthy subject', () => {
    const { container } = renderPanel({ editing: { kind: 'mate', id: 'm2' } })
    expect(container.querySelector('.feature-status-panel')).toBeNull()
    expect(container.querySelector('.status-message')).toBeNull()
  })

  it('renders nothing for a subject the document no longer holds', () => {
    const goneInstance = renderPanel({ editing: { kind: 'instance', handle: 'gone' } })
    expect(goneInstance.container.querySelector('.feature-edit-panel')).toBeNull()
    goneInstance.unmount()

    const goneMate = renderPanel({ editing: { kind: 'mate', id: 'gone' } })
    expect(goneMate.container.querySelector('.feature-edit-panel')).toBeNull()
  })
})
