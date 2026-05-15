import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { useUserPreferences } from '../hooks/useUserPreferences'
import { http, HttpError } from '../utils/httpClient'
import './UserProfile.css'

export default function UserProfile() {
  const { user, setUser } = useAuth()
  const navigate = useNavigate()
  const { preferences, updatePreference } = useUserPreferences()
  const [username, setUsername] = useState('')
  const [email, setEmail] = useState('')
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (user) {
      setUsername(user.username)
      setEmail(user.email || '')
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
      if (email !== (user?.email || '')) {
        body.email = email
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

      try {
        await http.putJson('/api/users/me', body)
      } catch (e) {
        if (e instanceof HttpError) {
          const parsed = JSON.parse(e.body || '{}') as { error?: string }
          setError(parsed.error || 'Update failed')
        } else {
          setError(String(e))
        }
        setLoading(false)
        return
      }

      if ((body.username || body.email) && user) {
        setUser({
          ...user,
          username: body.username || user.username,
          email: body.email !== undefined ? body.email : user.email,
        })
      }
      if (newPassword) {
        setCurrentPassword('')
        setNewPassword('')
        setConfirmPassword('')
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
      setEmail(user.email || '')
    }
    setCurrentPassword('')
    setNewPassword('')
    setConfirmPassword('')
    setError(null)
    setSuccess(null)
    navigate('/documents')
  }

  if (!user) {
    return null
  }

  return (
    <div className="setting-card">

      {error && <p className="profile-error">{error}</p>}
      {success && <p className="profile-success">{success}</p>}

      <div className="setting-field">
        <label htmlFor="profile-username">Username</label>
        <input
          id="profile-username"
          type="text"
          value={username}
          onChange={e => setUsername(e.target.value)}
          autoComplete="username"
        />
      </div>

      <div className="setting-field">
        <label htmlFor="profile-email">Email</label>
        <input
          id="profile-email"
          type="email"
          value={email}
          onChange={e => setEmail(e.target.value)}
          autoComplete="email"
        />
      </div>

      <div className="setting-divider" />

      <div className="setting-field">
        <label htmlFor="profile-current-password">Current Password</label>
        <input
          id="profile-current-password"
          type="password"
          value={currentPassword}
          onChange={e => setCurrentPassword(e.target.value)}
          autoComplete="current-password"
        />
      </div>
      <div className="setting-field">
        <label htmlFor="profile-new-password">New Password</label>
        <input
          id="profile-new-password"
          type="password"
          value={newPassword}
          onChange={e => setNewPassword(e.target.value)}
          autoComplete="new-password"
        />
      </div>
      <div className="setting-field">
        <label htmlFor="profile-confirm-password">Confirm Password</label>
        <input
          id="profile-confirm-password"
          type="password"
          value={confirmPassword}
          onChange={e => setConfirmPassword(e.target.value)}
          autoComplete="new-password"
        />
      </div>

      <div className="setting-divider" />

      <div className="setting-field">
        <label>Document sort order</label>
        <div className="profile-radio-group">
          {([
            ['alphabetical', 'Alphabetical (A-Z)'],
            ['date_newest_first', 'Date (Newest first)'],
            ['date_oldest_first', 'Date (Oldest first)'],
          ] as const).map(([value, label]) => (
            <label key={value} className="profile-radio-label">
              <input
                type="radio"
                name="document_sort"
                value={value}
                checked={preferences.document_sort === value}
                onChange={() => updatePreference('document_sort', value)}
              />
              {label}
            </label>
          ))}
        </div>
      </div>

      <div className="settings-button-right">
        <button className="btn btn-primary" onClick={handleSave} disabled={loading}>
          {loading ? 'Saving…' : 'Save'}
        </button>
        <button className="btn btn-secondary" onClick={handleCancel}>
          Cancel
        </button>
      </div>
    </div>
  )
}
