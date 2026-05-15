import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { RebuildButton } from '@/components/RebuildButton'

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
