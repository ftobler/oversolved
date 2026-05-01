import { useParams, Navigate } from 'react-router-dom'
import { useState, useEffect } from 'react'
import './Part.css'

export default function PublicShare() {
  const { uuid } = useParams<{ uuid: string }>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [document, setDocument] = useState<{ name: string; owner_username: string } | null>(null)
  const [unauthorized, setUnauthorized] = useState(false)

  useEffect(() => {
    if (!uuid) return

    fetch(`/api/documents/${uuid}`)
      .then(r => {
        if (r.status === 403) {
          setUnauthorized(true)
          setLoading(false)
          return
        }
        if (!r.ok) throw new Error('Failed to load document')
        return r.json()
      })
      .then(data => {
        if (data) {
          setDocument({ name: data.name, owner_username: data.owner_username })
        }
        setLoading(false)
      })
      .catch(e => {
        setError(String(e))
        setLoading(false)
      })
  }, [uuid])

  if (unauthorized) {
    return <Navigate to="/login" replace />
  }

  if (loading) {
    return (
      <div className="part-page">
        <div style={{ padding: '40px', textAlign: 'center', color: '#ccc' }}>
          <p>Loading...</p>
        </div>
      </div>
    )
  }

  if (error || !document) {
    return (
      <div className="part-page">
        <div style={{ padding: '40px', textAlign: 'center', color: '#ef5350' }}>
          <p>Document not found or access denied</p>
        </div>
      </div>
    )
  }

  return (
    <div className="part-page">
      <div style={{ padding: '20px', borderBottom: '1px solid #333', color: '#ccc' }}>
        <h2 style={{ margin: 0, fontSize: '16px', fontWeight: 600 }}>
          {document.owner_username}/{document.name} <span style={{ color: '#888', fontWeight: 400 }}>(read-only public link)</span>
        </h2>
      </div>
      <div style={{ padding: '40px', textAlign: 'center', color: '#aaa', flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <p>Document viewer for public links coming soon</p>
      </div>
    </div>
  )
}
