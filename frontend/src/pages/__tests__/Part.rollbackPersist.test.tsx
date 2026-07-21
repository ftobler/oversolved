import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import CssBaseline from '@mui/material/CssBaseline'
import { ToastProvider } from '@/contexts/ToastContext'
import { usePartEditorStore } from '@/stores/partEditorStore'
import Part from '@/pages/Part'

vi.mock('@/kernel/solveLocally', () => ({
  solveLocally: vi.fn().mockResolvedValue({ result: {}, bodies: {}, pick_bodies: {}, _build_state: null }),
}))

vi.mock('../../components/Viewport', () => ({
  default: vi.fn(() => null),
  __esModule: true,
}))

// Built-ins are spelled out so feature indices (and therefore rollback
// positions) line up with what the tree renders: 0..3 built-in, 4 sk1, 5 ex1.
function docContent(rollbackLine: string) {
  return `version: 1
kind: part
${rollbackLine}features:
  - id: Origin
    kind: origin
  - id: Top
    kind: plane
  - id: Front
    kind: plane
  - id: Right
    kind: plane
  - id: sk1
    kind: sketch
    label: sketch 1
  - id: ex1
    kind: extrude
    label: extrude 1
    extrude: { sketch: '$sk1', distance: 10, direction: 'normal' }
`
}

function mockFetch(rollbackLine: string) {
  return vi.fn((url: string) => {
    if (url === '/api/auth/me') {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ user: { id: 1, username: 'admin', must_change_password: false } }),
      } as Response)
    }
    if (url === '/api/documents/doc-1') {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          uuid: 'doc-1',
          name: 'TestDoc',
          content: docContent(rollbackLine),
          permission: 'owner',
        }),
      } as Response)
    }
    return Promise.resolve({ ok: false, status: 404 } as Response)
  })
}

// The rollback bar drags on pointer events, not HTML5 drag-and-drop.
function grabRollback(bar: Element) {
  fireEvent(bar, new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }))
}

function releasePointer(clientY: number) {
  fireEvent(window, new MouseEvent('pointerup', { clientY }))
}

// jsdom reports a zero rect for everything, but the drop-slot maths needs real
// rows: lay the feature items out as a 40px stack starting at y = 0.
function layoutFeatureRows() {
  document.querySelectorAll('.feature-item').forEach((el, i) => {
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
      top: i * 40, bottom: i * 40 + 40, height: 40,
      left: 0, right: 200, width: 200, x: 0, y: i * 40,
      toJSON: () => {},
    })
  })
}

const theme = createTheme()
function Wrapper({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <ToastProvider>{children}</ToastProvider>
    </ThemeProvider>
  )
}

function renderPart() {
  return render(
    <MemoryRouter initialEntries={['/documents/doc-1']}>
      <Routes>
        <Route path="/documents/:uuid" element={<Part />} />
      </Routes>
    </MemoryRouter>,
    { wrapper: Wrapper }
  )
}

describe('rollback bar position round trips through the document', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    usePartEditorStore.getState().setRollbackPosition(null)
  })

  it('reopens the document with the bar where it was saved', async () => {
    vi.stubGlobal('fetch', mockFetch('rollback: 5\n'))
    renderPart()

    await waitFor(() => {
      expect(screen.getByText('extrude 1')).toBeInTheDocument()
    })

    await waitFor(() => {
      expect(usePartEditorStore.getState().rollbackPosition).toBe(5)
    })
    // The feature past the bar is drawn as rolled back.
    expect(screen.getByText('extrude 1').closest('.feature-item')!.classList.contains('rolled-back')).toBe(true)
    expect(screen.getByText('sketch 1').closest('.feature-item')!.classList.contains('rolled-back')).toBe(false)
  })

  it('falls back to the end of the stack when the doc has no saved position', async () => {
    vi.stubGlobal('fetch', mockFetch(''))
    renderPart()

    await waitFor(() => {
      expect(screen.getByText('extrude 1')).toBeInTheDocument()
    })

    await waitFor(() => {
      expect(usePartEditorStore.getState().rollbackPosition).toBe(6)
    })
    expect(screen.getByText('extrude 1').closest('.feature-item')!.classList.contains('rolled-back')).toBe(false)
  })

  it('clamps a saved position that outlives the features it pointed past', async () => {
    vi.stubGlobal('fetch', mockFetch('rollback: 99\n'))
    renderPart()

    await waitFor(() => {
      expect(screen.getByText('extrude 1')).toBeInTheDocument()
    })

    await waitFor(() => {
      expect(usePartEditorStore.getState().rollbackPosition).toBe(6)
    })
  })

  it('writes the position into the doc when the user drags the bar', async () => {
    vi.stubGlobal('fetch', mockFetch(''))
    renderPart()

    await waitFor(() => {
      expect(screen.getByText('extrude 1')).toBeInTheDocument()
    })

    layoutFeatureRows()
    const bars = screen.getAllByTitle('Rollback')
    grabRollback(bars[bars.length - 1])
    releasePointer(210)  // top half of ex1 (row 5 spans 200..240) -> before ex1

    await waitFor(() => {
      expect(usePartEditorStore.getState().rollbackPosition).toBe(5)
    })
    expect(usePartEditorStore.getState().doc?.rollback).toBe(5)
  })

  it('removes the position from the doc when the user drags the bar back to the end', async () => {
    vi.stubGlobal('fetch', mockFetch('rollback: 5\n'))
    renderPart()

    await waitFor(() => {
      expect(screen.getByText('extrude 1')).toBeInTheDocument()
    })
    await waitFor(() => {
      expect(usePartEditorStore.getState().rollbackPosition).toBe(5)
    })

    layoutFeatureRows()
    grabRollback(screen.getAllByTitle('Rollback')[0])
    releasePointer(230)  // bottom half of ex1 -> after ex1, i.e. the end

    await waitFor(() => {
      expect(usePartEditorStore.getState().rollbackPosition).toBe(6)
    })
    expect(usePartEditorStore.getState().doc).not.toHaveProperty('rollback')
  })
})
