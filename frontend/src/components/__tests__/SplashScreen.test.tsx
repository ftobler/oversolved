// The splash's first paint must not show the wordmark in the fallback font: it
// would visibly change spacing when the 700 Roboto face arrives. The title is
// held hidden until then; everything else on the splash stays visible, so the
// hold must never look like a stalled load.
import { describe, it, expect, afterEach } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import SplashScreen from '@/components/SplashScreen'

function stubDeferredFont(): () => void {
  let resolveLoad: () => void = () => {}
  Object.defineProperty(document, 'fonts', {
    value: {
      load: () => new Promise<void>(resolve => { resolveLoad = resolve }),
    },
    configurable: true,
    writable: true,
  })
  return () => resolveLoad()
}

describe('SplashScreen wordmark font', () => {
  afterEach(() => {
    Reflect.deleteProperty(document as object, 'fonts')
  })

  it('holds only the title pending until the face loads', async () => {
    const resolveLoad = stubDeferredFont()
    render(<SplashScreen debugHold />)

    const title = screen.getByRole('heading', { name: 'Oversolved' })
    // Exactly the title carries the pending class; jsdom applies no CSS, so the
    // opacity rule itself is pinned in the brand wordmark CSS guard.
    const pending = document.querySelectorAll('.splash-screen-title-pending')
    expect(pending).toHaveLength(1)
    expect(pending[0]).toBe(title)
    expect(screen.getByText('Loading solvers...')).toBeInTheDocument()

    await act(async () => {
      resolveLoad()
      await Promise.resolve()
    })

    expect(title).not.toHaveClass('splash-screen-title-pending')
    expect(document.querySelectorAll('.splash-screen-title-pending')).toHaveLength(0)
    expect(screen.getByText('Loading solvers...')).toBeInTheDocument()
  })

  it('shows the title immediately when the DOM has no FontFaceSet', () => {
    render(<SplashScreen debugHold />)
    expect(screen.getByRole('heading', { name: 'Oversolved' })).not.toHaveClass(
      'splash-screen-title-pending',
    )
  })
})
