import { Outlet, NavLink } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import AppHeader from '../components/AppHeader'
import './Settings.css'

export default function Settings() {
  const { user } = useAuth()

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
              <NavLink to="/visualizer" className="settings-nav-item">
                Sketch Visualizer
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
