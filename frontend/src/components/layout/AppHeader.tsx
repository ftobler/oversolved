import { useNavigate, Link } from 'react-router-dom'
import type { ReactNode } from 'react'
import { useAuth } from '@/contexts/AuthContext'
import { hasBackend } from '@/config/capabilities'
import '@/components/layout/AppHeader.css'

interface AppHeaderProps {
  title?: string
  children?: ReactNode
  rightContent?: ReactNode
}

export default function AppHeader({ title, children, rightContent }: AppHeaderProps) {
  const navigate = useNavigate()
  const { user, logout } = useAuth()

  const handleLogout = async () => {
    // Logout is non-destructive: it drops the cloud credential and drops you back
    // to the guest session, still inside the app on your local library. So return
    // to the documents home, not the login page.
    await logout()
    navigate('/documents')
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
        <Link to="/docs" className="toolbar-btn" title="Documentation">
          <span className="material-icons-outlined">help</span>
        </Link>
        {/* Three states of one guest-first session:
            - no server reachable  -> "cloud not available" (login impossible here)
            - server, not signed in -> a "Sign in" affordance (the optional upgrade)
            - server, signed in     -> the account name + a logout button */}
        {!hasBackend ? (
          <span
            className="cloud-not-available"
            title="Sign-in requires the server build"
          >
            cloud not available
          </span>
        ) : user ? (
          <>
            <Link to="/settings/profile" className="header-username">{user.username}</Link>
            <button className="toolbar-btn" title="Sign out" onClick={handleLogout}>
              <span className="material-icons-outlined">logout</span>
            </button>
          </>
        ) : (
          <Link to="/login" className="header-login" title="Sign in">
            <span className="material-icons-outlined">login</span>
            <span className="header-login-label">Sign in</span>
          </Link>
        )}
      </div>
    </header>
  )
}
