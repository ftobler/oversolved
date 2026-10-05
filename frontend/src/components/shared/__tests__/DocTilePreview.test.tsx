import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { usePreview } from '@/stores/previewStore'
import DocTilePreview from '@/components/shared/DocTilePreview'

vi.mock('@/stores/previewStore', () => ({ usePreview: vi.fn() }))

const mockPreview = vi.mocked(usePreview)

beforeEach(() => {
  mockPreview.mockReset()
})

describe('DocTilePreview fallback', () => {
  it('paints the placeholder when no preview exists', () => {
    mockPreview.mockReturnValue(undefined)
    const { container } = render(<DocTilePreview workspace="w" entry="e" name="Doc" />)
    expect(container.querySelector('.doc-tile-placeholder')).toBeTruthy()
    expect(container.querySelector('img')).toBeNull()
  })

  it('swaps a corrupt base64 image for the placeholder on load failure', () => {
    mockPreview.mockReturnValue('not-a-real-png')
    const { container } = render(<DocTilePreview workspace="w" entry="e" name="Doc" />)
    const img = container.querySelector('img')!
    expect(img).toBeTruthy()
    fireEvent.error(img)
    expect(container.querySelector('.doc-tile-placeholder')).toBeTruthy()
    expect(container.querySelector('img')).toBeNull()
  })

  it('clears the failure when a new preview arrives', () => {
    mockPreview.mockReturnValue('bad')
    const { container, rerender } = render(<DocTilePreview workspace="w" entry="e" name="Doc" />)
    fireEvent.error(container.querySelector('img')!)
    expect(container.querySelector('.doc-tile-placeholder')).toBeTruthy()

    mockPreview.mockReturnValue('good')
    rerender(<DocTilePreview workspace="w" entry="e" name="Doc" />)
    expect(container.querySelector('img')).toBeTruthy()
  })
})
