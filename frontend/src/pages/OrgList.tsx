import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useOrganizations } from '../hooks/useOrganizations'
import './OrgList.css'

export default function OrgList() {
  const { orgs, loading, reload } = useOrganizations()
  const [showCreate, setShowCreate] = useState(false)
  const [slug, setSlug] = useState('')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [createError, setCreateError] = useState<string | null>(null)

  const handleCreate = async () => {
    setCreateError(null)
    const resp = await fetch('/api/orgs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug, name, description }),
    })
    if (!resp.ok) {
      const data = await resp.json()
      setCreateError(data.error ?? 'Failed to create organization.')
      return
    }
    setSlug('')
    setName('')
    setDescription('')
    setShowCreate(false)
    reload()
  }

  if (loading) return <div className="org-list">Loading...</div>

  const personalOrgs = orgs.filter(o => o.is_personal)
  const teamOrgs = orgs.filter(o => !o.is_personal)

  return (
    <div className="org-list">
      <button className="settings-button-right btn btn-secondary" onClick={() => setShowCreate(v => !v)}>
        New Organization
      </button>

      {showCreate && (
        <div className="org-create-form">
          <h3>Create Organization</h3>
          <div className="setting-field">
            <label>Slug</label>
            <input
              placeholder="team-acme"
              value={slug}
              onChange={e => setSlug(e.target.value)}
            />
          </div>
          <div className="setting-field">
            <label>Name</label>
            <input
              placeholder="Team ACME"
              value={name}
              onChange={e => setName(e.target.value)}
            />
          </div>
          <div className="setting-field">
            <label>Description</label>
            <input
              placeholder="Optional"
              value={description}
              onChange={e => setDescription(e.target.value)}
            />
          </div>
          {createError && <p className="org-error">{createError}</p>}
          <div className="org-create-actions">
            <button className="btn" onClick={handleCreate}>Create</button>
            <button className="btn btn-secondary" onClick={() => setShowCreate(false)}>Cancel</button>
          </div>
        </div>
      )}

      {personalOrgs.length > 0 && (
        <section className="org-group">
          <h3>Personal</h3>
          {personalOrgs.map(org => (
            <Link key={org.id} to={`/settings/orgs/${org.slug}`} className="org-row">
              <span className="org-row-name">{org.display_name}</span>
              <span className="org-row-slug">@{org.slug}</span>
              <span className="org-row-role">{org.role}</span>
            </Link>
          ))}
        </section>
      )}

      {teamOrgs.length > 0 && (
        <section className="org-group">
          <h3>Teams</h3>
          {teamOrgs.map(org => (
            <Link key={org.id} to={`/settings/orgs/${org.slug}`} className="org-row">
              <span className="org-row-name">{org.display_name}</span>
              <span className="org-row-slug">@{org.slug}</span>
              <span className="org-row-role">{org.role}</span>
            </Link>
          ))}
        </section>
      )}

      {orgs.length === 0 && (
        <p className="org-empty">No organizations yet.</p>
      )}
    </div>
  )
}
