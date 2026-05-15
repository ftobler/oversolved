import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import WsStatusIndicator from '@/components/WsStatusIndicator'
import { useSolverStore } from '@/stores/solverStore'

vi.mock('../../hooks/solverWs', () => ({
  solverWs: {
    connect: vi.fn(),
    disconnect: vi.fn(),
  },
}))

import { solverWs } from '@/hooks/solverWs'

beforeEach(() => {
  vi.clearAllMocks()
  useSolverStore.setState({ wsStatus: 'closed' })
})

describe('WsStatusIndicator', () => {
  it('shows connected state with disconnect button', () => {
    useSolverStore.setState({ wsStatus: 'open' })
    render(<WsStatusIndicator />)
    expect(screen.getByText('Connected')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeInTheDocument()
  })

  it('shows disconnected state with connect button', () => {
    useSolverStore.setState({ wsStatus: 'closed' })
    render(<WsStatusIndicator />)
    expect(screen.getByText('Disconnected')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Connect' })).toBeInTheDocument()
  })

  it('shows connecting state with disabled button', () => {
    useSolverStore.setState({ wsStatus: 'connecting' })
    render(<WsStatusIndicator />)
    expect(screen.getAllByText('Connecting...')).not.toHaveLength(0)
    expect(screen.getByRole('button')).toBeDisabled()
  })

  it('disconnect button calls solverWs.disconnect()', () => {
    useSolverStore.setState({ wsStatus: 'open' })
    render(<WsStatusIndicator />)
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }))
    expect(solverWs.disconnect).toHaveBeenCalledOnce()
  })

  it('connect button calls solverWs.connect()', () => {
    useSolverStore.setState({ wsStatus: 'closed' })
    render(<WsStatusIndicator />)
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    expect(solverWs.connect).toHaveBeenCalledOnce()
  })
})
