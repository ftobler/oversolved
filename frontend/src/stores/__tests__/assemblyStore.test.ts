import { describe, it, expect, beforeEach } from 'vitest'
import { useAssemblyStore, DEFAULT_ASSEMBLY_EDITOR_DATA } from '@/stores/assemblyStore'

describe('assemblyStore', () => {
  beforeEach(() => {
    useAssemblyStore.getState().setSnapshot(DEFAULT_ASSEMBLY_EDITOR_DATA)
    useAssemblyStore.getState().setActivePartHandle(null)
    useAssemblyStore.getState().setIsSolving(false)
    useAssemblyStore.getState().setSolveError(null)
    // selection/hoveredEntity/showPickDebug are store-owned, so setSnapshot does
    // not reset them; clear explicitly to keep the selection tests isolated.
    useAssemblyStore.getState().clearSelection()
    useAssemblyStore.getState().setHoveredEntity(null)
    useAssemblyStore.getState().setShowPickDebug(false)
  })

  it('default state has empty fields and null doc', () => {
    const state = useAssemblyStore.getState()
    expect(state.doc).toBeNull()
    expect(state.instances).toEqual([])
    expect(state.mates).toEqual([])
    expect(state.transforms).toEqual({})
    expect(state.activePartHandle).toBeNull()
    expect(state.isSolving).toBe(false)
    expect(state.solveError).toBeNull()
  })

  it('setSnapshot replaces mirrored fields but preserves owned fields', () => {
    const { getState } = useAssemblyStore
    getState().setActivePartHandle('part-1')
    getState().setIsSolving(true)
    getState().setSnapshot({
      ...DEFAULT_ASSEMBLY_EDITOR_DATA,
      doc: { kind: 'assembly', features: [] },
      activePartHandle: null,
    })
    // activePartHandle is a store-owned field, preserved from setter.
    expect(getState().activePartHandle).toBe('part-1')
    expect(getState().doc).toEqual({ kind: 'assembly', features: [] })
  })

  it('setActivePartHandle updates the handle and syncs via setSnapshot is preserved', () => {
    const { getState } = useAssemblyStore
    getState().setActivePartHandle('abc')
    expect(getState().activePartHandle).toBe('abc')
    // setSnapshot should not overwrite
    getState().setSnapshot({
      ...DEFAULT_ASSEMBLY_EDITOR_DATA,
      activePartHandle: 'ignored',
    })
    expect(getState().activePartHandle).toBe('abc')
  })

  it('setIsSolving toggles the flag', () => {
    const { getState } = useAssemblyStore
    expect(getState().isSolving).toBe(false)
    getState().setIsSolving(true)
    expect(getState().isSolving).toBe(true)
    getState().setIsSolving(false)
    expect(getState().isSolving).toBe(false)
  })

  it('setSolveError sets and clears error', () => {
    const { getState } = useAssemblyStore
    expect(getState().solveError).toBeNull()
    getState().setSolveError('boom')
    expect(getState().solveError).toBe('boom')
    getState().setSolveError(null)
    expect(getState().solveError).toBeNull()
  })

  it('round-trips a full AssemblyDoc through setSnapshot', () => {
    const { getState } = useAssemblyStore
    const doc = {
      kind: 'assembly' as const,
      features: [
        { id: 'feat1', kind: 'part_instance' as const, instance: { handle: 'h1', doc_id: 'd1', doc_rev: 3, transform: { tx: 0, ty: 0, tz: 0, qx: 0, qy: 0, qz: 0, qw: 1 } } },
        { id: 'feat2', kind: 'mate' as const, mate: { kind: 'fixed' as const, ref_a: { part: 'h1', anchor: 'a1' }, ref_b: { part: 'h2', anchor: 'a2' } } },
      ],
    }
    getState().setSnapshot({
      ...DEFAULT_ASSEMBLY_EDITOR_DATA,
      doc,
      instances: [doc.features[0].instance!],
      mates: [{ id: doc.features[1].id, mate: doc.features[1].mate! }],
    })
    expect(getState().doc).toEqual(doc)
    expect(getState().instances).toHaveLength(1)
    expect(getState().instances[0].handle).toBe('h1')
    expect(getState().mates).toHaveLength(1)
    expect(getState().mates[0].id).toBe('feat2')
    expect(getState().mates[0].mate.kind).toBe('fixed')
  })

  it('reset via DEFAULT_ASSEMBLY_EDITOR_DATA clears mirrored fields', () => {
    const { getState } = useAssemblyStore
    getState().setSnapshot({
      ...DEFAULT_ASSEMBLY_EDITOR_DATA,
      doc: { kind: 'assembly', features: [] },
      instances: [{ handle: 'h1', doc_id: 'd1', doc_rev: 1, transform: { tx: 0, ty: 0, tz: 0, qx: 0, qy: 0, qz: 0, qw: 1 } }],
    })
    getState().setSnapshot(DEFAULT_ASSEMBLY_EDITOR_DATA)
    expect(getState().doc).toBeNull()
    expect(getState().instances).toEqual([])
  })

  describe('B-rep selection', () => {
    const EMPTY_SOLVE = {
      transforms: {}, bodies: {}, edgeCurves: {}, entityMateRefs: {},
      anchors: {}, pickGeometry: [], mateResults: {},
    }

    it('toggleSelection adds then removes an entity key', () => {
      const { getState } = useAssemblyStore
      getState().toggleSelection('P|0|face|2')
      expect([...getState().selection]).toEqual(['P|0|face|2'])
      getState().toggleSelection('P|0|face|2')
      expect(getState().selection.size).toBe(0)
    })

    it('accumulates multiple selected entities', () => {
      const { getState } = useAssemblyStore
      getState().toggleSelection('a')
      getState().toggleSelection('b')
      expect(getState().selection).toEqual(new Set(['a', 'b']))
    })

    it('clearSelection empties the set', () => {
      const { getState } = useAssemblyStore
      getState().toggleSelection('a')
      getState().clearSelection()
      expect(getState().selection.size).toBe(0)
    })

    it('setHoveredEntity is a no-op when the key is unchanged', () => {
      const { getState } = useAssemblyStore
      getState().setHoveredEntity('a')
      const first = getState().selection  // any stable ref to detect a re-set
      getState().setHoveredEntity('a')
      expect(getState().hoveredEntity).toBe('a')
      expect(getState().selection).toBe(first)
    })

    it('a re-solve clears selection and hover (positional keys renumber)', () => {
      const { getState } = useAssemblyStore
      getState().toggleSelection('P|0|face|2')
      getState().setHoveredEntity('P|0|edge|1')
      getState().setSolveResult(EMPTY_SOLVE)
      expect(getState().selection.size).toBe(0)
      expect(getState().hoveredEntity).toBeNull()
    })

    it('setShowPickDebug toggles the debug renderpass flag', () => {
      const { getState } = useAssemblyStore
      expect(getState().showPickDebug).toBe(false)
      getState().setShowPickDebug(true)
      expect(getState().showPickDebug).toBe(true)
    })
  })
})
