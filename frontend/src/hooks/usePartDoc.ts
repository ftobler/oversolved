import { useState, useCallback, useRef, useEffect } from 'react'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import type { PartDoc, SketchData, Mutation } from '../types/cad'
import { unflattenGeometry } from '../utils/geometryMapping'
import {
  applyMoveVertex,
  applyMoveEntity,
  applyAddConstraint,
  applyDeleteElements,
  applyAddEntity,
  applyAddRect,
  applySetConstraintValue,
  applySetConstraintPos,
  applyToggleConstruction,
} from '../utils/yamlMutations'

function healDoc(raw: unknown): PartDoc {
  const doc = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    ...doc,
    version:  (doc.version  as number)  ?? 1,
    kind:     (doc.kind     as string)  ?? 'part',
    features: Array.isArray(doc.features) ? doc.features : [],
  } as PartDoc
}

export function usePartDoc(uuid: string | undefined, mode: string, setCodeText: (t: string) => void) {
  const [doc, setDoc] = useState<PartDoc | null>(null)
  const [docName, setDocName] = useState<string>('')
  const docRef = useRef<PartDoc | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [solveResults, setSolveResults] = useState<Record<string, SketchData>>({})
  const [solving, setSolving] = useState(false)
  const [solveTime, setSolveTime] = useState<number | null>(null)
  const [solveError, setSolveError] = useState<string | null>(null)
  const [solveResult, setSolveRawResult] = useState<string>('')
  const [undoStack, setUndoStack] = useState<PartDoc[]>([])
  const [redoStack, setRedoStack] = useState<PartDoc[]>([])

  const reSolve = useCallback(async (d: PartDoc) => {
    setSolving(true)
    setSolveTime(null)
    const startTime = performance.now()
    try {
      const response = await fetch('/api/solve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(d),
      })
      const data = await response.json()
      const endTime = performance.now()
      setSolveTime(Math.round((endTime - startTime) * 100) / 100)
      if (!response.ok) {
        setSolveError(data.error || `Solve failed (${response.status})`)
        setSolveRawResult(data.error || `Solve failed (${response.status})`)
      } else {
        const result = data.result as Record<string, { geometry?: Record<string, number[]>; status?: string; features?: Record<string, { status?: string }>; topology?: import('../types/cad').Topology; constraints?: Record<string, { residual: number; render: import('../types/cad').ConstraintRender; superfluous: boolean }> }>

        const results: Record<string, SketchData> = {}
        for (const [id, feature] of Object.entries(result)) {
          const featureDef = (d.features ?? []).find(f => f.id === id)
          if (feature.geometry) {
            if (featureDef) {
              featureDef.initial = feature.geometry
              if (feature.constraints && featureDef.constraints) {
                const superfluousIds = new Set(
                  Object.entries(feature.constraints)
                    .filter(([, c]) => c.superfluous)
                    .map(([cid]) => cid)
                )
                if (superfluousIds.size > 0) {
                  featureDef.constraints = featureDef.constraints.filter(c => !superfluousIds.has(c.id))
                }
              }
            }
            const solved = unflattenGeometry(feature.geometry, featureDef?.entities)
            const astPosById = new Map(
              (featureDef?.constraints ?? [])
                .filter(c => c.pos)
                .map(c => [c.id, c.pos!])
            )
            const constraints: import('../types/cad').Constraints | undefined = feature.constraints
              ? Object.fromEntries(
                  Object.entries(feature.constraints)
                    .filter(([, c]) => !c.superfluous)
                    .map(([cid, c]) => {
                      const pos = astPosById.get(cid)
                      const render = pos ? { ...c.render, pos } : c.render
                      return [cid, { render, residual: c.residual }]
                    })
                )
              : undefined
            results[id] = {
              solved,
              topology: feature.topology,
              status: feature.status,
              ...(constraints && { constraints }),
            }
          } else {
            // exception: no geometry returned — fall back to initial positions, flag status
            results[id] = {
              solved: unflattenGeometry(featureDef?.initial, featureDef?.entities),
              status: feature.status ?? 'exception',
            }
          }
        }
        setSolveResults(prev => ({ ...prev, ...results }))
        setSolveRawResult(stringifyYaml(data.result))
        setDoc(d)
        docRef.current = d
        if (mode === 'code') {
          setCodeText(stringifyYaml(d))
        }
        setSolveError(null)
      }
    } catch (e) {
      setSolveError(String(e))
      setSolveRawResult(String(e))
    } finally {
      setSolving(false)
    }
  }, [mode, setCodeText])

  const handleMutation = useCallback((m: Mutation) => {
    setSolveError(null)
    const current = docRef.current
    if (!current) return

    setSolveResults(prev => {
      const next = { ...prev }
      if ('featureId' in m) {
        delete next[m.featureId]
      } else if (m.type === 'delete') {
        return {}
      }
      return next
    })

    const next: PartDoc = JSON.parse(JSON.stringify(current))
    setUndoStack(prev => [...prev, current])
    setRedoStack([])
    switch (m.type) {
      case 'move_vertex':
        applyMoveVertex(next, m.featureId, m.entityId, m.vertexKey, m.to)
        break
      case 'move_entity':
        applyMoveEntity(next, m.featureId, m.entityId, m.delta)
        break
      case 'add_constraint':
        applyAddConstraint(next, m.featureId, m.kind, m.targets, m.value)
        break
      case 'set_constraint_value':
        applySetConstraintValue(next, m.featureId, m.constraintId, m.value)
        break
      case 'set_constraint_pos':
        applySetConstraintPos(next, m.featureId, m.constraintId, m.pos)
        break
      case 'delete':
        applyDeleteElements(next, m.targets)
        break
      case 'add_entity':
        applyAddEntity(next, m.featureId, m.kind, m.params)
        break
      case 'add_rect':
        applyAddRect(next, m.featureId, m.p0, m.p1)
        break
      case 'toggle_construction':
        applyToggleConstruction(next, m.targets)
        break
    }
    docRef.current = next
    setDoc(next)
    reSolve(next)
  }, [reSolve])

  const handleUndo = useCallback(() => {
    setUndoStack(prev => {
      if (prev.length === 0) return prev
      const next = [...prev]
      const last = next.pop()!
      if (docRef.current) setRedoStack(r => [...r, docRef.current!])
      docRef.current = last
      setDoc(last)
      reSolve(last)
      return next
    })
  }, [reSolve])

  const handleRedo = useCallback(() => {
    setRedoStack(prev => {
      if (prev.length === 0) return prev
      const next = [...prev]
      const last = next.pop()!
      if (docRef.current) setUndoStack(u => [...u, docRef.current!])
      docRef.current = last
      setDoc(last)
      reSolve(last)
      return next
    })
  }, [reSolve])

  useEffect(() => {
    if (!uuid) return
    setLoading(true)
    fetch(`/api/documents/${uuid}`)
      .then(r => {
        if (!r.ok) throw new Error('Failed to load document')
        return r.json()
      })
      .then(data => {
        const parsed = healDoc(parseYaml(data.content))
        docRef.current = parsed
        setDoc(parsed)
        setDocName(data.name)
        setLoading(false)
      })
      .catch(e => {
        setError(String(e))
        setLoading(false)
      })
  }, [uuid])

  const saveDoc = useCallback(async (uuid: string, document: PartDoc) => {
    try {
      const response = await fetch(`/api/documents/${uuid}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: stringifyYaml(document) }),
      })
      if (!response.ok) throw new Error('Failed to save document')
      return true
    } catch (e) {
      setError(String(e))
      return false
    }
  }, [])

  const renameDoc = useCallback(async (uuid: string, name: string) => {
    try {
      const response = await fetch(`/api/documents/${uuid}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      if (!response.ok) throw new Error('Failed to rename document')
      setDocName(name)
      return true
    } catch (e) {
      setError(String(e))
      return false
    }
  }, [])

  return {
    doc,
    setDoc,
    docRef,
    docName,
    setDocName,
    loading,
    error,
    setError,
    solveResults,
    setSolveResults,
    solving,
    solveTime,
    solveError,
    setSolveError,
    solveResult,
    setSolveRawResult,
    undoStack,
    redoStack,
    reSolve,
    handleMutation,
    handleUndo,
    handleRedo,
    saveDoc,
    renameDoc,
  }
}
