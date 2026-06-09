import { useCallback, useEffect, useState } from 'react'
import { http, HttpError } from '@/utils/core/httpClient'

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
  const [linkSharing, setLinkSharing] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fetchShares = useCallback(async () => {
    if (!isOwner) return
    try {
      const data = await http.getJson<{ shares: ShareInfo[] }>(`/api/documents/${documentUuid}/shares`)
      const sharesList = data.shares || []
      setShares(sharesList)
      setLinkSharing(sharesList.some((s: ShareInfo) => s.shared_with_user_id === null))
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
      await http.postJson(`/api/documents/${documentUuid}/share`, { username: shareUsername.trim(), permission: sharePermission })
      setShareUsername('')
      fetchShares()
    } catch (e) {
      if (e instanceof HttpError) {
        const parsed = JSON.parse(e.body || '{}') as { error?: string }
        setError(parsed.error || 'Failed to share')
      } else {
        setError(String(e))
      }
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
        const data = await response.json() as { error?: string }
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
              <div className="share-dialog-row" style={{ justifyContent: 'space-between' }}>
<label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', color: '#f3f4f6' }}>
                  <input
                    type="checkbox"
                    style={{ marginLeft: '12px' }}
                    checked={linkSharing}
                    disabled={loading}
                    onChange={async (e) => {
                      const checked = e.target.checked
                      setLinkSharing(checked)
                      setLoading(true)
                      setError(null)
                      try {
                        let updated: { shares?: ShareInfo[] }
                        if (checked) {
                          updated = await http.postJson<{ shares?: ShareInfo[] }>(`/api/documents/${documentUuid}/share`, { permission: 'view' })
                        } else {
                          const response = await fetch(`/api/documents/${documentUuid}/share`, {
                            method: 'DELETE',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({}),
                          })
                          if (!response.ok) {
                            const data = await response.json() as { error?: string }
                            throw new Error(data.error || 'Failed to update link sharing')
                          }
                          updated = await response.json() as { shares?: ShareInfo[] }
                        }
                        if (updated.shares) {
                          setShares(updated.shares)
                        }
                      } catch (err) {
                        setError(String(err))
                        setLinkSharing(!checked)
                      } finally {
                        setLoading(false)
                      }
                    }}
                  />
                  <span>Link sharing</span>
                </label>
                <input
                  type="text"
                  readOnly
                  value={linkSharing ? `${window.location.origin}/documents/${documentUuid}` : ''}
                  className="share-dialog-input"
                  style={{ flex: 1, marginLeft: '12px' }}
                  onClick={e => linkSharing && (e.target as HTMLInputElement).select()}
                />
                <button
                  className="btn btn-tile-action"
                  onClick={() => linkSharing && navigator.clipboard.writeText(`${window.location.origin}/documents/${documentUuid}`)}
                  title="Copy URL"
                  disabled={!linkSharing}
                  style={{
                    minWidth: '32px',
                    height: '32px',
                    borderRadius: '50%',
                    visibility: linkSharing ? 'visible' : 'hidden'
                  }}
                >
                  <span className="material-icons">content_copy</span>
                </button>
              </div>

              <div className="share-dialog-row">
                <input
                  type="text"
                  placeholder="Username"
                  value={shareUsername}
                  onChange={e => setShareUsername(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') handleShare() }}
                  className="share-dialog-input"
                />
                <button
                  className="btn btn-primary"
                  onClick={handleShare}
                  disabled={loading || !shareUsername.trim()}
                  style={{ flex: 0.5, borderRadius: '9999px' }}
                >
                  Share
                </button>
              </div>

              {shares.filter(s => s.shared_with_user_id !== null).length > 0 && (
                <div className="share-dialog-list-container">
                  <table className="share-dialog-table">
                  <thead>
                    <tr>
                      <th>Username</th>
                      <th>Role</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                    <tbody>
                      {shares.filter(s => s.shared_with_user_id !== null).map(share => (
                        <tr key={share.id}>
                          <td>{share.username}</td>
                          <td>
                            <select
                              value={share.permission}
                              onChange={async e => {
                                setLoading(true)
                                setError(null)
                                try {
                                  await http.postJson(`/api/documents/${documentUuid}/share`, { username: share.username, permission: e.target.value })
                                  fetchShares()
                                } catch (err) {
                                  if (err instanceof HttpError) {
                                    const parsed = JSON.parse(err.body || '{}') as { error?: string }
                                    setError(parsed.error || 'Failed to update permission')
                                  } else {
                                    setError(String(err))
                                  }
                                } finally {
                                  setLoading(false)
                                }
                              }}
                              className="share-dialog-select"
                              style={{ fontSize: '12px', padding: '4px 8px', borderRadius: '9999px', background: '#2a2a2a', color: '#ccc' }}
                            >
                              <option value="view">View</option>
                              <option value="edit">Edit</option>
                            </select>
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
