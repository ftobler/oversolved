import { useState, useEffect, useCallback } from 'react'
import { getAllCachedEntries, deleteCacheEntry, invalidateAllCache } from '../utils/buildCache'
import type { BuildResponse } from '../types/cad'

interface CacheEntry {
  cache_key: string
  doc_id: string
  feature_spec_hash: string
  timestamp: number
  rollback_position: number
  pick_boundary: number | null
  buildResponse: BuildResponse
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${parseFloat((bytes / k ** i).toFixed(1))} ${sizes[i]}`
}

function formatTime(ts: number): string {
  const seconds = Math.floor((Date.now() - ts) / 1000)
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

function FrontendTab({ searchQuery }: { searchQuery: string }) {
  const [entries, setEntries] = useState<CacheEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [expandedKey, setExpandedKey] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const all = await getAllCachedEntries()
      setEntries(all as CacheEntry[])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const filtered = entries.filter(
    e =>
      e.doc_id.includes(searchQuery) ||
      e.cache_key.includes(searchQuery)
  )

  const totalSize = entries.reduce((sum, e) => {
    try {
      return sum + JSON.stringify(e.buildResponse).length
    } catch {
      return sum
    }
  }, 0)

  const handleDelete = async (key: string) => {
    await deleteCacheEntry(key)
    setEntries(prev => prev.filter(e => e.cache_key !== key))
  }

  const handleClear = async () => {
    await invalidateAllCache()
    await load()
  }

  const handleDownload = (entry: CacheEntry) => {
    const json = JSON.stringify(entry.buildResponse, null, 2)
    const blob = new Blob([json], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${entry.doc_id}_buildresponse.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="cache-tab">
      <div className="cache-stats">
        Memory: {entries.length} entries, {formatBytes(totalSize)}
      </div>
      <div className="cache-actions-bar">
        <button onClick={load}>Refresh</button>
        <button onClick={handleClear}>Clear</button>
      </div>
      {loading && <div className="cache-loading">Loading...</div>}
      <div className="cache-entries">
        {filtered.map(entry => {
          const isExpanded = expandedKey === entry.cache_key
          const size = JSON.stringify(entry.buildResponse).length
          return (
            <div key={entry.cache_key} className="cache-entry">
              <div className="cache-entry-header">
                <span className="cache-entry-id">{entry.doc_id}</span>
                <span className="cache-entry-meta">
                  {formatBytes(size)}
                </span>
              </div>
              <div className="cache-entry-sub">
                Created: {formatTime(entry.timestamp)}
                {entry.rollback_position !== undefined &&
                  ` | Rollback: ${entry.rollback_position}`}
              </div>
              <div className="cache-entry-actions">
                <button onClick={() => setExpandedKey(isExpanded ? null : entry.cache_key)}>
                  {isExpanded ? 'Hide' : 'Details'}
                </button>
                <button onClick={() => handleDownload(entry)}>Download</button>
                <button className="cache-delete-btn" onClick={() => handleDelete(entry.cache_key)}>
                  Delete
                </button>
              </div>
              {isExpanded && (
                <pre className="cache-entry-preview">
                  {JSON.stringify(entry.buildResponse, null, 2).slice(0, 2000)}
                  {JSON.stringify(entry.buildResponse).length > 2000 && '...'}
                </pre>
              )}
            </div>
          )
        })}
        {!loading && filtered.length === 0 && (
          <div className="cache-empty">No entries</div>
        )}
      </div>
    </div>
  )
}

export default function CacheInspector() {
  const [activeTab, setActiveTab] = useState<'frontend'>('frontend')
  const [searchQuery, setSearchQuery] = useState('')

  return (
    <div className="cache-inspector">
      <div className="cache-inspector-tabs">
        <button
          className={`cache-inspector-tab ${activeTab === 'frontend' ? 'active' : ''}`}
          onClick={() => setActiveTab('frontend')}
        >
          Frontend
        </button>

      </div>
      <div className="cache-search-bar">
        <input
          type="text"
          placeholder="Search by doc_id..."
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
        />
      </div>
      {activeTab === 'frontend' && <FrontendTab searchQuery={searchQuery} />}
    </div>
  )
}
