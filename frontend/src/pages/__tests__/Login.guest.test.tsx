import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import Login from '@/pages/Login'

// Guest-first: the login page must offer a way to skip the cloud sign-in and drop
// straight into the local document library without any account.

function renderLoginAt() {
  return render(
    <MemoryRouter initialEntries={['/login']}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/documents" element={<div>documents landing</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('Login guest entry', () => {
  afterEach(() => {
    cleanup()
  })

  it('navigates to the documents library without signing in', () => {
    renderLoginAt()
    fireEvent.click(screen.getByText('Continue without signing in'))
    expect(screen.getByText('documents landing')).toBeTruthy()
  })
})
