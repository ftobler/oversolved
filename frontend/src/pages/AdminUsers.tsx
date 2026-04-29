import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import Dialog from '../components/Dialog'
import './AdminUsers.css'

interface UserRecord {
  id: number
  username: string
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
  const [newPassword, setNewPassword] = useState('')
  const [newIsAdmin, setNewIsAdmin] = useState(false)
  const [resetPassword, setResetPassword] = useState('')
  const [formError, setFormError] = useState<string | null>(null)

  useEffect(() => {
    if (!user?.is_admin) {
      navigate('/documents')
      return
    }
    fetchUsers()
  }, [user, navigate])

  const fetchUsers = async () => {
    setLoading(true)
    try {
      const response = await fetch('/api/admin/users')
      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.error || 'Failed to fetch users')
      }
      const data = await response.json()
      setUsers(data.users || [])
      setError(null)
    } catch (e) {
      setError(String(e))
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
      const response = await fetch('/api/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: newUsername.trim(), password: newPassword, is_admin: newIsAdmin }),
      })
      const data = await response.json()
      if (!response.ok) {
        setFormError(data.error || 'Failed to create user')
        return
      }
      setNewUsername('')
      setNewPassword('')
      setNewIsAdmin(false)
      setShowCreateForm(false)
      fetchUsers()
    } catch (e) {
      setFormError(String(e))
    }
  }

  const handleUpdate = async () => {
    setFormError(null)
    if (!editingUser) return
    try {
      const body: Record<string, unknown> = {}
      body.username = editingUser.username
      body.is_active = editingUser.is_active
      body.is_admin = editingUser.is_admin

      const response = await fetch(`/api/admin/users/${editingUser.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await response.json()
      if (!response.ok) {
        setFormError(data.error || 'Failed to update user')
        return
      }
      setEditingUser(null)
      fetchUsers()
    } catch (e) {
      setFormError(String(e))
    }
  }

  const handleDelete = async (u: UserRecord) => {
    if (!confirm(`Delete user "${u.username}"? This action cannot be undone.`)) {
      return
    }
    try {
      const response = await fetch(`/api/admin/users/${u.id}`, { method: 'DELETE' })
      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.error || 'Failed to delete user')
      }
      fetchUsers()
    } catch (e) {
      setError(String(e))
    }
  }

  const handleReset = async () => {
    setFormError(null)
    if (!resetUser || !resetPassword) {
      setFormError('Password required')
      return
    }
    try {
      const response = await fetch(`/api/admin/users/${resetUser.id}/reset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: resetPassword }),
      })
      const data = await response.json()
      if (!response.ok) {
        setFormError(data.error || 'Failed to reset password')
        return
      }
      setResetUser(null)
      setResetPassword('')
      fetchUsers()
    } catch (e) {
      setFormError(String(e))
    }
  }

  const formatDate = (isoString: string) => {
    if (!isoString) return ''
    const date = new Date(isoString)
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  }

  if (!user?.is_admin) {
    return null
  }

  return (
    <div className="admin-users">
      <div className="settings-button-right">
        <button className="btn btn-secondary" onClick={() => setShowCreateForm(true)} title="Create user">
          <span className="material-icons">person_add</span>
        </button>
      </div>

      <div className="admin-users-container">
        {error && <p className="admin-users-error">{error}</p>}

        <Dialog
          isOpen={showCreateForm}
          title="Create User"
          onClose={() => { setShowCreateForm(false); setFormError(null); setNewUsername(''); setNewPassword(''); setNewIsAdmin(false) }}
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

        {loading ? (
          <p className="admin-users-status">Loading users...</p>
        ) : (
          <table className="admin-users-table">
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
