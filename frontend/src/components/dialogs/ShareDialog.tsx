import { useCallback, useEffect, useState } from 'react'
import Dialog from '@/components/dialogs/Dialog'
import { parseHttpError } from '@/utils/core/httpClient'
import { type ShareInfo } from '@/adapters/sharing'
import { backendBundle } from '@/adapters/backend'
import './ShareDialog.css'

interface ShareDialogProps {
  isOpen: boolean
  documentUuid: string
  documentName: string
  ownerUsername: string
  isOwner: boolean
  onClose: () => void
}

// A user-row must carry a username: per the adapter contract a falsy username
// targets the document-wide LINK share, so a malformed row must surface an
// error here instead of silently revoking/regrading link sharing.
const NO_USERNAME_ERROR = 'Malformed share row: no username'

export default function ShareDialog({ isOpen, documentUuid, documentName, ownerUsername, isOwner, onClose }: ShareDialogProps) {
  const [shareUsername, setShareUsername] = useState('')
  const [sharePermission, setSharePermission] = useState<'view' | 'edit'>('view')
  const [shares, setShares] = useState<ShareInfo[]>([])
  const [linkSharing, setLinkSharing] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fetchShares = useCallback(async () => {
    if (!isOwner || !backendBundle.sharing) return
    try {
      const sharesList = await backendBundle.sharing.listShares(documentUuid)
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
    if (!shareUsername.trim() || !backendBundle.sharing) return
    setLoading(true)
    setError(null)
    try {
      await backendBundle.sharing.share(documentUuid, { username: shareUsername.trim(), permission: sharePermission })
      setShareUsername('')
      fetchShares()
    } catch (e) {
      setError(parseHttpError(e, 'Failed to share'))
    } finally {
      setLoading(false)
    }
  }

  const handleRemoveShare = async (username: string | null) => {
    if (!backendBundle.sharing) return
    if (username == null) {
      setError(NO_USERNAME_ERROR)
      return
    }
    setLoading(true)
    setError(null)
    try {
      await backendBundle.sharing.unshare(documentUuid, username)
      fetchShares()
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  const shareUrl = `${window.location.origin}/documents/${documentUuid}`

  return (
    <Dialog
      isOpen={isOpen}
      title={`Share "${ownerUsername}/${documentName}"`}
      icon="share"
      className="share-dialog"
      onClose={onClose}
    >
      {!isOwner && (
        <p className="share-dialog-error">Only the owner can manage shares.</p>
      )}
      {isOwner && (
        <>
          <div className="share-dialog-row share-dialog-row-link">
            <label className="share-dialog-link-toggle">
              <input
                type="checkbox"
                checked={linkSharing}
                disabled={loading}
                onChange={async (e) => {
                  if (!backendBundle.sharing) return
                  const checked = e.target.checked
                  setLinkSharing(checked)
                  setLoading(true)
                  setError(null)
                  try {
                    const updated = checked
                      ? await backendBundle.sharing.share(documentUuid, { permission: 'view' })
                      : await backendBundle.sharing.unshare(documentUuid)
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
              value={linkSharing ? shareUrl : ''}
              className="share-dialog-input"
              onClick={e => linkSharing && (e.target as HTMLInputElement).select()}
            />
            {/* Hidden rather than unmounted: the row must not reflow when the toggle flips. */}
            <button
              className="btn btn-tile-action share-dialog-copy-btn"
              onClick={() => linkSharing && navigator.clipboard.writeText(shareUrl)}
              title="Copy URL"
              disabled={!linkSharing}
              hidden={!linkSharing}
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
                            if (!backendBundle.sharing) return
                            if (share.username == null) {
                              setError(NO_USERNAME_ERROR)
                              return
                            }
                            setLoading(true)
                            setError(null)
                            try {
                              await backendBundle.sharing.share(documentUuid, { username: share.username ?? undefined, permission: e.target.value })
                              fetchShares()
                            } catch (err) {
                              setError(parseHttpError(err, 'Failed to update permission'))
                            } finally {
                              setLoading(false)
                            }
                          }}
                          className="share-dialog-select"
                        >
                          <option value="view">View</option>
                          <option value="edit">Edit</option>
                        </select>
                      </td>
                      <td className="share-dialog-table-action">
                        <button
                          className="btn btn-tile-action share-dialog-remove-btn"
                          onClick={() => handleRemoveShare(share.username)}
                          title="Remove share"
                          disabled={loading}
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
    </Dialog>
  )
}
