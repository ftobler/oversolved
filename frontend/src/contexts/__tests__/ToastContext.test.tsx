import { describe, it, expect } from 'vitest'
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'
import { memo } from 'react'
import { ToastProvider, useNotify } from '@/contexts/ToastContext'

// Memoize context values: the value object handed to ToastContext.Provider must keep
// its identity across renders that do not touch notify (e.g. the snackbar opening or
// closing), so a consumer wrapped in React.memo does not re-render for unrelated
// reasons.
describe('ToastContext', () => {
  it('notify shows a toast with the given message and severity', async () => {
    function Trigger() {
      const notify = useNotify()
      return (
        <button data-testid="fire" onClick={() => notify('hello there', 'error')}>
          fire
        </button>
      )
    }

    render(
      <ToastProvider>
        <Trigger />
      </ToastProvider>,
    )

    await act(async () => {
      fireEvent.click(screen.getByTestId('fire'))
    })

    await waitFor(() => {
      expect(screen.getByText('hello there')).toBeInTheDocument()
    })
  })

  it('does not re-render a memoized consumer when only the snackbar open/close state changes', async () => {
    // useContext forces a re-render on any consumer whenever the provider hands out
    // a NEW value object, regardless of React.memo on the consumer itself (memo only
    // protects against prop changes, not context changes). So a memoized consumer
    // that never re-renders across a notify() call is direct proof the context value
    // object kept its identity even though ToastProvider's internal snackbar state
    // (open/message/severity) changed underneath it.
    let renderCount = 0
    const Consumer = memo(function Consumer() {
      const notify = useNotify()
      renderCount++
      return (
        <button data-testid="fire" onClick={() => notify('hi there')}>
          fire
        </button>
      )
    })

    render(
      <ToastProvider>
        <Consumer />
      </ToastProvider>,
    )
    expect(renderCount).toBe(1)

    await act(async () => {
      fireEvent.click(screen.getByTestId('fire'))
    })
    await waitFor(() => {
      expect(screen.getByText('hi there')).toBeInTheDocument()
    })

    expect(renderCount).toBe(1)
  })
})
