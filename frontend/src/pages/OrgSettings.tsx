import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import type { OrgMember } from '../hooks/useOrganizations'
import './OrgSettings.css'

interface OrgDetail {
  id: number
  slug: string
  display_name: string
  description: string | null
  is_personal: boolean
  owner_id: number
  role: string | null
  members: OrgMember[]
}

export default function OrgSettings() {
  const { slug } = useParams<{ slug: string }>()
  const { user } = useAuth()
  const navigate = useNavigate()

  const [org, setOrg] = useState<OrgDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [displayName, setDisplayName] = useState('')
  const [description, setDescription] = useState('')
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saveSuccess, setSaveSuccess] = useState(false)

  const [inviteUsername, setInviteUsername] = useState('')
  const [inviteRole, setInviteRole] = useState('write')
  const [inviteError, setInviteError] = useState<string | null>(null)

  useEffect(() => {
    if (!slug) return
    fetch(`/api/orgs/${slug}`)
      .then(r => {
        if (!r.ok) throw new Error('Not found')
        return r.json()
      })
      .then(data => {
        setOrg(data)
        setDisplayName(data.display_name)
        setDescription(data.description ?? '')
        setLoading(false)
      })
      .catch(() => {
        setError('Organization not found.')
        setLoading(false)
      })
  }, [slug])

  const handleSave = async () => {
    setSaveError(null)
    setSaveSuccess(false)
    const resp = await fetch(`/api/orgs/${slug}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: displayName, description }),
    })
    if (!resp.ok) {
      const data = await resp.json()
      setSaveError(data.error ?? 'Failed to save.')
      return
    }
    setSaveSuccess(true)
  }

  const handleInvite = async () => {
    setInviteError(null)
    const resp = await fetch(`/api/orgs/${slug}/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: inviteUsername, role: inviteRole }),
    })
    if (!resp.ok) {
      const data = await resp.json()
      setInviteError(data.error ?? 'Failed to add member.')
      return
    }
    setInviteUsername('')
    const newMember = await resp.json()
    setOrg(prev => prev ? {
      ...prev,
      members: [...prev.members, {
        user_id: newMember.user_id,
        username: newMember.username,
        role: newMember.role,
        joined_at: new Date().toISOString(),
      }],
    } : prev)
  }

  const handleRoleChange = async (memberId: number, newRole: string) => {
    const resp = await fetch(`/api/orgs/${slug}/members/${memberId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: newRole }),
    })
    if (resp.ok) {
      setOrg(prev => prev ? {
        ...prev,
        members: prev.members.map(m =>
          m.user_id === memberId ? { ...m, role: newRole } : m
        ),
      } : prev)
    }
  }

  const handleRemove = async (memberId: number) => {
    const resp = await fetch(`/api/orgs/${slug}/members/${memberId}`, {
      method: 'DELETE',
    })
    if (resp.ok) {
      setOrg(prev => prev ? {
        ...prev,
        members: prev.members.filter(m => m.user_id !== memberId),
      } : prev)
    }
  }

  const handleDelete = async () => {
    if (!confirm(`Delete organization "${org?.display_name}"? All documents will be lost.`)) return
    const resp = await fetch(`/api/orgs/${slug}`, { method: 'DELETE' })
    if (resp.ok) {
      navigate('/settings/orgs')
    }
  }

  if (loading) return <div className="org-settings">Loading...</div>
  if (error || !org) return <div className="org-settings">{error ?? 'Error'}</div>

  const canAdmin = org.role === 'admin' || org.role === 'owner'
  const isOwner = org.role === 'owner'

  return (
    <div className="org-settings">
      <h2 className="org-settings-title">
        {org.display_name}
        <span className="org-settings-slug">@{org.slug}</span>
      </h2>

      {canAdmin && (
        <section className="org-section">
          <h3>Settings</h3>
          <div className="profile-field">
            <label>Name</label>
            <input
              value={displayName}
              onChange={e => setDisplayName(e.target.value)}
            />
          </div>
          <div className="profile-field">
            <label>Description</label>
            <input
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="Optional description"
            />
          </div>
          <p className="org-field-readonly">Slug: {org.slug} (read-only)</p>
          {saveError && <p className="org-error">{saveError}</p>}
          {saveSuccess && <p className="org-success">Saved.</p>}
          <button className="btn" onClick={handleSave}>Save Changes</button>
        </section>
      )}

      <section className="org-section">
        <h3>Members</h3>
        <ul className="org-member-list">
          {org.members.map(m => (
            <li key={m.user_id} className="org-member">
              <span className="org-member-name">{m.username}</span>
              {canAdmin && m.user_id !== user?.id ? (
                <>
                  <select
                    value={m.role}
                    onChange={e => handleRoleChange(m.user_id, e.target.value)}
                    className="org-role-select"
                  >
                    <option value="read">read</option>
                    <option value="write">write</option>
                    <option value="admin">admin</option>
                    <option value="owner">owner</option>
                  </select>
                  <button
                    className="org-remove-btn"
                    onClick={() => handleRemove(m.user_id)}
                  >Remove</button>
                </>
              ) : (
                <span className="org-member-role">{m.role}</span>
              )}
            </li>
          ))}
        </ul>
        {canAdmin && (
          <div className="org-invite">
            <input
              placeholder="Username"
              value={inviteUsername}
              onChange={e => setInviteUsername(e.target.value)}
            />
            <select value={inviteRole} onChange={e => setInviteRole(e.target.value)}>
              <option value="read">read</option>
              <option value="write">write</option>
              <option value="admin">admin</option>
              <option value="owner">owner</option>
            </select>
            <button className="btn" onClick={handleInvite}>Add Member</button>
            {inviteError && <p className="org-error">{inviteError}</p>}
          </div>
        )}
      </section>

      {isOwner && !org.is_personal && (
        <section className="org-section org-danger">
          <h3>Danger Zone</h3>
          <button className="btn btn-danger" onClick={handleDelete}>
            Delete Organization
          </button>
        </section>
      )}
    </div>
  )
}
