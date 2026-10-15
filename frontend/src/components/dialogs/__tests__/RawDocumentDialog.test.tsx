// The read-only fallback dialog: a refused document keeps its bytes reachable.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import RawDocumentDialog from '@/components/dialogs/RawDocumentDialog'
import { downloadBlob } from '@/utils/core/downloadBlob'
import type { DocLoadError } from '@/persistence/docSchema'

vi.mock('@/utils/core/downloadBlob', () => ({ downloadBlob: vi.fn() }))

const failure: DocLoadError = {
  docName: 'Bracket',
  field: 'features[0].extrude.distance',
  message: 'must be a finite number, got NaN',
  rawText: 'kind: part\nfeatures:\n  - id: ex1\n    kind: extrude\n',
}

describe('RawDocumentDialog', () => {
  beforeEach(() => vi.clearAllMocks())

  it('renders nothing without a failure', () => {
    const { container } = render(<RawDocumentDialog failure={null} onClose={() => {}} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows the name, the field and the raw text read-only', () => {
    render(<RawDocumentDialog failure={failure} onClose={() => {}} />)
    expect(screen.getByText('Could not open "Bracket"')).toBeTruthy()
    expect(screen.getByText(/features\[0\]\.extrude\.distance/)).toBeTruthy()
    const text = screen.getByLabelText('Raw document text') as HTMLTextAreaElement
    expect(text.value).toBe(failure.rawText)
    expect(text.readOnly).toBe(true)
  })

  it('exports the raw text under the document name', () => {
    render(<RawDocumentDialog failure={failure} onClose={() => {}} />)
    fireEvent.click(screen.getByText('Export raw'))
    expect(downloadBlob).toHaveBeenCalledTimes(1)
    const [blob, name] = vi.mocked(downloadBlob).mock.calls[0]
    expect(name).toBe('Bracket.raw.yaml')
    expect(blob).toBeInstanceOf(Blob)
  })

  it('closes on confirm', () => {
    const onClose = vi.fn()
    render(<RawDocumentDialog failure={failure} onClose={onClose} />)
    fireEvent.click(screen.getByText('Close'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
