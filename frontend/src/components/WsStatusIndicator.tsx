import { useSolverStore, type WsStatus } from '@/stores/solverStore'
import { solverWs } from '@/hooks/solverWs'

const DOT_COLORS: Record<WsStatus, string> = {
  open: '#4caf50',
  connecting: '#ff9800',
  reconnecting: '#ff9800',
  closed: '#f44336',
}

const LABELS: Record<WsStatus, string> = {
  open: 'Connected',
  connecting: 'Connecting...',
  reconnecting: 'Reconnecting...',
  closed: 'Disconnected',
}

export default function WsStatusIndicator() {
  const wsStatus = useSolverStore(s => s.wsStatus)

  function handleClick() {
    if (wsStatus === 'open') {
      solverWs.disconnect()
    } else if (wsStatus === 'closed') {
      solverWs.connect()
    }
  }

  const busy = wsStatus === 'connecting' || wsStatus === 'reconnecting'

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
        disabled={busy}
      >
        {wsStatus === 'open' ? 'Disconnect' : busy ? LABELS[wsStatus] : 'Connect'}
      </button>
    </div>
  )
}
