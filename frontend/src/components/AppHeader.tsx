import { useNavigate, Link } from 'react-router-dom'
import type { ReactNode } from 'react'
import { useAuth } from '../contexts/AuthContext'
import './AppHeader.css'

interface AppHeaderProps {
  title?: string
  children?: ReactNode
  rightContent?: ReactNode
}

export default function AppHeader({ title, children, rightContent }: AppHeaderProps) {
  const navigate = useNavigate()
  const { user, logout } = useAuth()

  const handleLogout = async () => {
    await logout()
    navigate('/login')
  }

  return (
    <header className="app-header">
      <div className="app-header-left">
        <Link to="/documents" className="toolbar-btn burger" title="Documents">
          <span className="material-icons-outlined">menu</span>
        </Link>
        <Link to="/" className="logo">
          Oversolved
        </Link>
        {title && <h2 className="doc-name">{title}</h2>}
        {children}
      </div>
      <div className="app-header-right">
        {rightContent}
        <a href="/registry" target="_blank" rel="noopener noreferrer" className="toolbar-btn" title="Registry">
          <span className="material-icons-outlined">app_registration</span>
        </a>
        <Link to="/docs" className="toolbar-btn" title="Documentation">
          <span className="material-icons-outlined">help</span>
        </Link>
        <Link to="/visualizer" className="toolbar-btn" title="Visualizer">
          <span className="material-icons-outlined">bug_report</span>
        </Link>
        {user && (
          <>
            <Link to="/settings/profile" className="header-username">{user.username}</Link>
            <button className="toolbar-btn" title="Sign out" onClick={handleLogout}>
              <span className="material-icons-outlined">logout</span>
            </button>
          </>
        )}
      </div>
    </header>
  )
}
