import { useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import './Documentation.css'

interface DocFile {
  name: string
  label: string
}

const LABEL_MAP: Record<string, string> = {
  overview: 'Overview',
  setup: 'Setup Guide',
  api: 'API Reference',
  icon_guidelines: 'Icon Guidelines',
  ast: 'AST Documentation',
  notes: 'Notes',
}

function formatLabel(name: string): string {
  return LABEL_MAP[name] || name.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
}

export default function Documentation() {
  const { doc } = useParams<{ doc?: string }>()
  const currentDoc = doc || 'overview'
  const [content, setContent] = useState<string>('')
  const [docFiles, setDocFiles] = useState<DocFile[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    // Fetch list of docs once
    if (docFiles.length === 0) {
      fetch('/api/docs')
        .then(r => r.json())
        .then(data => {
          const files = (data.docs || []).map((name: string) => ({
            name,
            label: formatLabel(name),
          }))
          setDocFiles(files)
        })
        .catch(e => console.error('Failed to fetch docs list:', e))
    }
  }, [docFiles.length])

  useEffect(() => {
    setLoading(true)
    setError(null)

    fetch(`/docs/${currentDoc}.md`)
      .then(r => {
        if (!r.ok) {
          throw new Error(`Failed to load ${currentDoc}.md`)
        }
        return r.text()
      })
      .then(text => {
        setContent(text)
        setLoading(false)
      })
      .catch(e => {
        setError(String(e))
        setLoading(false)
      })
  }, [currentDoc])

  return (
    <div className="documentation">
      <header className="doc-header">
        <Link to="/" className="back">
          <span className="material-icons">arrow_back</span>
        </Link>
        <h1>Documentation</h1>
      </header>

      <div className="doc-container">
        <nav className="doc-nav">
          <h3>Docs</h3>
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
          {!loading && !error && <ReactMarkdown>{content}</ReactMarkdown>}
        </main>
      </div>
    </div>
  )
}
