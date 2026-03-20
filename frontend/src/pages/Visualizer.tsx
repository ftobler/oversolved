import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { load as yamlLoad } from 'js-yaml'
import SketchSvg from '../components/SketchSvg'
import type { Sketch, Constraints } from '../components/SketchSvg'
import './Visualizer.css'

interface FeatureResult {
  [featureId: string]: {
    geometry: {
      initial: Sketch
      solved: Sketch
    }
    constraints: Constraints
    status: 'fully_constrained' | 'underconstrained' | 'overconstrained'
    solve_ms: number
  }
}

interface Results {
  [testName: string]: FeatureResult
}

export default function Visualizer() {
  const [results, setResults] = useState<Results | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch('/test_output/results.yaml')
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.text()
      })
      .then(text => setResults(yamlLoad(text) as Results))
      .catch(e => setError(String(e)))
  }, [])

  return (
    <div className="visualizer">
      <header className="vis-header">
        <Link to="/" className="back">
          <span className="material-icons">arrow_back</span>
        </Link>
        <h1>Test Visualizer</h1>
        <button className="reload" onClick={() => window.location.reload()}>
          <span className="material-icons">refresh</span>
        </button>
      </header>

      {error && <p className="error">Failed to load results: {error}</p>}

      {results && Object.keys(results).length === 0 && (
        <p className="empty">No test results yet. Run <code>pytest</code> to generate them.</p>
      )}

      {results && (
        <div className="sketch-row">
          {Object.entries(results).flatMap(([testName, features]) =>
            Object.entries(features).map(([featureId, { geometry, constraints, status, solve_ms }]) => (
              <div key={`${testName}/${featureId}`} className="sketch-card">
                <div className="sketch-label">{testName}/{featureId} <span className="solve-time">{solve_ms} ms</span></div>
                <SketchSvg initial={geometry.initial} solved={geometry.solved} status={status} size={330} constraints={constraints} />
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}
