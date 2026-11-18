import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import StepImportDialog from '@/components/dialogs/StepImportDialog'

// The STEP import chooser: the default is mode A, the assembly editor's variant
// hides B1 (the assembly already exists), and the report names the picked mode
// as a pure value, so the page never reads a radio itself.

const importButton = () => screen.getByRole('button', { name: 'Import' })

async function confirm() {
  await act(async () => { fireEvent.click(importButton()) })
}

describe('StepImportDialog', () => {
  it('renders nothing when closed', () => {
    const { container } = render(
      <StepImportDialog isOpen={false} fileName="bracket.step" onImport={vi.fn()} onCancel={vi.fn()} />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('offers all three modes and defaults to one part', async () => {
    const onImport = vi.fn()
    render(<StepImportDialog isOpen fileName="bracket.step" onImport={onImport} onCancel={vi.fn()} />)

    expect(screen.getByLabelText('One part')).toBeChecked()
    expect(screen.getByLabelText('Assembly with one part')).not.toBeChecked()
    expect(screen.getByLabelText('Assembly, a part per solid')).not.toBeChecked()
    expect(screen.getByRole('heading', { name: 'Import bracket.step' })).toBeInTheDocument()

    await confirm()
    expect(onImport).toHaveBeenCalledWith('part')
  })

  it('reports the picked assembly mode', async () => {
    const onImport = vi.fn()
    render(<StepImportDialog isOpen fileName="bracket.step" onImport={onImport} onCancel={vi.fn()} />)

    fireEvent.click(screen.getByLabelText('Assembly, a part per solid'))
    await confirm()
    expect(onImport).toHaveBeenCalledWith('assembly_split')
  })

  it('hides B1 in the assembly editor, where the assembly already exists', async () => {
    const onImport = vi.fn()
    render(
      <StepImportDialog isOpen fileName="bracket.step" variant="assembly" onImport={onImport} onCancel={vi.fn()} />,
    )

    expect(screen.getByLabelText('Add as one part')).toBeChecked()
    expect(screen.getByLabelText('Add a part per solid')).toBeInTheDocument()
    expect(screen.queryByLabelText('Assembly with one part')).toBeNull()

    await confirm()
    expect(onImport).toHaveBeenCalledWith('part')
  })

  it('returns to the default mode when reopened for another file', () => {
    const props = { onImport: vi.fn(), onCancel: vi.fn() }
    const { rerender } = render(<StepImportDialog isOpen fileName="bracket.step" {...props} />)
    fireEvent.click(screen.getByLabelText('Assembly with one part'))

    rerender(<StepImportDialog isOpen={false} fileName="bracket.step" {...props} />)
    rerender(<StepImportDialog isOpen fileName="plate.step" {...props} />)

    expect(screen.getByLabelText('One part')).toBeChecked()
  })

  it('cancels through the shared shell', () => {
    const onCancel = vi.fn()
    render(<StepImportDialog isOpen fileName="bracket.step" onImport={vi.fn()} onCancel={onCancel} />)

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})
