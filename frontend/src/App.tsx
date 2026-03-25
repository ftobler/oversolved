import { Routes, Route, Link, Navigate } from 'react-router-dom'
import { AuthProvider, useAuth } from './contexts/AuthContext'
import Visualizer from './pages/Visualizer'
import Documentation from './pages/Documentation'
import Documents from './pages/Documents'
import Part from './pages/Part'
import Registry from './pages/Registry'
import Login from './pages/Login'
import './App.css'

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth()
  if (loading) return null
  if (!user) return <Navigate to="/login" replace />
  return <>{children}</>
}

function Home() {
  return (
    <div className="home">
      <h1>Oversolved</h1>
      <p>Exploratory CAD project.</p>
      <nav>
        <Link to="/visualizer">Sketch Visualizer</Link>
        <Link to="/documents">Documents</Link>
        <Link to="/docs">Documentation</Link>
        <Link to="/registry">Registry</Link>
      </nav>
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
      </Routes>
    </AuthProvider>
  )
}

export default App
