import { Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider } from '@/contexts/AuthContext'
import { hasBackend } from '@/config/capabilities'
import DisclaimerDialog from '@/components/dialogs/DisclaimerDialog'
import Documentation from '@/pages/Documentation'
import Documents from '@/pages/Documents'
import Part from '@/pages/Part'
import Registry from '@/pages/Registry'
import Login from '@/pages/Login'
import UserProfile from '@/pages/UserProfile'
import Backup from '@/pages/Backup'
import AdminUsers from '@/pages/AdminUsers'
import AdminPeriodicTasks from '@/pages/AdminPeriodicTasks'
import Settings from '@/pages/Settings'
import '@/App.css'

function App() {
  return (
    <AuthProvider>
      {/* Route-independent: the welcome/disclaimer popup must greet a visitor
          no matter which page they land on. */}
      <DisclaimerDialog />
      <Routes>
        {/* Guest-first: no wall. A fresh visitor lands straight on the documents
            library (the local IndexedDB home) and can create/export with no
            account. Login is an optional upgrade, reachable only on the server
            build; on static it is impossible, so /login bounces to /documents.
            Account-only pages (settings/admin/profile) self-guard internally. */}
        <Route path="/login" element={hasBackend ? <Login /> : <Navigate to="/documents" replace />} />
        <Route path="/" element={<Navigate to="/documents" replace />} />
        <Route path="/documents" element={<Documents />} />
        <Route path="/documents/:uuid" element={<Part />} />
        <Route path="/docs" element={<Documentation />} />
        <Route path="/docs/:doc" element={<Documentation />} />
        <Route path="/registry" element={<Registry />} />
        <Route path="/profile" element={<Navigate to="/settings/profile" replace />} />
        <Route path="/admin/users" element={<Navigate to="/settings/admin" replace />} />
        <Route path="/settings" element={<Settings />}>
          <Route path="profile" element={<UserProfile />} />
          <Route path="backup" element={<Backup />} />
          <Route path="admin" element={<AdminUsers />} />
          <Route path="admin-tasks" element={<AdminPeriodicTasks />} />
        </Route>
      </Routes>
    </AuthProvider>
  )
}

export default App
