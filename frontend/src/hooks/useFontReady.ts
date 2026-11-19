import { useEffect, useState } from 'react'

// The splash title is the first paint, before the self-hosted Roboto faces are
// in memory, so it renders in `system-ui` and swaps once Roboto arrives. That
// swap visibly changes the wordmark's spacing, so the title waits for the face
// the header wordmark uses. `document.fonts.load` matches on family and weight;
// the size only has to be representative. The text narrows the request to the
// unicode subsets the wordmark draws: without it fontsource's whole family
// (cyrillic, greek and the rest) would be fetched for one latin word.
export const SPLASH_TITLE_TEXT = 'Oversolved'
export const SPLASH_TITLE_FONT = '700 2rem Roboto'

// A local fetch, so this is a ceiling for a broken disk cache or a stalled
// load, not an expected wait. Past it the title shows in whatever font is
// there rather than never appearing.
export const FONT_READY_CEILING_MS = 300

interface FontFaceSetLike {
  load?: (font: string, text?: string) => Promise<unknown>
  check?: (font: string, text?: string) => boolean
}

// `document.fonts` is absent under jsdom and on old browsers.
function fontFaceSet(): FontFaceSetLike | undefined {
  return (globalThis as { document?: { fonts?: FontFaceSetLike } }).document?.fonts
}

/**
 * True once `font` has loaded, or after `ceilingMs` at the latest.
 *
 * Missing `document.fonts` means ready: a test DOM, or a browser old enough
 * that waiting for it could never end. The caller hides only the title while
 * this is false, so a slow font never blocks the progress line.
 */
export function useFontReady(
  font: string = SPLASH_TITLE_FONT,
  ceilingMs: number = FONT_READY_CEILING_MS,
): boolean {
  // Probed at render: without a loader there is nothing to await, and setting
  // that state from the effect body would cost a render in the same commit.
  // `check` covers the face already being usable (a reload, or another element
  // having required it), where holding the title would only delay it.
  const [ready, setReady] = useState(() => {
    const fonts = fontFaceSet()
    if (!fonts?.load) return true
    try {
      return fonts.check?.(font, SPLASH_TITLE_TEXT) ?? false
    } catch {
      // A malformed shorthand must not take the boot down; the effect's load
      // below gets the same protection.
      return false
    }
  })
  useEffect(() => {
    if (ready) return
    let live = true
    const settle = () => {
      if (live) setReady(true)
    }
    let pending: Promise<unknown> | undefined
    try {
      pending = fontFaceSet()?.load?.(font, SPLASH_TITLE_TEXT)
    } catch {
      // Settle off the effect body so a hostile FontFaceSet reveals the title
      // without a synchronous second render; the cleanup still owns the timer.
      const fallbackTimer = setTimeout(settle, 0)
      return () => {
        live = false
        clearTimeout(fallbackTimer)
      }
    }
    // Either outcome shows the title. A failed local fetch leaves the fallback,
    // which looks wrong but is far better than a title that never appears.
    const timer = setTimeout(settle, ceilingMs)
    pending?.then(
      () => { clearTimeout(timer); settle() },
      () => { clearTimeout(timer); settle() },
    )
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [ready, font, ceilingMs])
  return ready
}
