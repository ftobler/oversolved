import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { load as yamlLoad } from 'js-yaml'
import { stringify as yamlStringify } from 'yaml'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import Sketch3D from '../components/Sketch3D'
import { unflattenGeometry, deriveConstraints } from '../utils/geometryMapping'
import type { Sketch, Constraints, Topology } from '../types/cad'
import AppHeader from '../components/AppHeader'
import './Visualizer.css'

// Two formats are written by conftest.py:
//   sketch_log → { ast_input, solve_result }
//   topology_log → { [featureId]: { geometry, topology, ... } }

interface AstFeature {
  id: string
  entities?: { id: string; kind: string }[]
  constraints?: { id: string; kind: string; [key: string]: unknown }[]
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

// ─── Card data ───

interface CardData {
  id: string
  label: string
  solved: Sketch
  initial: Sketch
  constraints: Constraints
  solve_ms: number
  status: string
  topology?: Topology
  astInput?: unknown  // present for sketch_log entries; enables open-as-document
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
      cards.push({ id: testName, label: testName, solved, initial, constraints, solve_ms: entry.solve_result.solve_ms, status: entry.solve_result.status, topology: entry.solve_result.topology, astInput: entry.ast_input })
    } else {
      for (const [featureId, data] of Object.entries(entry as TopologyLogEntry)) {
        cards.push({ id: `${testName}/${featureId}`, label: `${testName}/${featureId}`, solved: {}, initial: {}, constraints: {}, solve_ms: data.solve_ms, status: data.status, topology: data.topology })
      }
    }
  }
  return cards
}

// ─── Camera fit ───

const CARD_SIZE = 330

function sketchBounds(sketch: Sketch): { cx: number; cy: number; extent: number } {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (const e of Object.values(sketch)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const entity = e as any
    if (entity.start && entity.end && entity.radius != null) {
      const pts = [entity.start, entity.end,
        [entity.center[0] - entity.radius, entity.center[1]], [entity.center[0] + entity.radius, entity.center[1]],
        [entity.center[0], entity.center[1] - entity.radius], [entity.center[0], entity.center[1] + entity.radius]]
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

// ─── Render-and-forget: one hidden Canvas renders all cards one at a time,
// captures each as a PNG data URL, then unmounts. Zero persistent GL contexts. ───

function CaptureController({ card, onCapture }: { card: CardData; onCapture: (url: string) => void }) {
  const { gl, camera, invalidate } = useThree()
  const capturedRef = useRef(false)

  useEffect(() => {
    const { cx, cy, extent } = sketchBounds(card.solved)
    const zoom = (CARD_SIZE * 0.85) / extent
    const cam = camera as THREE.OrthographicCamera
    cam.position.set(cx, cy, 100)
    // eslint-disable-next-line react-hooks/immutability
    cam.zoom = zoom
    cam.updateProjectionMatrix()
    capturedRef.current = false
    invalidate()
  }, [card, camera, gl, invalidate])

  useFrame(() => {
    if (capturedRef.current) return
    capturedRef.current = true
    onCapture(gl.domElement.toDataURL())
  })

  return (
    <Sketch3D
      initial={card.initial}
      solved={card.solved}
      constraints={card.constraints}
      topology={card.topology}
    />
  )
}

function SketchQueue({ cards, onSnapshot }: { cards: CardData[]; onSnapshot: (id: string, url: string) => void }) {
  const [index, setIndex] = useState(0)

  const handleCapture = useCallback((url: string) => {
    onSnapshot(cards[index].id, url)
    setIndex(i => i + 1)
  }, [cards, index, onSnapshot])

  if (index >= cards.length) return null

  const card = cards[index]

  return (
    <div style={{ position: 'fixed', left: -9999, top: -9999, pointerEvents: 'none' }}>
      <Canvas
        orthographic
        frameloop="demand"
        camera={{ position: [0, 0, 100], zoom: 200, near: 0.1, far: 1000 }}
        style={{ width: CARD_SIZE, height: CARD_SIZE }}
        gl={{ antialias: true, preserveDrawingBuffer: true }}
      >
        <CaptureController key={card.id} card={card} onCapture={handleCapture} />
      </Canvas>
    </div>
  )
}

// ─── Page ───

export default function Visualizer() {
  const navigate = useNavigate()
  const [results, setResults] = useState<Results | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [snapshots, setSnapshots] = useState<Record<string, string>>({})

  const openAsDocument = useCallback(async (card: CardData) => {
    if (!card.astInput) return
    const docId = card.id
    const response = await fetch(`/api/documents/${docId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: yamlStringify(card.astInput) }),
    })
    if (response.ok) {
      navigate(`/documents/${docId}`)
    }
  }, [navigate])

  useEffect(() => {
    fetch('/test_output/results.yaml')
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.text()
      })
      .then(text => setResults(yamlLoad(text) as Results))
      .catch(e => setError(String(e)))
  }, [])

  const handleSnapshot = useCallback((id: string, url: string) => {
    setSnapshots(prev => ({ ...prev, [id]: url }))
  }, [])

  const cards = results ? extractCards(results) : []

  return (
    <div className="visualizer">
      <AppHeader title="Test Visualizer" rightContent={
        <button className="toolbar-btn" title="Reload" onClick={() => window.location.reload()}>
          <span className="material-icons-outlined">refresh</span>
        </button>
      } />

      <div className="visualizer-content">
        {error && <p className="error">Failed to load results: {error}</p>}

        {results && cards.length === 0 && (
          <p className="empty">No test results yet. Run <code>pytest</code> to generate them.</p>
        )}

        {/* Single hidden Canvas that renders all cards sequentially */}
        {cards.length > 0 && (
          <SketchQueue cards={cards} onSnapshot={handleSnapshot} />
        )}

        <div className="sketch-row">
          {cards.map(card => (
            <div
              key={card.id}
              className="sketch-card"
              onClick={() => openAsDocument(card)}
              style={card.astInput ? { cursor: 'pointer' } : undefined}
              title={card.astInput ? 'Open as document' : undefined}
            >
              <div className="sketch-label">
                {card.label} <span className="solve-time">{card.solve_ms} ms</span>
              </div>
              {snapshots[card.id]
                ? <img src={snapshots[card.id]} width={CARD_SIZE} height={CARD_SIZE} style={{ display: 'block' }} />
                : <div style={{ width: CARD_SIZE, height: CARD_SIZE, background: '#111' }} />
              }
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
