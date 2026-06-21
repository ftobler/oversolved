import { useState } from 'react'
import { useNavigate, Navigate } from 'react-router-dom'
import { useAuth } from '@/contexts/AuthContext'
import type { User } from '@/contexts/AuthContext'
import { http, HttpError } from '@/utils/core/httpClient'
import '@/pages/Login.css'

export default function Login() {
  const { user, loading, setUser } = useAuth()
  const navigate = useNavigate()
  const [credential, setCredential] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  if (!loading && user) {
    return <Navigate to="/documents" replace />
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      const data = await http.postJson<{ user: User }>('/api/auth/login', { credential, password })
      setUser(data.user)
      navigate('/documents')
    } catch (e) {
      if (e instanceof HttpError) {
        const parsed = JSON.parse(e.body || '{}') as { error?: string }
        setError(parsed.error || 'Login failed')
      } else {
        setError(String(e))
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <h1 className="login-logo">Oversolved</h1>
        <form className="login-form" onSubmit={handleSubmit}>
          <input
            className="login-input"
            type="text"
            placeholder="Username or email"
            value={credential}
            onChange={e => setCredential(e.target.value)}
            autoComplete="username"
            autoFocus
          />
          <input
            className="login-input"
            type="password"
            placeholder="Password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            autoComplete="current-password"
          />
          {error && <p className="login-error">{error}</p>}
          <button className="login-btn" type="submit" disabled={submitting}>
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
        {/* Guest-first: signing in is an optional cloud upgrade, never a wall.
            This skips it and drops straight into the local library. */}
        <button className="login-guest-btn" type="button" onClick={() => navigate('/documents')}>
          Continue without signing in
        </button>
      </div>
    </div>
  )
}
