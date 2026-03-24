import { useEffect, useState } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import './Documentation.css'

interface DocFile {
  name: string
  label: string
}

function extractLabel(name: string, content: string): string {
  // Try to extract first h1 heading from markdown
  const match = content.match(/^#\s+(.+?)$/m)
  if (match && match[1]) {
    return match[1].trim()
  }
  // Fallback to formatted filename
  return name.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
}

export default function Documentation() {
  const navigate = useNavigate()
  const { doc } = useParams<{ doc?: string }>()
  const currentDoc = doc || 'overview'
  const [content, setContent] = useState<string>('')
  const [docFiles, setDocFiles] = useState<DocFile[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    // Fetch list of docs and their content to extract labels
    if (docFiles.length === 0) {
      fetch('/api/docs')
        .then(r => r.json())
        .then(data => {
          const names = data.docs || []
          // Fetch content for all docs to extract labels
          Promise.all(
            names.map((name: string) =>
              fetch(`/api/docs/${name}`)
                .then(r => r.json())
                .catch(() => ({ name, content: '' }))
            )
          )
            .then(results => {
              const files = results.map(result => ({
                name: result.name,
                label: extractLabel(result.name, result.content || ''),
              }))
              setDocFiles(files)
            })
            .catch(e => {
              console.error('Failed to fetch docs:', e)
              // Fallback: just use names without content
              const files = names.map((name: string) => ({
                name,
                label: extractLabel(name, ''),
              }))
              setDocFiles(files)
            })
        })
        .catch(e => console.error('Failed to fetch docs list:', e))
    }
  }, [docFiles.length])

  useEffect(() => {
    fetch(`/api/docs/${currentDoc}`)
      .then(r => {
        if (!r.ok) {
          throw new Error(`Failed to load ${currentDoc}`)
        }
        return r.json()
      })
      .then(data => {
        setContent(data.content)
        setLoading(false)
        setError(null)
      })
      .catch(e => {
        setError(String(e))
        setContent('')
        setLoading(false)
      })
  }, [currentDoc])

  return (
    <div className="documentation">
      <header className="doc-toolbar">
        <div className="toolbar-left">
          <button className="toolbar-btn burger" title="Documents" onClick={() => navigate('/documents')}>
            <span className="material-icons-outlined">menu</span>
          </button>
          <button className="logo" onClick={() => navigate('/')}>
            Oversolved
          </button>
          <h2 className="doc-name">Documentation</h2>
        </div>
        <div className="toolbar-right">
          <Link to="/visualizer" className="toolbar-btn" title="Visualizer">
            <span className="material-icons-outlined">bug_report</span>
          </Link>
        </div>
      </header>

      <div className="doc-container">
        <nav className="doc-nav">
          <ul>
            {docFiles.length === 0 ? (
              <li className="loading-item">Loading...</li>
            ) : (
              docFiles.map(file => (
                <li key={file.name}>
                  <Link to={`/docs/${file.name}`} className={currentDoc === file.name ? 'active' : ''}>
                    {file.label}
                  </Link>
                </li>
              ))
            )}
          </ul>
        </nav>

        <main className="doc-content">
          {loading && <p className="loading">Loading documentation...</p>}
          {error && <p className="error">Error: {error}</p>}
          {!loading && !error && <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>}
        </main>
      </div>
    </div>
  )
}
