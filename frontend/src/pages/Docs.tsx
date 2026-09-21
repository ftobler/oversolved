import { Outlet, NavLink } from 'react-router-dom'
import AppHeader from '@/components/layout/AppHeader'
import '@/pages/Docs.css'

// The docs area's page list, kept as data so the sidebar is generated rather
// than hand-written: adding a reference page is one entry here plus one route in
// App.tsx, and there is no third place to forget. Unlike the settings shell this
// replaces, nothing here is account- or role-gated -- docs are public reference
// material and every visitor is a guest.
const DOCS_PAGES = [
  { to: '/docs/registry', label: 'Registry' },
  { to: '/docs/licenses', label: 'Licenses' },
] as const

export default function Docs() {
  return (
    <div className="docs">
      <AppHeader title="Docs" />
      <div className="docs-body">
        <aside className="docs-sidebar">
          {DOCS_PAGES.map(page => (
            <NavLink key={page.to} to={page.to} className="docs-nav-item">
              {page.label}
            </NavLink>
          ))}
        </aside>
        <div className="docs-content">
          <Outlet />
        </div>
      </div>
    </div>
  )
}
