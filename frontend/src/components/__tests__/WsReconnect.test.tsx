import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import WsReconnect from '../WsReconnect'
import { solverWs } from '../../hooks/solverWs'

vi.mock('../../hooks/solverWs', () => ({
  solverWs: {
    ws: null,
    disconnect: vi.fn(),
    connect: vi.fn(),
  },
}))

describe('WsReconnect', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows current WS state', () => {
    render(<WsReconnect />)
    expect(screen.getByText(/closed/)).toBeInTheDocument()
  })

  it('reconnect button calls disconnect + connect', () => {
    render(<WsReconnect />)
    fireEvent.click(screen.getByRole('button', { name: /Reconnect/i }))
    expect(solverWs.disconnect).toHaveBeenCalled()
    expect(solverWs.connect).toHaveBeenCalled()
  })
})
