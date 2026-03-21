import { Routes, Route, Link } from 'react-router-dom'
import Visualizer from './pages/Visualizer'
import Documentation from './pages/Documentation'
import Documents from './pages/Documents'
import Part from './pages/Part'
import './App.css'

function Home() {
  return (
    <div className="home">
      <h1>Oversolved</h1>
      <p>Exploratory CAD project.</p>
      <nav>
        <Link to="/visualizer">Sketch Visualizer</Link>
        <Link to="/documents">Documents</Link>
        <Link to="/docs">Documentation</Link>
      </nav>
    </div>
  )
}

function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/visualizer" element={<Visualizer />} />
      <Route path="/documents" element={<Documents />} />
      <Route path="/documents/:docId" element={<Part />} />
      <Route path="/docs" element={<Documentation />} />
      <Route path="/docs/:doc" element={<Documentation />} />
    </Routes>
  )
}

export default App
