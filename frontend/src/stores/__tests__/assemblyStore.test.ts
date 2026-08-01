import { describe, it, expect, beforeEach } from 'vitest'
import type { AssemblyDoc, PartInstance, Transform3D } from '@/types/cad'
import { useAssemblyStore, DEFAULT_ASSEMBLY_EDITOR_DATA, sameInstances } from '@/stores/assemblyStore'
import { partInstances, setBuiltinVisible } from '@/utils/assemblyMutations'
import { ASSEMBLY_TOP_ID } from '@/utils/assemblyBuiltins'

describe('assemblyStore', () => {
  beforeEach(() => {
    useAssemblyStore.getState().setSnapshot(DEFAULT_ASSEMBLY_EDITOR_DATA)
    useAssemblyStore.getState().setSelectedPartHandle(null)
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
    expect(state.selectedPartHandle).toBeNull()
    expect(state.isSolving).toBe(false)
    expect(state.solveError).toBeNull()
  })

  // `selectedPartHandle` stands in for the whole STORE_OWNED_FIELDS mechanic
  // here: the page rebuilds the snapshot from the document on every doc change,
  // and a field the store owns must survive that. The specimen used to be
  // `activePartHandle`, which was deleted as vestigial; picking another owned
  // field keeps the mechanic covered rather than losing it with the field.
  it('setSnapshot replaces mirrored fields but preserves owned fields', () => {
    const { getState } = useAssemblyStore
    getState().setSelectedPartHandle('part-1')
    getState().setIsSolving(true)
    getState().setSnapshot({
      ...DEFAULT_ASSEMBLY_EDITOR_DATA,
      doc: { kind: 'assembly', features: [] },
      selectedPartHandle: null,
    })
    // selectedPartHandle is a store-owned field, preserved from setter.
    expect(getState().selectedPartHandle).toBe('part-1')
    expect(getState().doc).toEqual({ kind: 'assembly', features: [] })
  })

  it('setSelectedPartHandle survives a snapshot that names a different handle', () => {
    const { getState } = useAssemblyStore
    getState().setSelectedPartHandle('abc')
    expect(getState().selectedPartHandle).toBe('abc')
    // setSnapshot should not overwrite
    getState().setSnapshot({
      ...DEFAULT_ASSEMBLY_EDITOR_DATA,
      selectedPartHandle: 'ignored',
    })
    expect(getState().selectedPartHandle).toBe('abc')
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

  // Identity, not content, is what this section is about. The page rebuilds the
  // whole snapshot from the document on every doc change, so `instances` arrives
  // as a fresh array whether or not a part moved. Downstream, the viewport's
  // `groups` memo is keyed on that array, and re-running it mints a new render
  // item for every body of every part -- for an edit that touched no part at all.
  describe('instances identity across snapshots', () => {
    const INSTANCE: PartInstance = {
      handle: 'h1', doc_id: 'd1', doc_rev: 1,
      transform: { tx: 1, ty: 2, tz: 3, qx: 0, qy: 0, qz: 0, qw: 1 },
    }
    const snapshotWith = (instances: PartInstance[], doc: AssemblyDoc | null = null) => ({
      ...DEFAULT_ASSEMBLY_EDITOR_DATA, doc, instances,
    })

    it('keeps the held array when a rebuilt snapshot describes the same parts', () => {
      const { getState } = useAssemblyStore
      getState().setSnapshot(snapshotWith([INSTANCE]))
      const held = getState().instances

      // Deep-equal but freshly constructed, down to the transform object: this
      // is what a doc edit elsewhere in the document produces.
      getState().setSnapshot(snapshotWith([{ ...INSTANCE, transform: { ...INSTANCE.transform } }]))

      expect(getState().instances).toBe(held)
    })

    it('takes the new array as soon as any part actually differs', () => {
      const { getState } = useAssemblyStore
      getState().setSnapshot(snapshotWith([INSTANCE]))
      const held = getState().instances

      getState().setSnapshot(snapshotWith([{ ...INSTANCE, handle: 'h2' }]))
      expect(getState().instances).not.toBe(held)
      expect(getState().instances[0].handle).toBe('h2')

      // ...and for a pose change, which is the one a shallow handle compare
      // would miss.
      const moved = getState().instances
      getState().setSnapshot(snapshotWith([
        { ...INSTANCE, handle: 'h2', transform: { ...INSTANCE.transform, tx: 99 } },
      ]))
      expect(getState().instances).not.toBe(moved)
    })

    it('adding or removing a part is never mistaken for no change', () => {
      const { getState } = useAssemblyStore
      getState().setSnapshot(snapshotWith([INSTANCE]))
      const held = getState().instances
      getState().setSnapshot(snapshotWith([INSTANCE, { ...INSTANCE, handle: 'h2' }]))
      expect(getState().instances).not.toBe(held)
    })

    // The regression the whole mechanism exists for, driven through the real
    // mutation rather than through React: showing a built-in plane rewrites the
    // doc and therefore the snapshot, but it moves no part.
    it('a builtin visibility flip does not disturb the instances reference', () => {
      const { getState } = useAssemblyStore
      const doc: AssemblyDoc = {
        kind: 'assembly',
        features: [
          { id: ASSEMBLY_TOP_ID, kind: 'plane' },
          { id: 'f1', kind: 'part_instance', instance: INSTANCE },
        ],
      }
      getState().setSnapshot(snapshotWith(partInstances(doc), doc))
      const held = getState().instances

      const flipped = setBuiltinVisible(doc, ASSEMBLY_TOP_ID, true)
      expect(flipped).not.toBe(doc)  // the doc really did change
      getState().setSnapshot(snapshotWith(partInstances(flipped), flipped))

      expect(getState().doc).toBe(flipped)
      expect(getState().instances).toBe(held)
    })
  })

  // `sameInstances` decides whether the whole render tree keeps its identities,
  // and it does that by naming PartInstance's fields one at a time. A field
  // added to the type later would compile clean and simply go uncompared, which
  // shows up as a part drawn at a stale value with no error anywhere -- the
  // quietest possible failure. The two tables below are the compile-time link
  // that stops it: both are keyed on `keyof Required<...>`, so a new field fails
  // to typecheck until it has an entry here, and the loop then fails until
  // `sameInstances` actually looks at it.
  describe('sameInstances field coverage', () => {
    const FULL: Required<PartInstance> = {
      handle: 'h1', doc_id: 'd1', doc_rev: 1, visible: true, fixed: true,
      transform: { tx: 1, ty: 2, tz: 3, qx: 0.1, qy: 0.2, qz: 0.3, qw: 0.9 },
    }
    const withPose = (patch: Partial<Transform3D>): PartInstance => (
      { ...FULL, transform: { ...FULL.transform, ...patch } }
    )

    const DIFFERS_BY: Record<keyof Required<PartInstance>, PartInstance> = {
      handle: { ...FULL, handle: 'h2' },
      doc_id: { ...FULL, doc_id: 'd2' },
      doc_rev: { ...FULL, doc_rev: 2 },
      visible: { ...FULL, visible: false },
      fixed: { ...FULL, fixed: false },
      transform: withPose({ tx: 99 }),
    }

    const POSE_DIFFERS_BY: Record<keyof Transform3D, PartInstance> = {
      tx: withPose({ tx: 99 }), ty: withPose({ ty: 99 }), tz: withPose({ tz: 99 }),
      qx: withPose({ qx: 0.9 }), qy: withPose({ qy: 0.9 }),
      qz: withPose({ qz: 0.9 }), qw: withPose({ qw: 0.1 }),
    }

    it('reports a difference in any field of PartInstance', () => {
      for (const [field, changed] of Object.entries(DIFFERS_BY)) {
        expect(sameInstances([FULL], [changed]), `${field} is not compared`).toBe(false)
      }
    })

    it('reports a difference in any component of the pose', () => {
      for (const [component, changed] of Object.entries(POSE_DIFFERS_BY)) {
        expect(sameInstances([FULL], [changed]), `transform.${component} is not compared`).toBe(false)
      }
    })

    // The other half: an absent optional field and an explicit `false` are not
    // the same document, so they must not compare equal. Erring this way only
    // ever costs a redundant re-render; erring the other way draws stale parts.
    it('does not conflate an absent optional field with a false one', () => {
      const { visible: _visible, ...withoutVisible } = FULL
      expect(sameInstances([FULL], [{ ...withoutVisible, visible: false }])).toBe(false)
      expect(sameInstances([withoutVisible], [{ ...withoutVisible }])).toBe(true)
    })
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
