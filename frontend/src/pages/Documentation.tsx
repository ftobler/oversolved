import { useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import AppHeader from '@/components/layout/AppHeader'
import { docsSource } from '@/adapters/docs'
import '@/pages/Documentation.css'

interface DocFile {
  name: string
  label: string
}

function extractLabel(name: string, content: string): string {
  const match = content.match(/^#\s+(.+?)$/m)
  if (match && match[1]) {
    return match[1].trim()
  }
  return name.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
}

export default function Documentation() {
  const { doc } = useParams<{ doc?: string }>()
  const currentDoc = doc || 'overview'
  const [content, setContent] = useState<string>('')
  const [docFiles, setDocFiles] = useState<DocFile[]>([])
  const [loading, setLoading] = useState(docsSource !== null)  // false immediately on static
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const source = docsSource
    if (!source) return
    if (docFiles.length === 0) {
      source.list()
        .then(names => {
          Promise.all(
            names.map(name =>
              source.load(name)
                .then(content => ({ name, content }))
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
    const source = docsSource
    if (!source) return  // loading initializes to false on static; nothing to fetch
    source.load(currentDoc)
      .then(content => {
        setContent(content)
        setLoading(false)
        setError(null)
      })
      .catch(e => {
        setError(String(e))
        setContent('')
        setLoading(false)
      })
  }, [currentDoc])

  if (!docsSource) {
    return (
      <div className="documentation">
        <AppHeader title="Documentation" />
        <div className="doc-container">
          <main className="doc-content">
            <p className="error">Documentation is not available on the local build. Start the server to access docs.</p>
          </main>
        </div>
      </div>
    )
  }

  return (
    <div className="documentation">
      <AppHeader title="Documentation" />

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
