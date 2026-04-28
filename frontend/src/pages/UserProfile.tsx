import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import AppHeader from '../components/AppHeader'
import './UserProfile.css'

export default function UserProfile() {
  const { user, setUser } = useAuth()
  const navigate = useNavigate()
  const [username, setUsername] = useState('')
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [showPasswordForm, setShowPasswordForm] = useState(false)

  useEffect(() => {
    if (user) {
      setUsername(user.username)
    }
  }, [user])

  const handleSave = async () => {
    setError(null)
    setSuccess(null)
    setLoading(true)

    try {
      const body: Record<string, string> = {}
      if (username !== user?.username) {
        body.username = username
      }
      if (newPassword) {
        if (newPassword !== confirmPassword) {
          setError('Passwords do not match')
          setLoading(false)
          return
        }
        body.current_password = currentPassword
        body.new_password = newPassword
      }

      if (Object.keys(body).length === 0) {
        setLoading(false)
        return
      }

      const response = await fetch('/api/users/me', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

      const data = await response.json()
      if (!response.ok) {
        setError(data.error || 'Update failed')
        setLoading(false)
        return
      }

      if (body.username && user) {
        setUser({ ...user, username: body.username })
      }
      if (newPassword) {
        setCurrentPassword('')
        setNewPassword('')
        setConfirmPassword('')
        setShowPasswordForm(false)
        if (user) {
          setUser({ ...user, must_change_password: false })
        }
      }
      setSuccess('Profile updated successfully')
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  const handleCancel = () => {
    if (user) {
      setUsername(user.username)
    }
    setCurrentPassword('')
    setNewPassword('')
    setConfirmPassword('')
    setShowPasswordForm(false)
    setError(null)
    setSuccess(null)
    navigate('/documents')
  }

  if (!user) {
    return null
  }

  return (
    <div className="user-profile">
      <AppHeader title="Profile" />
      <div className="profile-container">
        <div className="profile-card">
          <h2 className="profile-heading">Edit Profile</h2>

          {error && <p className="profile-error">{error}</p>}
          {success && <p className="profile-success">{success}</p>}

          <div className="profile-field">
            <label htmlFor="profile-username">Username</label>
            <input
              id="profile-username"
              type="text"
              value={username}
              onChange={e => setUsername(e.target.value)}
              autoComplete="username"
            />
          </div>

          <div className="profile-field">
            <button
              className="btn btn-secondary"
              onClick={() => setShowPasswordForm(!showPasswordForm)}
            >
              {showPasswordForm ? 'Cancel password change' : 'Change password'}
            </button>
          </div>

          {showPasswordForm && (
            <>
              <div className="profile-field">
                <label htmlFor="profile-current-password">Current password</label>
                <input
                  id="profile-current-password"
                  type="password"
                  value={currentPassword}
                  onChange={e => setCurrentPassword(e.target.value)}
                  autoComplete="current-password"
                />
              </div>
              <div className="profile-field">
                <label htmlFor="profile-new-password">New password</label>
                <input
                  id="profile-new-password"
                  type="password"
                  value={newPassword}
                  onChange={e => setNewPassword(e.target.value)}
                  autoComplete="new-password"
                />
              </div>
              <div className="profile-field">
                <label htmlFor="profile-confirm-password">Confirm new password</label>
                <input
                  id="profile-confirm-password"
                  type="password"
                  value={confirmPassword}
                  onChange={e => setConfirmPassword(e.target.value)}
                  autoComplete="new-password"
                />
              </div>
            </>
          )}

          <div className="profile-actions">
            <button className="btn btn-primary" onClick={handleSave} disabled={loading}>
              {loading ? 'Saving…' : 'Save'}
            </button>
            <button className="btn btn-secondary" onClick={handleCancel}>
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
