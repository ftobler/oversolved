import { useNavigate, Link } from 'react-router-dom'
import type { ReactNode } from 'react'
import './AppHeader.css'

interface AppHeaderProps {
  title?: string
  children?: ReactNode
  rightContent?: ReactNode
}

export default function AppHeader({ title, children, rightContent }: AppHeaderProps) {
  const navigate = useNavigate()
  return (
    <header className="app-header">
      <div className="app-header-left">
        <button className="toolbar-btn burger" title="Documents" onClick={() => navigate('/documents')}>
          <span className="material-icons-outlined">menu</span>
        </button>
        <button className="logo" onClick={() => navigate('/')}>
          Oversolved
        </button>
        {title && <h2 className="doc-name">{title}</h2>}
        {children}
      </div>
      <div className="app-header-right">
        {rightContent}
        <Link to="/docs" className="toolbar-btn" title="Documentation">
          <span className="material-icons-outlined">help</span>
        </Link>
        <Link to="/visualizer" className="toolbar-btn" title="Visualizer">
          <span className="material-icons-outlined">bug_report</span>
        </Link>
      </div>
    </header>
  )
}
