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
          <NavLink to="/settings/orgs" className="settings-nav-item">
            Organizations
          </NavLink>
          {user?.is_admin && (
            <>
              <NavLink to="/settings/admin" className="settings-nav-item">
                Admin
              </NavLink>
              <NavLink to="/settings/admin-tasks" className="settings-nav-item">
                Periodic Tasks
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
