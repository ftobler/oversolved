import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { RebuildButton } from '../RebuildButton'
import { RebuildSparkline } from '../RebuildSparkline'
import { RebuildTimingPopover } from '../RebuildTimingPopover'

describe('RebuildSparkline', () => {
  it('renders with data', () => {
    const { container } = render(<RebuildSparkline durations={[100, 200, 150]} />)
    expect(container.querySelector('svg')).toBeInTheDocument()
    expect(container.querySelector('polyline')).toBeInTheDocument()
    expect(container.querySelectorAll('circle').length).toBe(3)
  })

  it('returns null for empty data', () => {
    const { container } = render(<RebuildSparkline durations={[]} />)
    expect(container.firstChild).toBeNull()
  })

  it('handles single data point', () => {
    const { container } = render(<RebuildSparkline durations={[100]} />)
    expect(container.querySelector('svg')).toBeInTheDocument()
  })
})

describe('RebuildTimingPopover', () => {
  it('returns null when not visible', () => {
    const { container } = render(
      <RebuildTimingPopover
        stats={{
          uuid: 'test',
          rebuild_count: 1,
          last_duration_ms: 100,
          average_ms: 100,
          median_ms: 100,
          min_ms: 100,
          max_ms: 100,
          trend: 'stable',
          history: [{ duration_ms: 100, feature_count: 2, timestamp: '2024-01-01' }],
        }}
        isVisible={false}
      />
    )
    expect(container.firstChild).toBeNull()
  })

  it('returns null when stats is null', () => {
    const { container } = render(<RebuildTimingPopover stats={null} isVisible />)
    expect(container.firstChild).toBeNull()
  })

  it('renders stats when visible', () => {
    render(
      <RebuildTimingPopover
        stats={{
          uuid: 'test',
          rebuild_count: 2,
          last_duration_ms: 150,
          average_ms: 125,
          median_ms: 125,
          min_ms: 100,
          max_ms: 150,
          trend: 'faster',
          history: [
            { duration_ms: 150, feature_count: 2, timestamp: '2024-01-01' },
            { duration_ms: 100, feature_count: 2, timestamp: '2024-01-02' },
          ],
        }}
        isVisible
      />
    )
    expect(screen.getByText('Rebuild Times')).toBeInTheDocument()
    expect(screen.getByText('150ms')).toBeInTheDocument()
    expect(screen.getByText('↓ Faster')).toBeInTheDocument()
  })

  it('formats seconds correctly', () => {
    render(
      <RebuildTimingPopover
        stats={{
          uuid: 'test',
          rebuild_count: 1,
          last_duration_ms: 1500,
          average_ms: 1500,
          median_ms: 1500,
          min_ms: 1500,
          max_ms: 1500,
          trend: null,
          history: [],
        }}
        isVisible
      />
    )
    expect(screen.getAllByText('1.50s').length).toBeGreaterThan(0)
  })

  it('shows dash for null values', () => {
    render(
      <RebuildTimingPopover
        stats={{
          uuid: 'test',
          rebuild_count: 0,
          last_duration_ms: null,
          average_ms: null,
          median_ms: null,
          min_ms: null,
          max_ms: null,
          trend: null,
          history: [],
        }}
        isVisible
      />
    )
    expect(screen.getAllByText('—').length).toBeGreaterThan(0)
  })
})

describe('RebuildButton with timing', () => {
  beforeEach(() => {
    global.fetch = vi.fn()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('fetches stats on hover', async () => {
    const mockStats = {
      uuid: 'doc1',
      rebuild_count: 1,
      last_duration_ms: 100,
      average_ms: 100,
      median_ms: 100,
      min_ms: 100,
      max_ms: 100,
      trend: 'stable',
      history: [{ duration_ms: 100, feature_count: 2, timestamp: '2024-01-01' }],
    }
    ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => mockStats,
    } as Response)

    const { container } = render(<RebuildButton docId="doc1" onClick={vi.fn()} />)
    const buttonContainer = container.querySelector('.rebuild-button-container')
    expect(buttonContainer).toBeInTheDocument()

    fireEvent.mouseEnter(buttonContainer!)

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith('/api/documents/doc1/rebuild-stats')
    })

    await waitFor(() => {
      expect(screen.getByText('Rebuild Times')).toBeInTheDocument()
    })
  })

  it('hides popover on unhover', async () => {
    const mockStats = {
      uuid: 'doc1',
      rebuild_count: 1,
      last_duration_ms: 100,
      average_ms: 100,
      median_ms: 100,
      min_ms: 100,
      max_ms: 100,
      trend: null,
      history: [],
    }
    ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => mockStats,
    } as Response)

    const { container } = render(<RebuildButton docId="doc1" onClick={vi.fn()} />)
    const buttonContainer = container.querySelector('.rebuild-button-container')

    fireEvent.mouseEnter(buttonContainer!)
    await waitFor(() => {
      expect(screen.getByText('Rebuild Times')).toBeInTheDocument()
    })

    fireEvent.mouseLeave(buttonContainer!)
    await waitFor(() => {
      expect(screen.queryByText('Rebuild Times')).not.toBeInTheDocument()
    })
  })

  it('does not fetch stats when docId is missing', async () => {
    const { container } = render(<RebuildButton onClick={vi.fn()} />)
    const buttonContainer = container.querySelector('.rebuild-button-container')

    fireEvent.mouseEnter(buttonContainer!)

    await new Promise(r => setTimeout(r, 50))
    expect(global.fetch).not.toHaveBeenCalled()
  })
})
