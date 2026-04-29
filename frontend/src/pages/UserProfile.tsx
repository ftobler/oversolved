import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import './UserProfile.css'

export default function UserProfile() {
  const { user, setUser } = useAuth()
  const navigate = useNavigate()
  const [username, setUsername] = useState('')
  const [email, setEmail] = useState('')
  const [nickname, setNickname] = useState('')
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
      setNickname(user.nickname || '')
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
      if (nickname !== (user?.nickname || '')) {
        body.nickname = nickname
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

      if ((body.username || body.email || body.nickname) && user) {
        setUser({
          ...user,
          username: body.username || user.username,
          email: body.email !== undefined ? body.email : user.email,
          nickname: body.nickname !== undefined ? body.nickname : user.nickname,
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
      setNickname(user.nickname || '')
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
    <div className="profile-card">

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
        <label htmlFor="profile-email">Email</label>
        <input
          id="profile-email"
          type="email"
          value={email}
          onChange={e => setEmail(e.target.value)}
          autoComplete="email"
        />
      </div>

      <div className="profile-field">
        <label htmlFor="profile-nickname">Nickname</label>
        <input
          id="profile-nickname"
          type="text"
          value={nickname}
          onChange={e => setNickname(e.target.value)}
          autoComplete="nickname"
        />
      </div>

      <div className="profile-divider" />

      <div className="profile-field">
        <label htmlFor="profile-current-password">Current Password</label>
        <input
          id="profile-current-password"
          type="password"
          value={currentPassword}
          onChange={e => setCurrentPassword(e.target.value)}
          autoComplete="current-password"
        />
      </div>
      <div className="profile-field">
        <label htmlFor="profile-new-password">New Password</label>
        <input
          id="profile-new-password"
          type="password"
          value={newPassword}
          onChange={e => setNewPassword(e.target.value)}
          autoComplete="new-password"
        />
      </div>
      <div className="profile-field">
        <label htmlFor="profile-confirm-password">Confirm Password</label>
        <input
          id="profile-confirm-password"
          type="password"
          value={confirmPassword}
          onChange={e => setConfirmPassword(e.target.value)}
          autoComplete="new-password"
        />
      </div>

      <div className="profile-actions">
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
