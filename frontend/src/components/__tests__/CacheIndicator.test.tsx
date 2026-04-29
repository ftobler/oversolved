import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import CacheIndicator from '../CacheIndicator'

describe('CacheIndicator', () => {
  it('renders nothing when not visible', () => {
    const { container } = render(<CacheIndicator visible={false} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders cached badge when visible', () => {
    render(<CacheIndicator visible={true} />)
    expect(screen.getByText('Cached')).toBeInTheDocument()
    expect(screen.getByText('📦')).toBeInTheDocument()
  })

  it('shows fresh styling by default', () => {
    render(<CacheIndicator visible={true} />)
    const indicator = screen.getByText('Cached').closest('.cache-indicator')
    expect(indicator).toHaveClass('cache-fresh')
  })

  it('shows stale styling when not fresh', () => {
    render(<CacheIndicator visible={true} isFresh={false} />)
    const indicator = screen.getByText('Cached').closest('.cache-indicator')
    expect(indicator).toHaveClass('cache-stale')
  })

  it('displays age text when timestamp is provided', () => {
    const timestamp = Date.now() - 2 * 60 * 1000
    render(<CacheIndicator visible={true} timestamp={timestamp} />)
    expect(screen.getByText('2m ago')).toBeInTheDocument()
  })

  it('has tooltip on age element', () => {
    const timestamp = Date.now() - 2 * 60 * 1000
    render(<CacheIndicator visible={true} timestamp={timestamp} />)
    const age = screen.getByText('2m ago')
    expect(age).toHaveAttribute('title', expect.stringContaining('2m ago'))
  })
})
