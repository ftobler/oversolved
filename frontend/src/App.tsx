import { Routes, Route, Link } from 'react-router-dom'
import Visualizer from './pages/Visualizer'
import './App.css'

function Home() {
  return (
    <div className="home">
      <h1>Oversolve</h1>
      <p>Exploratory CAD project.</p>
      <nav>
        <Link to="/visualizer">Sketch Visualizer</Link>
      </nav>
    </div>
  )
}

function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/visualizer" element={<Visualizer />} />
    </Routes>
  )
}

export default App
