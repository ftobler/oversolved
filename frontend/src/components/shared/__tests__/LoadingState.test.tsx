import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { LoadingState } from '@/components/shared/LoadingState'

describe('LoadingState', () => {
  it('announces itself as a polite status with the default label and a spinner', () => {
    const { container } = render(<LoadingState />)
    const status = screen.getByRole('status')
    expect(status).toHaveAttribute('aria-live', 'polite')
    expect(status).toHaveTextContent('Loading...')
    expect(container.querySelector('.loading-state-spinner svg')).toBeTruthy()
    expect(container.querySelector('.loading-state-path')).toBeTruthy()
  })

  it('shows the caller label', () => {
    render(<LoadingState label="Loading workspace..." />)
    expect(screen.getByRole('status')).toHaveTextContent('Loading workspace...')
  })
})
