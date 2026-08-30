import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { BrowserRouter } from 'react-router-dom'
import AppHeader from '../AppHeader'

function wrap() {
  return render(
    <BrowserRouter>
      <AppHeader title="Test" />
    </BrowserRouter>
  )
}

// The header has no account slot and no place for one: the app runs entirely in
// this browser tab, so there is no session to show. This asserts the absence
// stays STRUCTURAL -- not a sign-in button that is hidden, not an "unavailable"
// marker, not a synthetic username standing in for a real one. Naming a
// capability the app does not have only teases it.
describe('AppHeader account slot', () => {
  it('shows no sign-in, no sign-out, and no connectivity marker', () => {
    wrap()
    expect(screen.queryByTitle('Sign out')).not.toBeInTheDocument()
    expect(screen.queryByTitle('Sign in')).not.toBeInTheDocument()
    expect(screen.queryByText(/cloud/i)).not.toBeInTheDocument()
    expect(screen.queryByText('offline')).not.toBeInTheDocument()
  })

  it('shows no username, synthetic or otherwise', () => {
    wrap()
    expect(screen.queryByText('local')).not.toBeInTheDocument()
    expect(document.querySelector('.header-username')).toBeNull()
  })

  // What the header DOES carry, so the test above cannot pass by rendering
  // nothing at all.
  it('still carries the burger, logo, title, help and bug report', () => {
    wrap()
    expect(screen.getByTitle('Copyright 2026 - Oversolved')).toBeInTheDocument()
    expect(screen.getByText('Test')).toBeInTheDocument()
    expect(screen.getByLabelText('Help')).toBeInTheDocument()
    expect(screen.getByLabelText('Report a bug')).toBeInTheDocument()
  })
})
