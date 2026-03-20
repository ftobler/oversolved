import { Routes, Route, Link } from 'react-router-dom'
import Visualizer from './pages/Visualizer'
import Documentation from './pages/Documentation'
import './App.css'

function Home() {
  return (
    <div className="home">
      <h1>Oversolve</h1>
      <p>Exploratory CAD project.</p>
      <nav>
        <Link to="/visualizer">Sketch Visualizer</Link>
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
      <Route path="/docs" element={<Documentation />} />
      <Route path="/docs/:doc" element={<Documentation />} />
    </Routes>
  )
}

export default App
