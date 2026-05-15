import { Routes, Route, Link, Navigate } from 'react-router-dom'
import { AuthProvider, useAuth } from '@/contexts/AuthContext'
import Visualizer from '@/pages/Visualizer'
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

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth()
  if (loading) return null
  if (!user) return <Navigate to="/login" replace />
  return <>{children}</>
}

function Home() {
  return (
    <div className="landing">
      <div className="landing-logo">Oversolved</div>
      <p className="landing-tagline">Browser-based mechanical CAD</p>
      <nav className="landing-nav">
        <Link to="/documents">Documents</Link>
        <Link to="/docs">Documentation</Link>
      </nav>
      <footer className="landing-footer">
        Copyright 2026
      </footer>
    </div>
  )
}

function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/" element={<ProtectedRoute><Home /></ProtectedRoute>} />
        <Route path="/documents" element={<ProtectedRoute><Documents /></ProtectedRoute>} />
        <Route path="/documents/:uuid" element={<ProtectedRoute><Part /></ProtectedRoute>} />
        <Route path="/docs" element={<ProtectedRoute><Documentation /></ProtectedRoute>} />
        <Route path="/docs/:doc" element={<ProtectedRoute><Documentation /></ProtectedRoute>} />
        <Route path="/registry" element={<ProtectedRoute><Registry /></ProtectedRoute>} />
        <Route path="/visualizer" element={<ProtectedRoute><Visualizer /></ProtectedRoute>} />
        <Route path="/profile" element={<Navigate to="/settings/profile" replace />} />
        <Route path="/admin/users" element={<Navigate to="/settings/admin" replace />} />
        <Route path="/settings" element={<ProtectedRoute><Settings /></ProtectedRoute>}>
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
