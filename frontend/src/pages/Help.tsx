import { Outlet, NavLink } from 'react-router-dom'
import AppHeader from '@/components/layout/AppHeader'
import '@/pages/Help.css'

// The help area's page list, kept as data so the sidebar is generated rather
// than hand-written: adding a reference page is one entry here plus one route in
// App.tsx, and there is no third place to forget. Unlike the settings shell this
// replaces, nothing here is account- or role-gated -- help is public reference
// material and every visitor is a guest.
const HELP_PAGES = [
  { to: '/help/registry', label: 'Registry' },
] as const

export default function Help() {
  return (
    <div className="help">
      <AppHeader title="Help" />
      <div className="help-body">
        <aside className="help-sidebar">
          {HELP_PAGES.map(page => (
            <NavLink key={page.to} to={page.to} className="help-nav-item">
              {page.label}
            </NavLink>
          ))}
        </aside>
        <div className="help-content">
          <Outlet />
        </div>
      </div>
    </div>
  )
}
