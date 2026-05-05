import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import CacheInspector from '../CacheInspector'
import { cacheBuildResponse, invalidateAllCache } from '../../utils/buildCache'
import type { PartDoc, BuildResponse } from '../../types/cad'

function makeDoc(features?: object[]): PartDoc {
  return { features: features ?? [{ id: 'sketch0', kind: 'sketch' }] } as PartDoc
}

function makeResponse(overrides?: object): BuildResponse {
  return { solve_ms: 42, result: {}, bodies: {}, ...overrides }
}

async function saveEntry(docId: string, extra?: object) {
  await cacheBuildResponse(
    docId, makeDoc(), 0, null,
    makeResponse(extra),
  )
}

describe('CacheInspector', () => {
  beforeEach(async () => {
    await invalidateAllCache()
  })

  it('renders frontend and l1 tabs', () => {
    render(<CacheInspector />)
    expect(screen.getByRole('button', { name: /Frontend/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /L1 Memory/i })).toBeInTheDocument()
  })

  it('switches to l1 tab on click', () => {
    render(<CacheInspector />)
    fireEvent.click(screen.getByRole('button', { name: /L1 Memory/i }))
    expect(screen.getByRole('button', { name: /L1 Memory/i })).toHaveClass('active')
  })

  it('shows empty frontend cache message', async () => {
    render(<CacheInspector />)
    await waitFor(() => {
      expect(screen.getByText(/No entries/i)).toBeInTheDocument()
    })
  })

  it('displays frontend cached entries after loading', async () => {
    await saveEntry('doc1')

    render(<CacheInspector />)
    await waitFor(() => {
      expect(screen.getByText(/doc1/)).toBeInTheDocument()
    })
  })

  it('filters frontend entries by search query', async () => {
    await saveEntry('doc1')
    await saveEntry('doc2')

    render(<CacheInspector />)
    await waitFor(() => {
      expect(screen.getByText(/doc1/)).toBeInTheDocument()
    })

    const searchInput = screen.getByPlaceholderText(/Search by doc_id/i)
    fireEvent.change(searchInput, { target: { value: 'doc2' } })

    await waitFor(() => {
      expect(screen.queryByText(/doc1/)).not.toBeInTheDocument()
      expect(screen.getByText(/doc2/)).toBeInTheDocument()
    })
  })

  it('expands entry details on click', async () => {
    await saveEntry('doc1')

    render(<CacheInspector />)
    await waitFor(() => {
      expect(screen.getByText(/doc1/)).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('button', { name: /Details/i }))
    await waitFor(() => {
      expect(screen.getByText(/solve_ms/)).toBeInTheDocument()
    })
  })

  it('deletes entry from frontend cache', async () => {
    await saveEntry('doc1')

    render(<CacheInspector />)
    await waitFor(() => {
      expect(screen.getByText(/doc1/)).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('button', { name: /Delete/i }))
    await waitFor(() => {
      expect(screen.queryByText(/doc1/)).not.toBeInTheDocument()
    })
  })

  it('shows l1 entries when on l1 tab', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        l1: [{ doc_id: 'doc_a', feature_order: [], checkpoint_count: 1, accessed_at: new Date().toISOString(), shape_size_estimate: 0 }],
      }),
    } as unknown as Response)

    render(<CacheInspector />)
    fireEvent.click(screen.getByRole('button', { name: /L1 Memory/i }))

    await waitFor(() => {
      expect(screen.getByText(/doc_a/)).toBeInTheDocument()
    })
  })

  it('filters l1 entries by search query', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        l1: [
          { doc_id: 'doc_a', feature_order: [], checkpoint_count: 1, accessed_at: new Date().toISOString(), shape_size_estimate: 0 },
          { doc_id: 'doc_b', feature_order: [], checkpoint_count: 1, accessed_at: new Date().toISOString(), shape_size_estimate: 0 },
        ],
      }),
    } as unknown as Response)

    render(<CacheInspector />)
    fireEvent.click(screen.getByRole('button', { name: /L1 Memory/i }))

    await waitFor(() => {
      expect(screen.getByText(/doc_a/)).toBeInTheDocument()
    })

    const searchInput = screen.getByPlaceholderText(/Search by doc_id/i)
    fireEvent.change(searchInput, { target: { value: 'doc_b' } })

    await waitFor(() => {
      expect(screen.queryByText(/doc_a/)).not.toBeInTheDocument()
      expect(screen.getByText(/doc_b/)).toBeInTheDocument()
    })
  })
})
