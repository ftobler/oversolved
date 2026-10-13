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

describe('AppHeader burger on the workspace overview', () => {
  beforeEach(() => {
    useAboutDialogStore.getState().closeAbout()
  })
  afterEach(() => { act(() => { useAboutDialogStore.getState().closeAbout() }) })

  it('opens the about notice instead of navigating nowhere', () => {
    const { container } = wrap('/workspaces')
    act(() => { fireEvent.click(container.querySelector('.burger')!) })
    expect(useAboutDialogStore.getState().open).toBe(true)
  })

  it('still navigates to the overview from a workspace page', () => {
    wrap('/workspaces/ws/entries/abc')
    expect(screen.getByTitle('Workspaces')).toBeTruthy()
    act(() => { fireEvent.click(screen.getByTitle('Workspaces')) })
    expect(useAboutDialogStore.getState().open).toBe(false)
  })

  it('opens the about notice from the octocat button on any page', () => {
    wrap('/workspaces/ws/entries/abc')
    act(() => { fireEvent.click(screen.getByRole('button', { name: 'About Oversolved' })) })
    expect(useAboutDialogStore.getState().open).toBe(true)
  })

  it('carries the copyright note on the logo', () => {
    wrap('/workspaces')
    expect(screen.getByTitle('Copyright 2026 - Oversolved')).toBeTruthy()
  })
})
