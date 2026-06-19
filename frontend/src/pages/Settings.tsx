import { Outlet, NavLink, Navigate } from 'react-router-dom'
import { useAuth } from '@/contexts/AuthContext'
import AppHeader from '@/components/layout/AppHeader'
import '@/pages/Settings.css'

export default function Settings() {
  const { user, loading } = useAuth()

  // Account pages exist only for a signed-in user. A guest -- including every
  // visitor on the static build, where there is no sign-in -- has no settings,
  // so guard the whole subtree by redirecting rather than rendering an empty
  // profile form that posts nowhere. Wait out the initial auth restore so a
  // signed-in reload is not bounced mid-check.
  if (loading) return null
  if (!user) return <Navigate to="/documents" replace />

  return (
    <div className="settings">
      <AppHeader title="Settings" />
      <div className="settings-body">
        <aside className="settings-sidebar">
          <NavLink to="/settings/profile" className="settings-nav-item">
            Profile
          </NavLink>
          {user?.is_admin && (
            <>
              <NavLink to="/settings/backup" className="settings-nav-item">
                Backup
                <span className="admin-badge">admin</span>
              </NavLink>
              <NavLink to="/settings/admin" className="settings-nav-item">
                Users
                <span className="admin-badge">admin</span>
              </NavLink>
              <NavLink to="/settings/admin-tasks" className="settings-nav-item">
                Periodic Tasks
                <span className="admin-badge">admin</span>
              </NavLink>
              <NavLink to="/registry" className="settings-nav-item">
                Registry
                <span className="admin-badge">admin</span>
              </NavLink>
            </>
          )}
        </aside>
        <div className="settings-content">
          <Outlet />
        </div>
      </div>
    </div>
  )
}
