import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { PickChip } from '@/components/sketch/PickChip'
import dragHandleIcon from '@/assets/icons/toolbar-menu.svg'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'

// Count queryLabel calls so the memoization (L4) is observable: the label
// computation must not rerun when values/features/partLabels are unchanged.
const queryLabelSpy = vi.hoisted(() => vi.fn((query: string) => query))
vi.mock('@/utils/query/queryLabel', () => ({ queryLabel: queryLabelSpy }))

const SRC = join(__dirname, '..', '..', '..')

beforeEach(() => {
  useSketchEditorStore.setState({
    chipOwnedSelection: new Set(),
    normalSelection: new Set(),
  })
})

describe('PickChip', () => {
  it('renders empty state without text when no emptyText provided', () => {
    render(
      <PickChip
        values={[]}
        isPicking={false}
        onActivate={vi.fn()}
        onRemove={vi.fn()}
      />
    )
    const chip = document.querySelector('.feature-pick-chip')
    expect(chip).toBeTruthy()
    expect(chip?.classList.contains('empty')).toBe(true)
    expect(chip?.textContent).toBe('')
  })

  it('renders empty text when provided and empty', () => {
    render(
      <PickChip
        values={[]}
        isPicking={false}
        onActivate={vi.fn()}
        onRemove={vi.fn()}
        emptyText="(pick target)"
      />
    )
    expect(screen.getByText('(pick target)')).toBeInTheDocument()
  })

  it('renders single value', () => {
    render(
      <PickChip
        values={['@sk1']}
        isPicking={false}
        onActivate={vi.fn()}
        onRemove={vi.fn()}
      />
    )
    expect(screen.getByText('@sk1')).toBeInTheDocument()
    const chip = document.querySelector('.feature-pick-chip')
    expect(chip?.classList.contains('empty')).toBe(false)
  })

  it('renders multiple values', () => {
    render(
      <PickChip
        values={['@sk1', '@sk2', '@sk3']}
        isPicking={false}
        onActivate={vi.fn()}
        onRemove={vi.fn()}
      />
    )
    expect(screen.getByText('@sk1')).toBeInTheDocument()
    expect(screen.getByText('@sk2')).toBeInTheDocument()
    expect(screen.getByText('@sk3')).toBeInTheDocument()
    const items = document.querySelectorAll('.feature-pick-chip-item')
    expect(items.length).toBe(3)
  })

  it('applies picking class when isPicking is true', () => {
    render(
      <PickChip
        values={[]}
        isPicking={true}
        onActivate={vi.fn()}
        onRemove={vi.fn()}
      />
    )
    const chip = document.querySelector('.feature-pick-chip')
    expect(chip?.classList.contains('picking')).toBe(true)
  })

  it('calls onActivate when clicked', () => {
    const onActivate = vi.fn()
    render(
      <PickChip
        values={['@sk1']}
        isPicking={false}
        onActivate={onActivate}
        onRemove={vi.fn()}
      />
    )
    const chip = document.querySelector('.feature-pick-chip')!
    fireEvent.click(chip)
    expect(onActivate).toHaveBeenCalledTimes(1)
  })

  it('calls onRemove with correct index when remove button clicked', () => {
    const onRemove = vi.fn()
    render(
      <PickChip
        values={['@sk1', '@sk2', '@sk3']}
        isPicking={false}
        onActivate={vi.fn()}
        onRemove={onRemove}
      />
    )
    const removeButtons = document.querySelectorAll('.feature-pick-chip-item-remove')
    expect(removeButtons.length).toBe(3)
    fireEvent.click(removeButtons[1])
    expect(onRemove).toHaveBeenCalledWith(1)
    expect(onRemove).toHaveBeenCalledTimes(1)
  })

  it('does not call onActivate when remove button clicked (stopPropagation)', () => {
    const onActivate = vi.fn()
    const onRemove = vi.fn()
    render(
      <PickChip
        values={['@sk1']}
        isPicking={false}
        onActivate={onActivate}
        onRemove={onRemove}
      />
    )
    const removeButton = document.querySelector('.feature-pick-chip-item-remove')!
    fireEvent.click(removeButton)
    expect(onRemove).toHaveBeenCalledTimes(1)
    expect(onActivate).not.toHaveBeenCalled()
  })

  it('renders many values without error', () => {
    render(
      <PickChip
        values={['a', 'b', 'c', 'd', 'e']}
        isPicking={false}
        onActivate={vi.fn()}
        onRemove={vi.fn()}
      />
    )
    const items = document.querySelectorAll('.feature-pick-chip-item')
    expect(items.length).toBe(5)
  })

  it('renders drag handle for each item when onReorder is provided', () => {
    render(
      <PickChip
        values={['@sk1', '@sk2', '@sk3']}
        isPicking={false}
        onActivate={vi.fn()}
        onRemove={vi.fn()}
        onReorder={vi.fn()}
      />
    )
    const dragHandles = document.querySelectorAll('.feature-pick-chip-item-drag')
    expect(dragHandles.length).toBe(3)
  })

  it('does not render drag handles when onReorder is not provided', () => {
    render(
      <PickChip
        values={['@sk1', '@sk2', '@sk3']}
        isPicking={false}
        onActivate={vi.fn()}
        onRemove={vi.fn()}
      />
    )
    const dragHandles = document.querySelectorAll('.feature-pick-chip-item-drag')
    expect(dragHandles.length).toBe(0)
  })

  it('items have draggable attribute when onReorder is provided', () => {
    render(
      <PickChip
        values={['@sk1', '@sk2']}
        isPicking={false}
        onActivate={vi.fn()}
        onRemove={vi.fn()}
        onReorder={vi.fn()}
      />
    )
    const items = document.querySelectorAll('.feature-pick-chip-item')
    expect(items[0].getAttribute('draggable')).toBe('true')
    expect(items[1].getAttribute('draggable')).toBe('true')
  })

  it('items are not draggable when onReorder is not provided', () => {
    render(
      <PickChip
        values={['@sk1', '@sk2']}
        isPicking={false}
        onActivate={vi.fn()}
        onRemove={vi.fn()}
      />
    )
    const items = document.querySelectorAll('.feature-pick-chip-item')
    expect(items[0].getAttribute('draggable')).toBe('false')
    expect(items[1].getAttribute('draggable')).toBe('false')
  })

  it('drag handle has correct class for styling', () => {
    render(
      <PickChip
        values={['@sk1']}
        isPicking={false}
        onActivate={vi.fn()}
        onRemove={vi.fn()}
        onReorder={vi.fn()}
      />
    )
    const dragHandle = document.querySelector('.feature-pick-chip-item-drag')
    expect(dragHandle).toBeTruthy()
  })

  it('calls onReorder with correct indices after drag simulation', () => {
    const onReorder = vi.fn()
    render(
      <PickChip
        values={['@sk1', '@sk2', '@sk3']}
        isPicking={false}
        onActivate={vi.fn()}
        onRemove={vi.fn()}
        onReorder={onReorder}
      />
    )
    const items = document.querySelectorAll('.feature-pick-chip-item')
    const dataTransfer = { setData: vi.fn(), effectAllowed: '', getData: vi.fn(() => '2'), dropEffect: '' }
    fireEvent.dragStart(items[2], { dataTransfer })
    fireEvent.dragOver(items[0], { dataTransfer })
    fireEvent.drop(items[0], { dataTransfer })
    expect(onReorder).toHaveBeenCalledTimes(1)
    expect(onReorder).toHaveBeenCalledWith(2, expect.any(Number))
  })

  it('does not call onReorder when dragged onto itself', () => {
    const onReorder = vi.fn()
    render(
      <PickChip
        values={['@sk1', '@sk2', '@sk3']}
        isPicking={false}
        onActivate={vi.fn()}
        onRemove={vi.fn()}
        onReorder={onReorder}
      />
    )
    const items = document.querySelectorAll('.feature-pick-chip-item')
    const dataTransfer = { setData: vi.fn(), effectAllowed: '', getData: vi.fn(() => '1'), dropEffect: '' }
    fireEvent.dragStart(items[1], { dataTransfer })
    fireEvent.dragOver(items[1], { dataTransfer, clientX: 0 })
    fireEvent.drop(items[1], { dataTransfer })
    expect(onReorder).not.toHaveBeenCalled()
  })

  describe('drag handle asset', () => {
    it('renders the handle from the bundled asset module', () => {
      render(
        <PickChip
          values={['@sk1']}
          isPicking={false}
          onActivate={vi.fn()}
          onRemove={vi.fn()}
          onReorder={vi.fn()}
        />
      )
      const img = document.querySelector('.feature-pick-chip-item-drag img')!
      expect(img.getAttribute('src')).toBe(dragHandleIcon)
    })

    it('leaves no dev-server-only /src/ asset path anywhere in src/', () => {
      // A hardcoded src="/src/assets/..." only resolves while the vite dev
      // server is serving the source tree. `vite build` emits assets under
      // dist/ with a content hash, so the same literal 404s in production.
      // Imports are the only form the bundler rewrites, so this scan guards the
      // whole tree. `import.meta.glob` keys are also `/src/...` but are lookup
      // keys rather than URLs, hence the attribute-shaped pattern.
      const devOnlyAssetUrl = /(?:src|href)\s*=\s*["'`{]*\/src\/|url\(\s*["']?\/src\//
      const files: string[] = []
      const walk = (dir: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const full = join(dir, entry.name)
          if (entry.isDirectory()) walk(full)
          else if (/\.(ts|tsx|css)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) files.push(full)
        }
      }
      walk(SRC)
      const offenders = files
        .filter(f => !f.includes('__tests__'))
        .filter(f => devOnlyAssetUrl.test(readFileSync(f, 'utf8')))
        .map(f => f.slice(SRC.length + 1))

      expect(offenders).toEqual([])
    })
  })

  describe('queryLabel memoization', () => {
    beforeEach(() => {
      queryLabelSpy.mockClear()
    })

    it('does not recompute labels when values/features/partLabels are unchanged', () => {
      const features = [{ id: 'ex1', kind: 'extrude', label: 'Extrude 1' }]
      const partLabels = { ex1: 'Part X' }
      // Same reference across rerenders, like a chip whose data did not change.
      const values = ['@ex1']
      const { rerender } = render(
        <PickChip
          values={values}
          isPicking={false}
          onActivate={vi.fn()}
          onRemove={vi.fn()}
          features={features}
          partLabels={partLabels}
        />
      )
      const callsAfterMount = queryLabelSpy.mock.calls.length
      expect(callsAfterMount).toBeGreaterThan(0)

      // A re-render with fresh callback identities but identical label inputs
      // must hit the memo, not re-run the label function per value.
      rerender(
        <PickChip
          values={values}
          isPicking={false}
          onActivate={vi.fn()}
          onRemove={vi.fn()}
          features={features}
          partLabels={partLabels}
        />
      )
      expect(queryLabelSpy.mock.calls.length).toBe(callsAfterMount)

      // A values change does recompute, once per value.
      const moreValues = [...values, '@sk1']
      rerender(
        <PickChip
          values={moreValues}
          isPicking={false}
          onActivate={vi.fn()}
          onRemove={vi.fn()}
          features={features}
          partLabels={partLabels}
        />
      )
      expect(queryLabelSpy.mock.calls.length).toBe(callsAfterMount + 2)
    })
  })

  describe('chipOwnedSelection sync', () => {
    it('merges values into normalSelection while picking', () => {
      render(
        <PickChip
          values={['@edge_0', '@edge_1']}
          isPicking={true}
          onActivate={vi.fn()}
          onRemove={vi.fn()}
        />
      )
      const s = useSketchEditorStore.getState()
      expect([...s.chipOwnedSelection].sort()).toEqual(['@edge_0', '@edge_1'])
      expect(s.normalSelection.has('@edge_0')).toBe(true)
      expect(s.normalSelection.has('@edge_1')).toBe(true)
    })

    it('clears chip-owned entries when isPicking becomes false', () => {
      const { rerender } = render(
        <PickChip
          values={['@edge_0']}
          isPicking={true}
          onActivate={vi.fn()}
          onRemove={vi.fn()}
        />
      )
      expect(useSketchEditorStore.getState().normalSelection.has('@edge_0')).toBe(true)

      rerender(
        <PickChip
          values={['@edge_0']}
          isPicking={false}
          onActivate={vi.fn()}
          onRemove={vi.fn()}
        />
      )
      const s = useSketchEditorStore.getState()
      expect(s.chipOwnedSelection.size).toBe(0)
      expect(s.normalSelection.has('@edge_0')).toBe(false)
    })

    it('reconciles diff when values change while picking (no flicker)', () => {
      const { rerender } = render(
        <PickChip
          values={['@edge_0']}
          isPicking={true}
          onActivate={vi.fn()}
          onRemove={vi.fn()}
        />
      )
      expect([...useSketchEditorStore.getState().chipOwnedSelection]).toEqual(['@edge_0'])

      rerender(
        <PickChip
          values={['@edge_0', '@edge_1']}
          isPicking={true}
          onActivate={vi.fn()}
          onRemove={vi.fn()}
        />
      )
      const s = useSketchEditorStore.getState()
      expect([...s.chipOwnedSelection].sort()).toEqual(['@edge_0', '@edge_1'])
    })

    it('does not sync when not picking even with values', () => {
      render(
        <PickChip
          values={['@body_1']}
          isPicking={false}
          onActivate={vi.fn()}
          onRemove={vi.fn()}
        />
      )
      const s = useSketchEditorStore.getState()
      expect(s.chipOwnedSelection.size).toBe(0)
      expect(s.normalSelection.has('@body_1')).toBe(false)
    })
  })
})
