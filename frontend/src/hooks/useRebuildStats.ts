import { useState, useCallback } from 'react'
import { http } from '../utils/httpClient'

export interface RebuildStats {
  uuid: string
  rebuild_count: number
  last_duration_ms: number | null
  average_ms: number | null
  median_ms: number | null
  min_ms: number | null
  max_ms: number | null
  trend: 'faster' | 'slower' | 'stable' | null
  history: Array<{
    duration_ms: number
    feature_count: number
    timestamp: string
  }>
}

export function useRebuildStats(docId: string | undefined) {
  const [stats, setStats] = useState<RebuildStats | null>(null)
  const [loading, setLoading] = useState(false)

  const fetchStats = useCallback(async () => {
    if (!docId) return
    setLoading(true)
    try {
      const data = await http.getJson<RebuildStats>(`/api/documents/${docId}/rebuild-stats`)
      setStats(data)
    } catch (err) {
      console.error('Failed to load rebuild stats:', err)
    } finally {
      setLoading(false)
    }
  }, [docId])

  return { stats, loading, fetchStats }
}
