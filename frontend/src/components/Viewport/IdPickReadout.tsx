import { useEffect, useRef, useState, type RefObject } from 'react'
import type * as THREE from 'three'
import { getLivePipeline, type ResolvedHit } from '@/picking'
import { getToolAllowedLayers } from '@/registry/toolPickConfig'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { PART_EDITOR_CONSUMED_LAYERS } from '@/components/Viewport/idDispatch/useIdBufferPointerDispatch'

/**
 * What the pick pass would answer under the cursor, in words.
 *
 * The ID overlay shows that a mark EXISTS; it cannot say which entity a pixel
 * belongs to, whether the buffer was readable at that instant, or which of
 * several candidates the click would take. Those are the three things every
 * "this cannot be selected" report actually turns on, and without them the only
 * way to find out has been to screenshot the buffer and count pixels by hand.
 *
 * So this runs the SAME resolve the click runs -- same pipeline, same window,
 * same allowed-layer filter for the active tool -- and prints the whole
 * candidate list. A missing entity, an entity that resolves but ranks below
 * something unexpected, and a buffer that was mid-rebuild all look different
 * here, where in the viewport they all look like nothing happening.
 *
 * Mounted beside the Canvas (not inside it) while the collision debug view is
 * on. Dev affordance only: it neither reads nor writes any interaction state.
 */
export default function IdPickReadout({ glRef }: { glRef: RefObject<THREE.WebGLRenderer | null> }) {
  const [hits, setHits] = useState<ResolvedHit[]>([])
  const [note, setNote] = useState('move the cursor over the viewport')
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null)
  // rAF-coalesced like the hover dispatcher's: a resolve is a blocking
  // readback, and a high-rate pointer would otherwise stall the frame on every
  // move just to keep a debug panel current.
  const frame = useRef(0)
  const queued = useRef<{ x: number; y: number } | null>(null)

  useEffect(() => {
    let canvas: HTMLCanvasElement | null = null
    let attachFrame = 0

    const run = (clientX: number, clientY: number) => {
      const gl = glRef.current
      const pipeline = getLivePipeline()
      if (!gl || !pipeline || !canvas) { setNote('no live pipeline'); setHits([]); return }
      const rect = canvas.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) return
      const px = {
        x: (clientX - rect.left) * (canvas.width / rect.width),
        y: (clientY - rect.top) * (canvas.height / rect.height),
      }
      setCursor(px)
      // Reported rather than hidden: a dirty buffer makes every resolve answer
      // null, which is indistinguishable from empty space at the call site and
      // is exactly the state a mid-rebuild click lands in.
      if (pipeline.isDirty()) { setNote('id buffer DIRTY -- every resolve returns null'); setHits([]); return }
      const tool = useSketchEditorStore.getState().activeTool
      const allowed = getToolAllowedLayers(tool)
      const layers = allowed === null
        ? PART_EDITOR_CONSUMED_LAYERS
        : new Set([...PART_EDITOR_CONSUMED_LAYERS].filter(l => allowed.has(l)))
      const all = pipeline.resolveAllSync(gl, px, { allowedLayers: layers })
      setHits(all)
      setNote(all.length === 0 ? 'nothing in the pick disc' : `tool=${tool ?? 'idle'}`)
    }

    const onMove = (e: PointerEvent) => {
      if (frame.current !== 0) { queued.current = { x: e.clientX, y: e.clientY }; return }
      run(e.clientX, e.clientY)
      frame.current = requestAnimationFrame(() => {
        frame.current = 0
        const q = queued.current
        queued.current = null
        if (q) run(q.x, q.y)
      })
    }

    // `showDebugHit` is a persisted preference, so on a reload this mounts
    // before the renderer exists. Poll for the canvas rather than silently
    // attaching to nothing, the same way the pointer dispatcher does.
    const tryAttach = () => {
      const el = glRef.current?.domElement ?? null
      if (!el) { attachFrame = requestAnimationFrame(tryAttach); return }
      canvas = el
      canvas.addEventListener('pointermove', onMove)
    }
    tryAttach()

    return () => {
      if (attachFrame) cancelAnimationFrame(attachFrame)
      canvas?.removeEventListener('pointermove', onMove)
      if (frame.current) cancelAnimationFrame(frame.current)
      frame.current = 0
      queued.current = null
    }
  }, [glRef])

  return (
    <div style={PANEL}>
      <div style={HEAD}>
        pick readout
        {cursor && <span style={DIM}> @ {cursor.x.toFixed(1)}, {cursor.y.toFixed(1)} device px</span>}
      </div>
      <div style={DIM}>{note}</div>
      {hits.map((h, i) => (
        <div key={`${h.id}:${h.entityKey}`} style={i === 0 ? WINNER : ROW}>
          {i === 0 ? '> ' : '  '}#{h.id} {h.layer} d={h.distancePx.toFixed(2)}
          <div style={KEY}>{h.entityKey}</div>
        </div>
      ))}
    </div>
  )
}

const PANEL: React.CSSProperties = {
  position: 'absolute', top: 8, left: 8, zIndex: 20,
  maxWidth: 420, maxHeight: '60%', overflowY: 'auto',
  padding: '6px 8px', borderRadius: 4, pointerEvents: 'none',
  background: 'rgba(0,0,0,0.72)', color: '#e0e0e0',
  font: '11px/1.45 ui-monospace, monospace', whiteSpace: 'pre',
}
const HEAD: React.CSSProperties = { fontWeight: 700, marginBottom: 2 }
const DIM: React.CSSProperties = { color: '#9e9e9e' }
const ROW: React.CSSProperties = { marginTop: 3 }
const WINNER: React.CSSProperties = { marginTop: 3, color: '#81c784' }
const KEY: React.CSSProperties = { color: '#90caf9', paddingLeft: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }
