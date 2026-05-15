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
})
