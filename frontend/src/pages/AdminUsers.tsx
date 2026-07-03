import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '@/contexts/AuthContext'
import { useAdminGuard } from '@/hooks/useAdminGuard'
import Dialog from '@/components/dialogs/Dialog'
import MessageDialog from '@/components/dialogs/MessageDialog'
import { http, parseHttpError } from '@/utils/core/httpClient'
import '@/pages/AdminUsers.css'

interface UserRecord {
  id: number
  username: string
  email: string | null
  must_change_password: boolean
  is_admin: boolean
  is_active: boolean
  created_at: string
  last_login_at: string | null
}

export default function AdminUsers() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [users, setUsers] = useState<UserRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showCreateForm, setShowCreateForm] = useState(false)
  const [editingUser, setEditingUser] = useState<UserRecord | null>(null)
  const [resetUser, setResetUser] = useState<UserRecord | null>(null)
  const [newUsername, setNewUsername] = useState('')
  const [newEmail, setNewEmail] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [newIsAdmin, setNewIsAdmin] = useState(false)
  const [resetPassword, setResetPassword] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<UserRecord | null>(null)

  const isAdmin = useAdminGuard(user, navigate)

  useEffect(() => {
    if (isAdmin) fetchUsers()
  }, [isAdmin])

  const fetchUsers = async () => {
    setLoading(true)
    try {
      const data = await http.getJson<{ users: UserRecord[] }>('/api/admin/users')
      setUsers(data.users || [])
      setError(null)
    } catch (e) {
      setError(parseHttpError(e, 'Failed to fetch users'))
    } finally {
      setLoading(false)
    }
  }

  const handleCreate = async () => {
    setFormError(null)
    if (!newUsername.trim() || !newPassword) {
      setFormError('Username and password required')
      return
    }
    try {
      await http.postJson('/api/admin/users', { username: newUsername.trim(), email: newEmail.trim() || undefined, password: newPassword, is_admin: newIsAdmin })
      setNewUsername('')
      setNewEmail('')
      setNewPassword('')
      setNewIsAdmin(false)
      setShowCreateForm(false)
      fetchUsers()
    } catch (e) {
      setFormError(parseHttpError(e, 'Failed to create user'))
    }
  }

  const handleUpdate = async () => {
    setFormError(null)
    if (!editingUser) return
    try {
      const body: Record<string, unknown> = {}
      body.username = editingUser.username
      body.email = editingUser.email
      body.is_active = editingUser.is_active
      body.is_admin = editingUser.is_admin

      await http.putJson(`/api/admin/users/${editingUser.id}`, body)
      setEditingUser(null)
      fetchUsers()
    } catch (e) {
      setFormError(parseHttpError(e, 'Failed to update user'))
    }
  }

  const handleDelete = async (u: UserRecord) => {
    setDeleteTarget(u)
  }

  const handleDeleteConfirm = async () => {
    const u = deleteTarget
    if (!u) return
    setDeleteTarget(null)
    try {
      await http.deleteJson(`/api/admin/users/${u.id}`)
      fetchUsers()
    } catch (e) {
      setError(parseHttpError(e, 'Failed to delete user'))
    }
  }

  const handleReset = async () => {
    setFormError(null)
    if (!resetUser || !resetPassword) {
      setFormError('Password required')
      return
    }
    try {
      await http.postJson(`/api/admin/users/${resetUser.id}/reset`, { password: resetPassword })
      setResetUser(null)
      setResetPassword('')
      fetchUsers()
    } catch (e) {
      setFormError(parseHttpError(e, 'Failed to reset password'))
    }
  }

  const formatDate = (isoString: string) => {
    if (!isoString) return ''
    const date = new Date(isoString)
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  }

  if (!isAdmin) return null

  return (
    <div className="admin-users">
      <div className="settings-button-right">
        <button className="btn btn-secondary" title="Create user" onClick={() => setShowCreateForm(true)}>
          Create user
        </button>
      </div>

      <div className="admin-users-container">
        {error && <p className="admin-users-error">{error}</p>}

        <Dialog
          isOpen={showCreateForm}
          title="Create User"
          onClose={() => { setShowCreateForm(false); setFormError(null); setNewUsername(''); setNewEmail(''); setNewPassword(''); setNewIsAdmin(false) }}
          onConfirm={handleCreate}
          confirmLabel="Create"
        >
          {formError && <p className="form-error">{formError}</p>}
          <div className="form-field">
            <label>Username</label>
            <input
              type="text"
              value={newUsername}
              onChange={e => setNewUsername(e.target.value)}
              autoFocus
            />
          </div>
          <div className="form-field">
            <label>Email</label>
            <input
              type="email"
              value={newEmail}
              onChange={e => setNewEmail(e.target.value)}
            />
          </div>
          <div className="form-field">
            <label>Password</label>
            <input
              type="password"
              value={newPassword}
              onChange={e => setNewPassword(e.target.value)}
            />
          </div>
          <div className="form-field checkbox-field">
            <label>
              <input
                type="checkbox"
                checked={newIsAdmin}
                onChange={e => setNewIsAdmin(e.target.checked)}
              />
              Admin
            </label>
          </div>
        </Dialog>

        {editingUser && (
          <Dialog
            isOpen={!!editingUser}
            title="Edit User"
            onClose={() => { setEditingUser(null); setFormError(null) }}
            onConfirm={handleUpdate}
            confirmLabel="Save"
          >
            {formError && <p className="form-error">{formError}</p>}
            <div className="form-field">
              <label>Username</label>
              <input
                type="text"
                value={editingUser.username}
                onChange={e => setEditingUser({ ...editingUser, username: e.target.value })}
              />
            </div>
            <div className="form-field">
              <label>Email</label>
              <input
                type="email"
                value={editingUser.email || ''}
                onChange={e => setEditingUser({ ...editingUser, email: e.target.value || null })}
              />
            </div>
            <div className="form-field checkbox-field">
              <label>
                <input
                  type="checkbox"
                  checked={editingUser.is_active}
                  onChange={e => setEditingUser({ ...editingUser, is_active: e.target.checked })}
                />
                Active
              </label>
            </div>
            <div className="form-field checkbox-field">
              <label>
                <input
                  type="checkbox"
                  checked={editingUser.is_admin}
                  onChange={e => setEditingUser({ ...editingUser, is_admin: e.target.checked })}
                />
                Admin
              </label>
            </div>
          </Dialog>
        )}

        {resetUser && (
          <Dialog
            isOpen={!!resetUser}
            title={`Reset Password - ${resetUser.username}`}
            onClose={() => { setResetUser(null); setFormError(null); setResetPassword('') }}
            onConfirm={handleReset}
            confirmLabel="Reset"
          >
            {formError && <p className="form-error">{formError}</p>}
            <div className="form-field">
              <label>New password</label>
              <input
                type="password"
                value={resetPassword}
                onChange={e => setResetPassword(e.target.value)}
                autoFocus
              />
            </div>
          </Dialog>
        )}

        <MessageDialog
          isOpen={deleteTarget != null}
          title="Delete User"
          message={`Delete user "${deleteTarget?.username}"? This action cannot be undone.`}
          variant="error"
          onClose={() => setDeleteTarget(null)}
          onConfirm={handleDeleteConfirm}
          confirmLabel="Delete"
          cancelLabel="Cancel"
        />

        {loading ? (
          <p className="admin-users-status">Loading users...</p>
        ) : (
          <table className="setting-table">
            <thead>
              <tr>
                <th>Username</th>
                <th>Admin</th>
                <th>Active</th>
                <th>Created</th>
                <th>Last Login</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map(u => (
                <tr key={u.id} className={u.id === user?.id ? 'current-user' : ''}>
                  <td>{u.username}{u.id === user?.id ? <div className="me-badge">me</div> : ''}</td>
                  <td>{u.is_admin ? 'Yes' : 'No'}</td>
                  <td>{u.is_active ? 'Yes' : 'No'}</td>
                  <td>{formatDate(u.created_at)}</td>
                  <td>{u.last_login_at ? formatDate(u.last_login_at) : 'Never'}</td>
                  <td>
                    <button
                      className="btn btn-tile-action"
                      onClick={() => setEditingUser(u)}
                      title="Edit user"
                    >
                      <span className="material-icons">edit</span>
                    </button>
                    <button
                      className="btn btn-tile-action"
                      onClick={() => setResetUser(u)}
                      title="Reset password"
                    >
                      <span className="material-icons">lock_reset</span>
                    </button>
                    {u.id !== user?.id && (
                      <button
                        className="btn btn-delete-tile"
                        onClick={() => handleDelete(u)}
                        title="Delete user"
                      >
                        <span className="material-icons">delete</span>
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
