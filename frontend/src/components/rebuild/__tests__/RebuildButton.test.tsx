import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { RebuildButton } from '@/components/rebuild/RebuildButton'

const defaultProps = {
  featureTimings: {},
  features: [],
  onClick: vi.fn(),
}

describe('RebuildButton', () => {
  it('renders rebuild icon', () => {
    render(<RebuildButton {...defaultProps} />)
    expect(screen.getByRole('button', { name: /Rebuild geometry/i })).toBeInTheDocument()
  })

  it('calls onClick when clicked', () => {
    const onClick = vi.fn()
    render(<RebuildButton {...defaultProps} onClick={onClick} />)
    fireEvent.click(screen.getByRole('button', { name: /Rebuild geometry/i }))
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('is disabled when isLoading is true', () => {
    render(<RebuildButton {...defaultProps} isLoading />)
    expect(screen.getByRole('button', { name: /Rebuild geometry/i })).toBeDisabled()
  })

  it('is disabled when disabled prop is true', () => {
    render(<RebuildButton {...defaultProps} disabled />)
    expect(screen.getByRole('button', { name: /Rebuild geometry/i })).toBeDisabled()
  })

  it('shows spinner when isLoading is true', () => {
    const { container } = render(<RebuildButton {...defaultProps} isLoading />)
    expect(container.querySelector('.rebuild-spinner')).toBeInTheDocument()
  })

  it('shows icon when not loading', () => {
    const { container } = render(<RebuildButton {...defaultProps} />)
    expect(container.querySelector('.rebuild-spinner')).not.toBeInTheDocument()
    expect(container.querySelector('img')).toBeInTheDocument()
  })

  // The container is one inline-flex row, so the DOM order is the visual order:
  // the total time first, the arrow right of it. A missing label must not turn
  // that into a bare button with a stray sibling.
  it('puts the total time left of the arrow, in that order', () => {
    const { container } = render(
      <RebuildButton {...defaultProps} featureTimings={{ ex1: 1000, ex2: 740 }} />,
    )
    const label = container.querySelector('.rebuild-time-label')
    expect(label).not.toBeNull()
    expect(label!.textContent).toBe('1.74s')
    expect(label!.nextElementSibling).toHaveClass('rebuild-button')
  })

  it('renders no time label when nothing has been timed', () => {
    const { container } = render(<RebuildButton {...defaultProps} />)
    expect(container.querySelector('.rebuild-time-label')).toBeNull()
    const row = container.querySelector('.rebuild-button-container') as HTMLElement
    expect(row.firstElementChild).toHaveClass('rebuild-button')
  })

  // A hover-then-navigate-away can unmount while the 500ms hide delay is still
  // pending. Asserting a global clearTimeout was called proves nothing about
  // that timer; the cleanup must actually cancel the one hide work that was
  // scheduled, or it survives the unmount and later sets state on a gone
  // component. The fake-timer count is the observable.
  it('cancels the pending hide timer on unmount', () => {
    vi.useFakeTimers()
    try {
      const { unmount } = render(<RebuildButton {...defaultProps} />)
      const button = screen.getByRole('button', { name: /Rebuild geometry/i })
      fireEvent.mouseEnter(button)
      fireEvent.mouseLeave(button)  // schedules the 500ms hide

      const pending = vi.getTimerCount()
      expect(pending).toBeGreaterThan(0)

      unmount()

      expect(vi.getTimerCount()).toBe(pending - 1)
    } finally {
      vi.useRealTimers()
    }
  })

  describe('validation badge', () => {
    const propsWithEntries = {
      ...defaultProps,
      featureTimings: { ex1: 12 },
      features: [{ id: 'ex1', kind: 'extrude', label: 'Extrude 1' }] as never,
    }

    it('renders green badge when validation passes', () => {
      render(
        <RebuildButton
          {...propsWithEntries}
          validation={{ level: 3, passed: true, diffs: {} }}
        />
      )
      // Force hover so popover is visible
      fireEvent.mouseEnter(screen.getByRole('button', { name: /Rebuild geometry/i }))
      const badge = screen.getByTestId('rebuild-validation-badge')
      expect(badge.getAttribute('data-validation-kind')).toBe('green')
    })

    it('renders yellow badge when validation is fp-only', () => {
      render(
        <RebuildButton
          {...propsWithEntries}
          validation={{ level: 2, passed: false, fp_only: true, diffs: {} }}
        />
      )
      fireEvent.mouseEnter(screen.getByRole('button', { name: /Rebuild geometry/i }))
      const badge = screen.getByTestId('rebuild-validation-badge')
      expect(badge.getAttribute('data-validation-kind')).toBe('yellow')
    })

    it('renders red badge when validation fails structurally', () => {
      render(
        <RebuildButton
          {...propsWithEntries}
          validation={{ level: 3, passed: false, diffs: { repo_ancestral: {} } }}
        />
      )
      fireEvent.mouseEnter(screen.getByRole('button', { name: /Rebuild geometry/i }))
      const badge = screen.getByTestId('rebuild-validation-badge')
      expect(badge.getAttribute('data-validation-kind')).toBe('red')
    })

    it('renders no badge when validation is not provided', () => {
      render(<RebuildButton {...propsWithEntries} />)
      fireEvent.mouseEnter(screen.getByRole('button', { name: /Rebuild geometry/i }))
      expect(screen.queryByTestId('rebuild-validation-badge')).toBeNull()
    })
  })
})
