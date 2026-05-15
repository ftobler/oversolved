import { useSolverStore, type WsStatus } from '@/stores/solverStore'
import { solverWs } from '@/hooks/solverWs'

const DOT_COLORS: Record<WsStatus, string> = {
  open: '#4caf50',
  connecting: '#ff9800',
  closed: '#f44336',
  reconnecting: '#ff9800',
}

const LABELS: Record<WsStatus, string> = {
  open: 'Connected',
  connecting: 'Connecting...',
  closed: 'Disconnected',
  reconnecting: 'Reconnecting...',
}

export default function WsStatusIndicator() {
  const wsStatus = useSolverStore(s => s.wsStatus)

  function handleClick() {
    if (wsStatus === 'open') {
      solverWs.disconnect()
    } else if (wsStatus === 'closed') {
      solverWs.connect()
    }
    // reconnecting: do nothing (auto-reconnect is in progress)
  }

  return (
    <div className="ws-status">
      <span
        className="ws-status-dot"
        style={{ backgroundColor: DOT_COLORS[wsStatus] }}
      />
      <span>{LABELS[wsStatus]}</span>
      <button
        className="ws-status-btn"
        onClick={handleClick}
        disabled={wsStatus === 'connecting' || wsStatus === 'reconnecting'}
      >
        {wsStatus === 'open' ? 'Disconnect' : wsStatus === 'connecting' || wsStatus === 'reconnecting' ? 'Connecting...' : 'Connect'}
      </button>
    </div>
  )
}
