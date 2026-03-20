import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import SketchSvg from '../components/SketchSvg'
import type { Sketch } from '../components/SketchSvg'
import './Visualizer.css'

interface FeatureResult {
  [featureId: string]: {
    initial: Sketch
    solved: Sketch
  }
}

interface Results {
  [testName: string]: FeatureResult
}

export default function Visualizer() {
  const [results, setResults] = useState<Results | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch('/test_output/results.json')
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then(setResults)
      .catch(e => setError(String(e)))
  }, [])

  return (
    <div className="visualizer">
      <header className="vis-header">
        <Link to="/" className="back">
          <span className="material-icons">arrow_back</span>
        </Link>
        <h1>Sketch Visualizer</h1>
        <button className="reload" onClick={() => window.location.reload()}>
          <span className="material-icons">refresh</span>
        </button>
      </header>

      {error && <p className="error">Failed to load results: {error}</p>}

      {results && Object.keys(results).length === 0 && (
        <p className="empty">No test results yet. Run <code>pytest</code> to generate them.</p>
      )}

      {results && Object.entries(results).map(([testName, features]) => (
        <section key={testName} className="test-section">
          <h2>{testName}</h2>
          <div className="sketch-row">
            {Object.entries(features).map(([featureId, { initial, solved }]) => (
              <div key={featureId} className="sketch-card">
                <div className="sketch-label">{featureId}</div>
                <SketchSvg initial={initial} solved={solved} size={280} />
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}
