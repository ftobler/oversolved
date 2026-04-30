import { describe, it, expect, beforeEach } from 'vitest'
import { render, act } from '@testing-library/react'
import LoadingOverlay from '../LoadingOverlay'
import { useSolverStore } from '../../stores/solverStore'

function resetStore() {
  useSolverStore.setState({ isSolving: false })
}

describe('LoadingOverlay', () => {
  beforeEach(resetStore)

  it('is hidden when isSolving is false', () => {
    const { container } = render(<LoadingOverlay />)
    const overlay = container.querySelector('.loading-overlay')
    expect(overlay).toBeTruthy()
    expect(overlay!.classList.contains('visible')).toBe(false)
  })

  it('is visible when isSolving is true', () => {
    useSolverStore.getState().setIsSolving(true)
    const { container } = render(<LoadingOverlay />)
    const overlay = container.querySelector('.loading-overlay')
    expect(overlay!.classList.contains('visible')).toBe(true)
  })

  it('renders an SVG spinner', () => {
    const { container } = render(<LoadingOverlay />)
    const svg = container.querySelector('svg')
    expect(svg).toBeTruthy()
    const circle = svg?.querySelector('circle')
    expect(circle).toBeTruthy()
    expect(circle!.getAttribute('r')).toBe('18')
  })

  it('toggles visibility class when isSolving changes', () => {
    const { container } = render(<LoadingOverlay />)
    const overlay = container.querySelector('.loading-overlay')!
    expect(overlay.classList.contains('visible')).toBe(false)

    act(() => { useSolverStore.getState().setIsSolving(true) })
    expect(overlay.classList.contains('visible')).toBe(true)

    act(() => { useSolverStore.getState().setIsSolving(false) })
    expect(overlay.classList.contains('visible')).toBe(false)
  })

  it('spinner is a child of the overlay container', () => {
    const { container } = render(<LoadingOverlay />)
    const spinner = container.querySelector('.md3-spinner-container')!
    const content = container.querySelector('.loading-overlay-content')!
    expect(spinner.parentElement).toBe(content)
  })
})

describe('solverStore', () => {
  beforeEach(resetStore)

  it('defaults isSolving to false', () => {
    expect(useSolverStore.getState().isSolving).toBe(false)
  })

  it('setIsSolving updates isSolving', () => {
    useSolverStore.getState().setIsSolving(true)
    expect(useSolverStore.getState().isSolving).toBe(true)

    useSolverStore.getState().setIsSolving(false)
    expect(useSolverStore.getState().isSolving).toBe(false)
  })
})
