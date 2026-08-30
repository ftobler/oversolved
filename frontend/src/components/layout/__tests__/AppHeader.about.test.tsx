import { describe, it, expect, beforeEach, afterEach } from 'vitest'

import { render, screen, fireEvent, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import AppHeader from '../AppHeader'
import { useAboutDialogStore } from '@/stores/aboutDialogStore'

function wrap(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppHeader title="Test" />
    </MemoryRouter>,
  )
}

describe('AppHeader burger on the documents overview', () => {
  beforeEach(() => {
    useAboutDialogStore.getState().closeAbout()
  })
  afterEach(() => { act(() => { useAboutDialogStore.getState().closeAbout() }) })

  it('opens the about notice instead of navigating nowhere', () => {
    wrap('/documents')
    act(() => { fireEvent.click(screen.getByTitle('About Oversolved')) })
    expect(useAboutDialogStore.getState().open).toBe(true)
  })

  it('still navigates to the overview from a document page', () => {
    wrap('/documents/abc')
    expect(screen.getByTitle('Documents')).toBeTruthy()
    act(() => { fireEvent.click(screen.getByTitle('Documents')) })
    expect(useAboutDialogStore.getState().open).toBe(false)
  })

  it('carries the copyright note on the logo', () => {
    wrap('/documents')
    expect(screen.getByTitle('Copyright 2026 - Oversolved')).toBeTruthy()
  })
})
