import { StrictMode } from 'react'
import { renderHook } from '@testing-library/react'

/**
 * renderHook under StrictMode, which double-invokes every setState updater.
 *
 * The app itself runs in StrictMode (`main.tsx`), so a hook that side-effects
 * inside an updater behaves differently in the app than under a bare
 * renderHook: the side effect replays. A pure derivation from `prev` is
 * idempotent and survives, an accumulating one does not, so the corruption
 * shows up on only one side of an operation and reads like a logic bug.
 *
 * That is exactly how the undo/redo duplication shipped past a test written to
 * catch it. Prefer this over renderHook for any hook that mutates refs,
 * external stores, or other state from inside an updater.
 */
export const renderHookStrict: typeof renderHook = (callback, options) =>
  renderHook(callback, { ...options, wrapper: StrictMode })
