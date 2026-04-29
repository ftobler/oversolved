import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import CacheInspector from '../CacheInspector'
import * as indexedDb from '../../utils/indexedDb'

describe('CacheInspector', () => {
  beforeEach(async () => {
    await indexedDb.clearAll()
  })

  it('renders frontend and backend tabs', () => {
    render(<CacheInspector />)
    expect(screen.getByRole('button', { name: /Frontend/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Backend/i })).toBeInTheDocument()
  })

  it('switches to backend tab on click', () => {
    render(<CacheInspector />)
    fireEvent.click(screen.getByRole('button', { name: /Backend/i }))
    expect(screen.getByRole('button', { name: /Backend/i })).toHaveClass('active')
  })

  it('shows empty frontend cache message', async () => {
    render(<CacheInspector />)
    await waitFor(() => {
      expect(screen.getByText(/No entries/i)).toBeInTheDocument()
    })
  })

  it('displays indexeddb entries after loading', async () => {
    const entry = {
      cache_key: 'doc1:abc',
      doc_id: 'doc1',
      feature_spec_hash: 'abc',
      timestamp: Date.now(),
      rollback_position: 0,
      pick_boundary: null,
      buildResponse: { solve_ms: 42, result: {}, bodies: {} },
    }
    await indexedDb.saveRecord(entry)

    render(<CacheInspector />)
    await waitFor(() => {
      expect(screen.getByText(/doc1/)).toBeInTheDocument()
    })
  })

  it('filters entries by search query', async () => {
    await indexedDb.saveRecord({
      cache_key: 'doc1:abc',
      doc_id: 'doc1',
      feature_spec_hash: 'abc',
      timestamp: Date.now(),
      rollback_position: 0,
      pick_boundary: null,
      buildResponse: { solve_ms: 42, result: {}, bodies: {} },
    })
    await indexedDb.saveRecord({
      cache_key: 'doc2:def',
      doc_id: 'doc2',
      feature_spec_hash: 'def',
      timestamp: Date.now(),
      rollback_position: 0,
      pick_boundary: null,
      buildResponse: { solve_ms: 42, result: {}, bodies: {} },
    })

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
    await indexedDb.saveRecord({
      cache_key: 'doc1:abc',
      doc_id: 'doc1',
      feature_spec_hash: 'abc',
      timestamp: Date.now(),
      rollback_position: 0,
      pick_boundary: null,
      buildResponse: { solve_ms: 42, result: {}, bodies: {} },
    })

    render(<CacheInspector />)
    await waitFor(() => {
      expect(screen.getByText(/doc1/)).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('button', { name: /Details/i }))
    await waitFor(() => {
      expect(screen.getByText(/solve_ms/)).toBeInTheDocument()
    })
  })

  it('deletes entry from indexeddb', async () => {
    await indexedDb.saveRecord({
      cache_key: 'doc1:abc',
      doc_id: 'doc1',
      feature_spec_hash: 'abc',
      timestamp: Date.now(),
      rollback_position: 0,
      pick_boundary: null,
      buildResponse: { solve_ms: 42, result: {}, bodies: {} },
    })

    render(<CacheInspector />)
    await waitFor(() => {
      expect(screen.getByText(/doc1/)).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('button', { name: /Delete/i }))
    await waitFor(() => {
      expect(screen.queryByText(/doc1/)).not.toBeInTheDocument()
    })
  })

  it('shows backend l1 and l2 sections', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      json: async () => ({ l1: [], l2: [] }),
    } as unknown as Response)

    render(<CacheInspector />)
    fireEvent.click(screen.getByRole('button', { name: /Backend/i }))

    await waitFor(() => {
      expect(screen.getByText(/L1 Memory/i)).toBeInTheDocument()
      expect(screen.getByText(/L2 Disk/i)).toBeInTheDocument()
    })
  })

  it('filters backend entries by search query', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      json: async () => ({
        l1: [{ doc_id: 'doc_a', feature_order: [], checkpoint_count: 1, accessed_at: new Date().toISOString(), shape_size_estimate: 0 }],
        l2: [{ doc_id: 'doc_b', file_path: '/tmp/doc_b.json', file_size: 100, created_at: new Date().toISOString(), modified_at: new Date().toISOString(), checkpoint_count: 1 }],
      }),
    } as unknown as Response)

    render(<CacheInspector />)
    fireEvent.click(screen.getByRole('button', { name: /Backend/i }))

    await waitFor(() => {
      expect(screen.getByText(/doc_a/)).toBeInTheDocument()
      expect(screen.getByText(/doc_b/)).toBeInTheDocument()
    })

    const searchInput = screen.getByPlaceholderText(/Search by doc_id/i)
    fireEvent.change(searchInput, { target: { value: 'doc_b' } })

    await waitFor(() => {
      expect(screen.queryByText(/doc_a/)).not.toBeInTheDocument()
      expect(screen.getByText(/doc_b/)).toBeInTheDocument()
    })
  })

  it('loads l2 json preview on view json click', async () => {
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url === '/api/cache/inspect') {
        return Promise.resolve({
          json: async () => ({
            l1: [],
            l2: [{ doc_id: 'doc_x', file_path: '/tmp/doc_x.json', file_size: 100, created_at: new Date().toISOString(), modified_at: new Date().toISOString(), checkpoint_count: 1 }],
          }),
        } as unknown as Response)
      }
      if (url === '/api/cache/inspect/l2/doc_x') {
        return Promise.resolve({
          text: async () => '{"checkpoints": {}}',
        } as unknown as Response)
      }
      return Promise.resolve({} as Response)
    })

    render(<CacheInspector />)
    fireEvent.click(screen.getByRole('button', { name: /Backend/i }))

    await waitFor(() => {
      expect(screen.getByText(/doc_x/)).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('button', { name: /View JSON/i }))
    await waitFor(() => {
      expect(screen.getByText(/checkpoints/)).toBeInTheDocument()
    })
  })
})
