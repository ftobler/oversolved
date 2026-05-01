import { useCallback, useEffect, useState } from 'react'

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
  ownerUsername: string
  isOwner: boolean
  onClose: () => void
}

export default function ShareDialog({ isOpen, documentUuid, documentName, ownerUsername, isOwner, onClose }: ShareDialogProps) {
  const [shareUsername, setShareUsername] = useState('')
  const [sharePermission, setSharePermission] = useState<'view' | 'edit'>('view')
  const [shares, setShares] = useState<ShareInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fetchShares = useCallback(async () => {
    if (!isOwner) return
    try {
      const response = await fetch(`/api/documents/${documentUuid}/shares`)
      if (!response.ok) throw new Error('Failed to fetch shares')
      const data = await response.json()
      setShares(data.shares || [])
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

  if (!isOpen) return null

  return (
    <div className="share-dialog-overlay" onClick={onClose}>
      <div className="share-dialog-content" onClick={e => e.stopPropagation()}>
        <div className="share-dialog-header">
          <h2 className="share-dialog-title">Share "{ownerUsername}/{documentName}"</h2>
          <button
            className="share-dialog-close-btn"
            onClick={onClose}
            title="Close"
          >
            <span className="material-icons">close</span>
          </button>
        </div>

        <div className="share-dialog-body">
          {!isOwner && (
            <p className="share-dialog-error">Only the owner can manage shares.</p>
          )}
          {isOwner && (
            <>
              <div className="share-dialog-row">
                <input
                  type="text"
                  placeholder="Username"
                  value={shareUsername}
                  onChange={e => setShareUsername(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') handleShare() }}
                  className="share-dialog-input"
                />
                <select
                  value={sharePermission}
                  onChange={e => setSharePermission(e.target.value as 'view' | 'edit')}
                  className="share-dialog-select"
                >
                  <option value="view">View</option>
                  <option value="edit">Edit</option>
                </select>
                <button
                  className="btn btn-primary"
                  onClick={handleShare}
                  disabled={loading || !shareUsername.trim()}
                  style={{ minWidth: '80px' }}
                >
                  Share
                </button>
              </div>

              {shares.length > 0 && (
                <div className="share-dialog-list-container">
                  <div className="share-dialog-list-title">Shared with</div>
                  <table className="share-dialog-table">
                    <tbody>
                      {shares.map(share => (
                        <tr key={share.id}>
                          <td>
                            {share.shared_with_user_id === null ? 'Public link' : share.username}
                          </td>
                          <td className="share-dialog-table-permission">
                            {share.permission}
                          </td>
                          <td className="share-dialog-table-action">
                            <button
                              className="btn btn-tile-action"
                              onClick={() => handleRemoveShare(share.username)}
                              title="Remove share"
                              disabled={loading}
                              style={{ minWidth: '32px', height: '32px' }}
                            >
                              <span className="material-icons">delete_outline</span>
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
          {error && <p className="share-dialog-error">{error}</p>}
        </div>
      </div>
    </div>
  )
}
