import { useCallback, useEffect, useState } from 'react'
import Dialog from './Dialog'

interface ShareInfo {
  id: number
  username: string | null
  permission: string
  shared_with_user_id: number | null
}

interface ShareDialogProps {
  isOpen: boolean
  documentUuid: string
  documentName: string
  isOwner: boolean
  onClose: () => void
}

export default function ShareDialog({ isOpen, documentUuid, documentName, isOwner, onClose }: ShareDialogProps) {
  const [shareUsername, setShareUsername] = useState('')
  const [sharePermission, setSharePermission] = useState<'view' | 'edit'>('view')
  const [shares, setShares] = useState<ShareInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isPublic, setIsPublic] = useState(false)

  const fetchShares = useCallback(async () => {
    if (!isOwner) return
    try {
      const response = await fetch(`/api/documents/${documentUuid}/shares`)
      if (!response.ok) throw new Error('Failed to fetch shares')
      const data = await response.json()
      setShares(data.shares || [])
      setIsPublic(data.shares?.some((s: ShareInfo) => s.shared_with_user_id === null) ?? false)
    } catch (e) {
      setError(String(e))
    }
  }, [isOwner, documentUuid])

  useEffect(() => {
    if (isOpen && isOwner) {
      fetchShares()
    }
    if (!isOpen) {
      setShareUsername('')
      setSharePermission('view')
      setError(null)
    }
  }, [isOpen, isOwner, documentUuid, fetchShares])

  const handleShare = async () => {
    if (!shareUsername.trim()) return
    setLoading(true)
    setError(null)
    try {
      const response = await fetch(`/api/documents/${documentUuid}/share`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: shareUsername.trim(), permission: sharePermission }),
      })
      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.error || 'Failed to share')
      }
      setShareUsername('')
      fetchShares()
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  const handleRemoveShare = async (username: string | null) => {
    setLoading(true)
    setError(null)
    try {
      const response = await fetch(`/api/documents/${documentUuid}/share`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(username ? { username } : {}),
      })
      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.error || 'Failed to remove share')
      }
      fetchShares()
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  const handleTogglePublic = async () => {
    setLoading(true)
    setError(null)
    try {
      const response = await fetch(`/api/documents/${documentUuid}/share`, {
        method: isPublic ? 'DELETE' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.error || 'Failed to update public link')
      }
      setIsPublic(!isPublic)
      fetchShares()
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog
      isOpen={isOpen}
      title={`Share "${documentName}"`}
      onClose={onClose}
    >
      {!isOwner && (
        <p className="error-text">Only the owner can manage shares.</p>
      )}
      {isOwner && (
        <>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <input
              type="text"
              placeholder="Username"
              value={shareUsername}
              onChange={e => setShareUsername(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleShare() }}
              style={{ flex: 1 }}
            />
            <select
              value={sharePermission}
              onChange={e => setSharePermission(e.target.value as 'view' | 'edit')}
              style={{
                padding: '8px',
                background: '#111',
                border: '1px solid #333',
                borderRadius: '4px',
                color: '#ccc',
                fontSize: '13px',
              }}
            >
              <option value="view">View</option>
              <option value="edit">Edit</option>
            </select>
            <button className="btn btn-primary" onClick={handleShare} disabled={loading || !shareUsername.trim()}>
              Share
            </button>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', fontSize: '13px', color: '#ccc' }}>
              <input
                type="checkbox"
                checked={isPublic}
                onChange={handleTogglePublic}
                disabled={loading}
              />
              Public link (view only)
            </label>
          </div>

          {shares.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <div style={{ fontSize: '12px', color: '#888', fontWeight: 600 }}>Shared with</div>
              {shares.map(share => (
                <div key={share.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '13px' }}>
                  <span style={{ color: '#ccc' }}>
                    {share.shared_with_user_id === null ? 'Public link' : share.username}
                    {' '}
                    <span style={{ color: '#888' }}>({share.permission})</span>
                  </span>
                  <button
                    className="btn btn-tile-action"
                    onClick={() => handleRemoveShare(share.username)}
                    title="Remove share"
                    disabled={loading}
                  >
                    <span className="material-icons" style={{ fontSize: '16px' }}>close</span>
                  </button>
                </div>
              ))}
            </div>
          )}
        </>
      )}
      {error && <p className="error-text">{error}</p>}
    </Dialog>
  )
}
