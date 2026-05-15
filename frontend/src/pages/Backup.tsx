import { useState, useRef } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { http } from '../utils/httpClient'
import './UserProfile.css'

export default function Backup() {
  const { user } = useAuth()
  const [loadingDownload, setLoadingDownload] = useState(false)
  const [loadingImport, setLoadingImport] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  if (!user?.is_admin) {
    return (
      <div className="setting-card">
        <p>Backup is only available to administrators.</p>
      </div>
    )
  }

  const handleDownload = async () => {
    setLoadingDownload(true)
    try {
      const blob = await http.getBlob('/api/admin/backup')
      const url = window.URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `backup-${new Date().toISOString().split('T')[0]}.zip`
      document.body.appendChild(a)
      a.click()
      window.URL.revokeObjectURL(url)
      document.body.removeChild(a)
    } catch (e) {
      alert(`Error: ${String(e)}`)
    } finally {
      setLoadingDownload(false)
    }
  }

  const handleImport = () => {
    fileInputRef.current?.click()
  }

  const handleFileSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return

    setLoadingImport(true)
    try {
      const formData = new FormData()
      formData.append('file', file)

      const data = await http.postForm<{ imported_count: number; skipped_count: number; errors?: string[] }>('/api/admin/import-backup', formData)

      const message = `Import complete!\nImported: ${data.imported_count} documents`
        + (data.skipped_count > 0 ? `\nSkipped: ${data.skipped_count}` : '')
        + (data.errors && data.errors.length > 0 ? `\n\nErrors:\n${data.errors.slice(0, 3).join('\n')}${data.errors.length > 3 ? `\n... and ${data.errors.length - 3} more` : ''}` : '')

      alert(message)
    } catch (e) {
      alert(`Error: ${String(e)}`)
    } finally {
      setLoadingImport(false)
      if (fileInputRef.current) {
        fileInputRef.current.value = ''
      }
    }
  }

  return (
    <div className="setting-card">
      <p>Download all documents on the server as a ZIP file.</p>

      <div className="setting-divider" />

      <div className="settings-button-right">
        <input
          ref={fileInputRef}
          type="file"
          accept=".zip"
          style={{ display: 'none' }}
          onChange={handleFileSelect}
        />
        <button className="btn btn-secondary" onClick={handleImport} disabled={loadingImport}>
          {loadingImport ? 'Importing…' : 'Import Backup'}
        </button>
        <button className="btn btn-primary" onClick={handleDownload} disabled={loadingDownload}>
          {loadingDownload ? 'Preparing…' : 'Download Backup'}
        </button>
      </div>
    </div>
  )
}
