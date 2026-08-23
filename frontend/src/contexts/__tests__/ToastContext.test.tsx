import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
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

// The snackbar must remount per notification: MUI arms its auto-hide effect on
// mount only, so without the per-notification remount a second notify() while
// the snackbar is open inherits whatever was left of the first toast's 5s
// window and vanishes early.
describe('ToastContext auto-hide', () => {
  function Trigger() {
    const notify = useNotify()
    return (
      <>
        <button data-testid="save" onClick={() => notify('saved')}>
          save
        </button>
        <button data-testid="fail" onClick={() => notify('save failed', 'error')}>
          fail
        </button>
      </>
    )
  }

  const fire = async (testId: string) => {
    await act(async () => {
      fireEvent.click(screen.getByTestId(testId))
    })
  }

  // Async advancing lets React flush between chained timers. After a toast's
  // auto-hide timer fires, the Grow exit transition fallback only gets
  // scheduled on the open:false re-render, so it takes one further advance
  // before the alert actually leaves the DOM.
  const advance = async (ms: number) => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms)
    })
  }

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('a single notification stays up for its full duration then hides', async () => {
    render(
      <ToastProvider>
        <Trigger />
      </ToastProvider>,
    )

    await fire('save')
    expect(screen.getByText('saved')).toBeInTheDocument()

    await advance(4999)
    expect(screen.getByText('saved')).toBeInTheDocument()

    await advance(1)
    await advance(300)
    expect(screen.queryByText('saved')).not.toBeInTheDocument()
  })

  it('a second notification gets a full window instead of inheriting the first one remainder', async () => {
    render(
      <ToastProvider>
        <Trigger />
      </ToastProvider>,
    )

    await fire('save')
    await advance(4000)
    expect(screen.getByText('saved')).toBeInTheDocument()

    // One second left on the 'saved' window when the error arrives.
    await fire('fail')
    expect(screen.getByText('save failed')).toBeInTheDocument()

    await advance(999)
    expect(screen.getByText('save failed')).toBeInTheDocument()

    // t=5000: the original 'saved' timer elapses here; the error toast must
    // survive past it because it remounted with its own timer at t=4000.
    await advance(1)
    await advance(300)
    expect(screen.getByText('save failed')).toBeInTheDocument()

    await advance(3699)
    expect(screen.getByText('save failed')).toBeInTheDocument()

    await advance(1)
    await advance(300)
    expect(screen.queryByText('save failed')).not.toBeInTheDocument()
  })
})
