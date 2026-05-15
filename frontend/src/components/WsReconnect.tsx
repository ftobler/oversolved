import { useState, useEffect } from 'react'
import { solverWs } from '@/hooks/solverWs'

type WsState = 'connecting' | 'open' | 'closing' | 'closed' | 'unknown'

function getWsState(): WsState {
  if (!solverWs['ws']) return 'closed'
  switch (solverWs['ws'].readyState) {
    case WebSocket.CONNECTING: return 'connecting'
    case WebSocket.OPEN: return 'open'
    case WebSocket.CLOSING: return 'closing'
    case WebSocket.CLOSED: return 'closed'
    default: return 'unknown'
  }
}

export default function WsReconnect() {
  const [state, setState] = useState<WsState>(getWsState())

  useEffect(() => {
    const check = setInterval(() => setState(getWsState()), 1000)
    return () => clearInterval(check)
  }, [])

  const handleReconnect = () => {
    solverWs.disconnect()
    solverWs.connect()
  }

  const statusColor =
    state === 'open' ? '#4caf50' :
    state === 'connecting' ? '#ff9800' : '#f44336'

  return (
    <div className="debug-content">
      <div className="debug-section">
        <div className="debug-section-title">WebSocket</div>
        <div className="debug-value">
          Status: <span style={{ color: statusColor }}>{state}</span>
        </div>
      </div>
      <div className="debug-actions">
        <button onClick={handleReconnect} className="debug-reconnect-btn">
          Reconnect
        </button>
      </div>
    </div>
  )
}
