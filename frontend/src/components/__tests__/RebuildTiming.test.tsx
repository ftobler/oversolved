import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { RebuildButton } from '@/components/RebuildButton'
import { RebuildSparkline } from '@/components/RebuildSparkline'
import { RebuildTimingPopover } from '@/components/RebuildTimingPopover'

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
  const sampleFeatures = [
    { id: 'sketch1', kind: 'sketch', label: 'Sketch 1' },
    { id: 'extrude1', kind: 'extrude', label: 'Extrude 1' },
  ]

  it('returns null when not visible', () => {
    const { container } = render(
      <RebuildTimingPopover
        featureTimings={{ sketch1: 2.3, extrude1: 1.1 }}
        features={sampleFeatures}
        isVisible={false}
      />
    )
    expect(container.firstChild).toBeNull()
  })

  it('returns null when no features have timings', () => {
    const { container } = render(
      <RebuildTimingPopover
        featureTimings={{}}
        features={sampleFeatures}
        isVisible
      />
    )
    expect(container.firstChild).toBeNull()
  })

  it('renders per-feature timings when visible', () => {
    render(
      <RebuildTimingPopover
        featureTimings={{ sketch1: 2.3, extrude1: 1.1 }}
        features={sampleFeatures}
        isVisible
      />
    )
    expect(screen.getByText('Rebuild Times')).toBeInTheDocument()
    expect(screen.getByText('Sketch 1:')).toBeInTheDocument()
    expect(screen.getByText('Extrude 1:')).toBeInTheDocument()
    expect(screen.getByText('2ms')).toBeInTheDocument()
    expect(screen.getByText('1ms')).toBeInTheDocument()
  })

  it('shows total at the bottom', () => {
    render(
      <RebuildTimingPopover
        featureTimings={{ sketch1: 2.3, extrude1: 1.1 }}
        features={sampleFeatures}
        isVisible
      />
    )
    expect(screen.getByText('Total:')).toBeInTheDocument()
    expect(screen.getByText('3ms')).toBeInTheDocument()
  })

  it('formats seconds correctly', () => {
    render(
      <RebuildTimingPopover
        featureTimings={{ slow: 1500 }}
        features={[{ id: 'slow', kind: 'extrude', label: 'Slow' }]}
        isVisible
      />
    )
    expect(screen.getAllByText('1.50s').length).toBeGreaterThan(0)
  })

  it('uses kind as label when no label is set', () => {
    render(
      <RebuildTimingPopover
        featureTimings={{ f1: 5 }}
        features={[{ id: 'f1', kind: 'sketch' }]}
        isVisible
      />
    )
    expect(screen.getByText('sketch:')).toBeInTheDocument()
  })
})

describe('RebuildButton with timing', () => {
  const baseProps = {
    featureTimings: { sketch1: 2.3, extrude1: 1.1 },
    features: [
      { id: 'sketch1', kind: 'sketch', label: 'Sketch 1' },
      { id: 'extrude1', kind: 'extrude', label: 'Extrude 1' },
    ],
    onClick: vi.fn(),
  }

  it('shows popover on hover', async () => {
    const { container } = render(<RebuildButton {...baseProps} />)
    const button = container.querySelector('.rebuild-button')
    expect(button).toBeInTheDocument()

    fireEvent.mouseEnter(button!)

    await waitFor(() => {
      expect(screen.getByText('Rebuild Times')).toBeInTheDocument()
    })
  })

  it('hides popover after 500ms delay on unhover', async () => {
    render(<RebuildButton {...baseProps} />)
    const button = screen.getByRole('button', { name: /Rebuild geometry/i })

    fireEvent.mouseEnter(button)
    await waitFor(() => {
      expect(screen.getByText('Rebuild Times')).toBeInTheDocument()
    })

    fireEvent.mouseLeave(button)

    expect(screen.getByText('Rebuild Times')).toBeInTheDocument()

    await waitFor(() => {
      expect(screen.queryByText('Rebuild Times')).not.toBeInTheDocument()
    }, { timeout: 1000 })
  })

  it('shows nothing on hover when no timings exist', async () => {
    render(<RebuildButton {...baseProps} featureTimings={{}} />)
    const button = screen.getByRole('button', { name: /Rebuild geometry/i })

    fireEvent.mouseEnter(button)

    await new Promise(r => setTimeout(r, 100))
    expect(screen.queryByText('Rebuild Times')).not.toBeInTheDocument()
  })
})
