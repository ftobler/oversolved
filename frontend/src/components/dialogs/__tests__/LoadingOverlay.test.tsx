import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, act } from '@testing-library/react'
import LoadingOverlay from '@/components/dialogs/LoadingOverlay'
import { useSolverStore } from '@/stores/solverStore'

function resetStore() {
  useSolverStore.setState({ isSolving: false, onCancelSolve: null })
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

  describe('cancel button', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('does not show cancel button immediately when solving starts', () => {
      useSolverStore.getState().setIsSolving(true)
      useSolverStore.getState().setOnCancelSolve(() => {})
      const { container } = render(<LoadingOverlay />)
      expect(container.querySelector('.loading-cancel-btn')).toBeNull()
    })

    it('shows cancel button after 5 seconds of solving', () => {
      useSolverStore.getState().setIsSolving(true)
      useSolverStore.getState().setOnCancelSolve(() => {})
      const { container } = render(<LoadingOverlay />)

      act(() => { vi.advanceTimersByTime(5000) })

      const btn = container.querySelector('.loading-cancel-btn')
      expect(btn).toBeTruthy()
      expect(btn!.textContent).toBe('Cancel')
    })

    it('hides cancel button when solving ends', () => {
      useSolverStore.getState().setIsSolving(true)
      useSolverStore.getState().setOnCancelSolve(() => {})
      const { container } = render(<LoadingOverlay />)

      act(() => { vi.advanceTimersByTime(5000) })
      expect(container.querySelector('.loading-cancel-btn')).toBeTruthy()

      act(() => { useSolverStore.getState().setIsSolving(false) })
      expect(container.querySelector('.loading-cancel-btn')).toBeNull()
    })

    it('calls onCancelSolve when cancel button is clicked', () => {
      const cancelFn = vi.fn()
      useSolverStore.getState().setIsSolving(true)
      useSolverStore.getState().setOnCancelSolve(cancelFn)
      const { container } = render(<LoadingOverlay />)

      act(() => { vi.advanceTimersByTime(5000) })

      const btn = container.querySelector('.loading-cancel-btn') as HTMLButtonElement
      expect(btn).toBeTruthy()
      btn.click()

      expect(cancelFn).toHaveBeenCalledOnce()
    })

    it('does not show cancel button when onCancelSolve is null', () => {
      useSolverStore.getState().setIsSolving(true)
      // onCancelSolve remains null
      const { container } = render(<LoadingOverlay />)

      act(() => { vi.advanceTimersByTime(5000) })

      expect(container.querySelector('.loading-cancel-btn')).toBeNull()
    })

    it('does not show cancel button for document loading (only for solving)', () => {
      useSolverStore.getState().setOnCancelSolve(() => {})
      const { container } = render(<LoadingOverlay isDocumentLoading={true} />)

      act(() => { vi.advanceTimersByTime(5000) })

      // isDocumentLoading makes it visible, but cancel only appears for isSolving
      expect(container.querySelector('.loading-cancel-btn')).toBeNull()
    })

    it('resets cancel visibility when solving is toggled off then on again', () => {
      useSolverStore.getState().setIsSolving(true)
      useSolverStore.getState().setOnCancelSolve(() => {})
      const { container } = render(<LoadingOverlay />)

      act(() => { vi.advanceTimersByTime(3000) })
      expect(container.querySelector('.loading-cancel-btn')).toBeNull()

      // Toggle solving off resets the timer
      act(() => { useSolverStore.getState().setIsSolving(false) })
      act(() => { useSolverStore.getState().setIsSolving(true) })

      act(() => { vi.advanceTimersByTime(3000) })
      expect(container.querySelector('.loading-cancel-btn')).toBeNull()

      act(() => { vi.advanceTimersByTime(2000) })
      expect(container.querySelector('.loading-cancel-btn')).toBeTruthy()
    })
  })
})
