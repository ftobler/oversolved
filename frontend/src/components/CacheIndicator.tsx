import { useState, useEffect } from 'react'
import './CacheIndicator.css'

interface CacheIndicatorProps {
  visible: boolean
  timestamp?: number
  isFresh?: boolean
}

export default function CacheIndicator({ visible, timestamp, isFresh = true }: CacheIndicatorProps) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!visible || !timestamp) return
    const timer = setInterval(() => setNow(Date.now()), 60000)
    return () => clearInterval(timer)
  }, [visible, timestamp])

  if (!visible) return null

  const ageText = timestamp
    ? `${Math.floor((now - timestamp) / 60000)}m ago`
    : ''

  return (
    <div className={`cache-indicator ${isFresh ? 'cache-fresh' : 'cache-stale'}`}>
      <span className="cache-icon">📦</span>
      <span className="cache-label">Cached</span>
      {ageText && (
        <span className="cache-age" title={`Last updated ${ageText}`}>
          {ageText}
        </span>
      )}
    </div>
  )
}
