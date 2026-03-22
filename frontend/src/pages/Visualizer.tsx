import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { load as yamlLoad } from 'js-yaml'
import { Canvas } from '@react-three/fiber'
import Sketch3D from '../components/Sketch3D'
import { unflattenGeometry, deriveConstraints } from '../utils/geometryMapping'
import type { Sketch, Constraints, Topology } from '../types/cad'
import './Visualizer.css'

// Two formats are written by conftest.py:
//   sketch_log → { ast_input, solve_result }
//   topology_log → { [featureId]: { geometry, topology, ... } }

interface AstFeature {
  id: string
  entities?: { id: string; kind: string }[]
  constraints?: any[]
  initial?: Record<string, number[]>
}

interface SketchLogEntry {
  ast_input: { features?: AstFeature[] }
  solve_result: {
    geometry: Record<string, number[]>
    solve_ms: number
    status: string
    topology?: Topology
  }
}

interface FeatureData {
  geometry: Record<string, number[]>
  solve_ms: number
  status: string
  topology?: Topology
}

interface TopologyLogEntry {
  [featureId: string]: FeatureData
}

type ResultEntry = SketchLogEntry | TopologyLogEntry

interface Results {
  [testName: string]: ResultEntry
}

function isSketchLogEntry(entry: ResultEntry): entry is SketchLogEntry {
  return 'ast_input' in entry && 'solve_result' in entry
}

// ---------------------------------------------------------------------------
// Card data: everything needed to render one SketchCanvas
// ---------------------------------------------------------------------------

interface CardData {
  id: string
  label: string
  solved: Sketch
  initial: Sketch
  constraints: Constraints
  solve_ms: number
  status: string
  topology?: Topology
}

function extractCards(results: Results): CardData[] {
  const cards: CardData[] = []

  for (const [testName, entry] of Object.entries(results)) {
    if (isSketchLogEntry(entry)) {
      const feature = entry.ast_input.features?.[0]
      const entities = feature?.entities ?? []
      const solved = unflattenGeometry(entry.solve_result.geometry, entities)
      const initial = unflattenGeometry(feature?.initial, entities)
      const constraints = feature ? deriveConstraints(feature, solved) : {}
      cards.push({
        id: testName,
        label: testName,
        solved,
        initial,
        constraints,
        solve_ms: entry.solve_result.solve_ms,
        status: entry.solve_result.status,
        topology: entry.solve_result.topology,
      })
    } else {
      for (const [featureId, data] of Object.entries(entry as TopologyLogEntry)) {
        cards.push({
          id: `${testName}/${featureId}`,
          label: `${testName}/${featureId}`,
          solved: {},
          initial: {},
          constraints: {},
          solve_ms: data.solve_ms,
          status: data.status,
          topology: data.topology,
        })
      }
    }
  }

  return cards
}

// ---------------------------------------------------------------------------
// Camera auto-fit
// ---------------------------------------------------------------------------

function sketchBounds(sketch: Sketch): { cx: number; cy: number; extent: number } {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (const e of Object.values(sketch)) {
    const entity = e as any
    if (entity.start && entity.end && entity.radius != null) {
      const pts = [entity.start, entity.end,
        [entity.center[0] - entity.radius, entity.center[1]],
        [entity.center[0] + entity.radius, entity.center[1]],
        [entity.center[0], entity.center[1] - entity.radius],
        [entity.center[0], entity.center[1] + entity.radius],
      ]
      for (const [x, y] of pts) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y) }
    } else if (entity.start && entity.end) {
      minX = Math.min(minX, entity.start[0], entity.end[0]); maxX = Math.max(maxX, entity.start[0], entity.end[0])
      minY = Math.min(minY, entity.start[1], entity.end[1]); maxY = Math.max(maxY, entity.start[1], entity.end[1])
    } else if (entity.center && entity.radius != null) {
      minX = Math.min(minX, entity.center[0] - entity.radius); maxX = Math.max(maxX, entity.center[0] + entity.radius)
      minY = Math.min(minY, entity.center[1] - entity.radius); maxY = Math.max(maxY, entity.center[1] + entity.radius)
    } else if (entity.x != null) {
      minX = Math.min(minX, entity.x); maxX = Math.max(maxX, entity.x); minY = Math.min(minY, entity.y); maxY = Math.max(maxY, entity.y)
    }
  }
  const cx = isFinite(minX) ? (minX + maxX) / 2 : 0
  const cy = isFinite(minY) ? (minY + maxY) / 2 : 0
  const extent = isFinite(minX) ? Math.max(maxX - minX, maxY - minY, 0.01) : 1
  return { cx, cy, extent }
}

const CARD_SIZE = 330

function SketchCanvas({ card }: { card: CardData }) {
  const { cx, cy, extent } = sketchBounds(card.solved)
  const zoom = (CARD_SIZE * 0.85) / extent

  return (
    <Canvas
      orthographic
      camera={{ position: [cx, cy, 100], zoom, near: 0.1, far: 1000 }}
      style={{ width: CARD_SIZE, height: CARD_SIZE, background: '#111' }}
      gl={{ antialias: true }}
    >
      <Sketch3D
        initial={card.initial}
        solved={card.solved}
        constraints={card.constraints}
        topology={card.topology}
      />
    </Canvas>
  )
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

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

  const cards = results ? extractCards(results) : []

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

      {results && cards.length === 0 && (
        <p className="empty">No test results yet. Run <code>pytest</code> to generate them.</p>
      )}

      <div className="sketch-row">
        {cards.map(card => (
          <div key={card.id} className="sketch-card">
            <div className="sketch-label">
              {card.label} <span className="solve-time">{card.solve_ms} ms</span>
            </div>
            <SketchCanvas card={card} />
          </div>
        ))}
      </div>
    </div>
  )
}
