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

function createDragEvent(type: string, overrides: Record<string, unknown> = {}) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, ...overrides })
  Object.defineProperty(event, 'dataTransfer', {
    value: { effectAllowed: '', dropEffect: 'move', setData: vi.fn(), getData: vi.fn(() => '') },
    configurable: true,
  })
  return event
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

    const bars = screen.getAllByTitle('Rollback')
    const bar = bars[bars.length - 1]
    const extrudeItem = screen.getByText('extrude 1').closest('.feature-item')!
    vi.spyOn(extrudeItem, 'getBoundingClientRect').mockReturnValue({
      top: 100, left: 0, width: 200, height: 40, bottom: 140, right: 200, x: 0, y: 100,
      toJSON: () => {},
    })

    fireEvent(bar, createDragEvent('dragstart'))
    fireEvent(extrudeItem, createDragEvent('dragover', { clientY: 110 }))  // top half -> before ex1
    fireEvent(extrudeItem, createDragEvent('drop'))

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

    const bar = screen.getAllByTitle('Rollback')[0]
    const extrudeItem = screen.getByText('extrude 1').closest('.feature-item')!
    vi.spyOn(extrudeItem, 'getBoundingClientRect').mockReturnValue({
      top: 100, left: 0, width: 200, height: 40, bottom: 140, right: 200, x: 0, y: 100,
      toJSON: () => {},
    })

    fireEvent(bar, createDragEvent('dragstart'))
    fireEvent(extrudeItem, createDragEvent('dragover', { clientY: 130 }))  // bottom half -> after ex1
    fireEvent(extrudeItem, createDragEvent('drop'))

    await waitFor(() => {
      expect(usePartEditorStore.getState().rollbackPosition).toBe(6)
    })
    expect(usePartEditorStore.getState().doc).not.toHaveProperty('rollback')
  })
})
